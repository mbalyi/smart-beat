//! Import from Audio: a recording becomes MIDI on this computer (docs/audio-to-midi.md). The file
//! is decoded here, resampled to 16 kHz mono and handed to MuScriptor (`recording/muscriptor.rs`),
//! the downloaded model. Nothing is uploaded: the audio never leaves the computer. Cancel stops
//! the model between two steps.
use crate::audio::backing;
use crate::error::{CommandError, ErrorKind};
use crate::recording::muscriptor::{self, Stage};
use crate::recording::muscriptor_ffi::Note as ModelNote;
use crate::recording::muscriptor_model::{self, Size};
use crate::recording::resample;
use base64::Engine;
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use symphonia::core::errors::Error as DemuxError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Runtime, State};

const MAX_BYTES: usize = 100 * 1024 * 1024;
/// Longest recording. A long one takes minutes, and the model keeps the CPU or GPU busy.
const MAX_DURATION_MS: u32 = 15 * 60 * 1000;
/// What the app decodes (symphonia).
const EXTENSIONS: [&str; 4] = ["mp3", "wav", "flac", "ogg"];
const INSTRUMENTS: &str = include_str!("../../src/lib/audio-transcription/instrument-ids.json");
/// How long a Cancel that arrived before its transcription started is kept.
const EARLY_CANCEL: Duration = Duration::from_secs(60);
const STOPPED: &str = "Transcription stopped.";

fn error(message: impl Into<String>) -> CommandError {
    CommandError::new(ErrorKind::Audio, message)
}

fn validate(bytes: &[u8], extension: &str) -> Result<(), CommandError> {
    if bytes.is_empty() {
        return Err(error("The audio file is empty."));
    }
    if bytes.len() > MAX_BYTES {
        return Err(error("The audio file exceeds the 100 MiB limit."));
    }
    if !EXTENSIONS.contains(&extension) {
        return Err(error("Choose MP3, WAV, FLAC or OGG audio."));
    }
    Ok(())
}
fn check_duration(duration_ms: u32) -> Result<(), CommandError> {
    if duration_ms > MAX_DURATION_MS {
        return Err(error("Choose a recording up to 15 minutes long."));
    }
    Ok(())
}
/// The recording's length in milliseconds. Rust reads it itself, so a wrong length from the
/// page cannot pass the limit. Uses the container's frame count when it has one, else adds
/// up the packets without decoding them.
fn duration_ms(bytes: Vec<u8>, extension: &str) -> Result<u32, CommandError> {
    let unreadable = || error("Could not read this recording. Re-export it as WAV or MP3.");
    let mut hint = Hint::new();
    hint.with_extension(extension);
    let stream = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            stream,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|_| unreadable())?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(unreadable)?;
    let (id, time_base, length) = (track.id, track.time_base, track.duration);
    let rate = track
        .codec_params
        .as_ref()
        .and_then(|params| params.audio())
        .and_then(|audio| audio.sample_rate)
        .filter(|&rate| rate > 0);
    let seconds = match (track.num_frames, rate, length) {
        (Some(frames), Some(rate), _) => frames as f64 / f64::from(rate),
        (_, _, Some(length)) => time_base
            .ok_or_else(unreadable)?
            .calc_duration_saturating(length)
            .as_secs_f64(),
        _ => {
            let time_base = time_base.ok_or_else(unreadable)?;
            let mut ticks = 0u64;
            loop {
                match format.next_packet() {
                    Ok(Some(packet)) if packet.track_id == id => {
                        ticks = ticks.saturating_add(packet.dur.get());
                    }
                    Ok(Some(_)) => {}
                    Ok(None) | Err(DemuxError::IoError(_)) => break,
                    Err(_) => return Err(unreadable()),
                }
            }
            time_base
                .calc_duration_saturating(symphonia::core::units::Duration::new(ticks))
                .as_secs_f64()
        }
    };
    if !seconds.is_finite() || seconds <= 0.0 {
        return Err(unreadable());
    }
    Ok((seconds * 1000.0).round().min(f64::from(u32::MAX)) as u32)
}
/// The comma-separated instrument ids the user expects, all from the supported list.
fn instruments(header: &str) -> Result<Vec<String>, CommandError> {
    let allowed: Vec<String> = serde_json::from_str(INSTRUMENTS).expect("instrument list");
    let chosen: Vec<String> = header
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect();
    if chosen.len() > allowed.len() || chosen.iter().any(|id| !allowed.contains(id)) {
        return Err(error(
            "Choose instruments from the supported instrument list.",
        ));
    }
    Ok(chosen)
}

/// The files of the last drop on the window (lib.rs records them). `read_transcription_audio`
/// reads only these, so the page cannot choose a file on disk to send to the server.
#[derive(Default)]
pub struct Dropped(Mutex<HashSet<PathBuf>>);
impl Dropped {
    pub fn record(&self, paths: &[PathBuf]) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = paths.iter().cloned().collect();
    }
    /// True once for each dropped file.
    fn take(&self, path: &Path) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(path)
    }
}
#[tauri::command(async)]
pub fn read_transcription_audio(
    dropped: State<'_, Dropped>,
    path: String,
) -> Result<tauri::ipc::Response, CommandError> {
    read_dropped(&dropped, Path::new(&path)).map(tauri::ipc::Response::new)
}
fn read_dropped(dropped: &Dropped, path: &Path) -> Result<Vec<u8>, CommandError> {
    let extension = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !EXTENSIONS.contains(&extension.as_str()) {
        return Err(error("Choose MP3, WAV, FLAC or OGG audio."));
    }
    if !dropped.take(path) {
        return Err(error("Drop the recording on the window again."));
    }
    let file = fs::File::open(path).map_err(|_| error("Could not open the dropped recording."))?;
    let meta = file
        .metadata()
        .map_err(|_| error("Could not read the recording size."))?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_BYTES as u64 {
        return Err(error("Choose a non-empty audio file smaller than 100 MiB."));
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("Could not read the recording."))?;
    if bytes.len() > MAX_BYTES {
        return Err(error("The audio file exceeds the 100 MiB limit."));
    }
    Ok(bytes)
}

/// Stops one running transcription.
type Abort = Box<dyn Fn() + Send>;
enum Slot {
    Running(Abort),
    /// A Cancel that arrived before its transcription started.
    Cancelled(Instant),
}
/// Transcriptions in flight by operation id, so Cancel can stop one.
#[derive(Default)]
pub struct Running(Mutex<HashMap<String, Slot>>);
impl Running {
    /// The slots, without early Cancels older than `EARLY_CANCEL`. A Cancel for a
    /// transcription that already finished leaves such a slot, and nothing else removes it.
    fn slots(&self, now: Instant) -> MutexGuard<'_, HashMap<String, Slot>> {
        let mut slots = self.0.lock().unwrap_or_else(|e| e.into_inner());
        slots.retain(|_, slot| match slot {
            Slot::Cancelled(at) => now.duration_since(*at) <= EARLY_CANCEL,
            Slot::Running(_) => true,
        });
        slots
    }
    /// Registers how to stop an operation. False when it was cancelled already.
    fn start(&self, id: &str, abort: Abort) -> bool {
        let mut slots = self.slots(Instant::now());
        if matches!(slots.remove(id), Some(Slot::Cancelled(_))) {
            return false;
        }
        slots.insert(id.to_owned(), Slot::Running(abort));
        true
    }
    fn finish(&self, id: &str) {
        self.slots(Instant::now()).remove(id);
    }
    fn cancel(&self, id: &str) {
        let now = Instant::now();
        let mut slots = self.slots(now);
        match slots.remove(id) {
            Some(Slot::Running(abort)) => abort(),
            _ => {
                slots.insert(id.to_owned(), Slot::Cancelled(now));
            }
        }
    }
}
#[tauri::command]
pub fn cancel_transcription(running: State<'_, Running>, operation_id: String) {
    running.cancel(&operation_id);
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    operation_id: &'a str,
    phase: &'a str,
    message: &'a str,
    percent: Option<u8>,
}
/// A note for the page's preview.
#[derive(Debug, Serialize)]
pub struct Note {
    pub pitch: f64,
    pub start: f64,
    pub end: f64,
    pub instrument: Option<String>,
    pub velocity: Option<f64>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcription {
    midi_base64: String,
    notes: Vec<Note>,
    duration_seconds: f64,
}

/// The recording is the raw body. Headers carry the rest: `operation-id`, `file-type` (the
/// extension), `instruments` and `model-size` (`small`, `medium` or `large`). Emits
/// `transcription-progress`.
#[tauri::command]
pub async fn transcribe_audio<R: Runtime>(
    app: AppHandle<R>,
    running: State<'_, Running>,
    request: Request<'_>,
) -> Result<Transcription, CommandError> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err(error("The recording is missing."));
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| error(format!("Missing {name}.")))
    };
    let operation = header("operation-id")?.to_owned();
    let extension = header("file-type")?.to_lowercase();
    let instruments = instruments(header("instruments").unwrap_or(""))?;
    let size = Size::parse(header("model-size").unwrap_or("medium"))
        .ok_or_else(|| error("Choose small, medium or large."))?;
    validate(body, &extension)?;
    let folder = muscriptor_model::dir(&app)?;
    muscriptor_model::require_terms(&folder)?;
    let bytes = body.to_vec();
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    if !running.start(
        &operation,
        Box::new(move || flag.store(true, Ordering::Relaxed)),
    ) {
        return Err(error(STOPPED));
    }
    let id = operation.clone();
    let emit = move |message: &str, percent: Option<u8>| {
        let _ = app.emit(
            "transcription-progress",
            Progress {
                operation_id: &id,
                phase: "processing",
                message,
                percent,
            },
        );
    };
    let worker = {
        let stop = stop.clone();
        tauri::async_runtime::spawn_blocking(move || {
            transcribe(&folder, size, bytes, &extension, &instruments, &emit, &stop)
        })
    };
    let result = worker.await;
    running.finish(&operation);
    result.unwrap_or_else(|_| Err(error("Could not transcribe the recording.")))
}

fn transcribe(
    folder: &Path,
    size: Size,
    bytes: Vec<u8>,
    extension: &str,
    instruments: &[String],
    emit: &dyn Fn(&str, Option<u8>),
    stop: &AtomicBool,
) -> Result<Transcription, CommandError> {
    let cancelled = || stop.load(Ordering::Relaxed);
    muscriptor_model::require_terms(folder)?;
    emit("Reading the recording", None);
    check_duration(duration_ms(bytes.clone(), extension)?)?;
    let audio = backing::decode(bytes, Some(extension)).map_err(error)?;
    let mono: Vec<f32> = audio
        .left
        .iter()
        .zip(&audio.right)
        .map(|(l, r)| (l + r) * 0.5)
        .collect();
    let samples = resample(&mono, audio.rate, muscriptor::SAMPLE_RATE);
    let ids: Vec<String> = serde_json::from_str(INSTRUMENTS).expect("instrument list");
    let groups: Vec<i32> = instruments
        .iter()
        .filter_map(|id| ids.iter().position(|known| known == id))
        .map(muscriptor::group_of)
        .collect();
    let mut last = 0u8;
    let notes = muscriptor::run(
        folder,
        size,
        &samples,
        &groups,
        &mut |stage, fraction| match stage {
            Stage::Loading => emit("Loading the model", None),
            Stage::Transcribing => {
                let percent = (fraction * 100.0).clamp(0.0, 100.0) as u8;
                if percent != last {
                    last = percent;
                    emit("Transcribing", Some(percent));
                }
            }
        },
        &cancelled,
    )?;
    Ok(Transcription {
        midi_base64: base64::engine::general_purpose::STANDARD.encode(midi_file(&notes)),
        notes: preview_notes(&notes),
        duration_seconds: samples.len() as f64 / f64::from(muscriptor::SAMPLE_RATE),
    })
}

/// The `instrument-ids.json` id that fits a General MIDI program.
fn instrument_id(note: &ModelNote) -> &'static str {
    if note.is_drum {
        return "drums";
    }
    match note.program {
        0..=3 => "acoustic_piano",
        4..=7 => "electric_piano",
        8..=15 => "chromatic_percussion",
        16..=23 => "organ",
        24..=25 => "acoustic_guitar",
        26..=28 => "clean_electric_guitar",
        29..=31 => "distorted_electric_guitar",
        32 => "acoustic_bass",
        33..=39 => "electric_bass",
        40 => "violin",
        41 => "viola",
        42 => "cello",
        43 => "contrabass",
        44..=45 | 48..=49 => "string_ensemble",
        46 => "orchestral_harp",
        47 => "timpani",
        50..=51 => "synth_strings",
        52..=54 => "voice",
        55 => "orchestra_hit",
        56 | 59 => "trumpet",
        57 => "trombone",
        58 => "tuba",
        60 => "french_horn",
        61..=63 => "brass_section",
        64..=65 => "soprano_and_alto_sax",
        66 => "tenor_sax",
        67 => "baritone_sax",
        68 => "oboe",
        69 => "english_horn",
        70 => "bassoon",
        71 => "clarinet",
        72..=79 => "flutes",
        80..=87 => "synth_lead",
        88..=95 => "synth_pad",
        _ => "other",
    }
}

fn preview_notes(notes: &[ModelNote]) -> Vec<Note> {
    notes
        .iter()
        .map(|n| Note {
            pitch: f64::from(n.pitch),
            start: n.onset,
            end: n.offset.max(n.onset),
            instrument: Some(instrument_id(n).to_owned()),
            velocity: None,
        })
        .collect()
}

/// A Standard MIDI file (format 1) of the notes: one track per decoded program, drums on
/// channel 10. The tempo is a fixed 120 beats per minute, so the notes keep their real time
/// (960 ticks per second); the page's import path lays them on a grid.
fn midi_file(notes: &[ModelNote]) -> Vec<u8> {
    const TICKS_PER_SECOND: f64 = 960.0;
    const VELOCITY: u8 = 90;
    let mut tracks: BTreeMap<(bool, u8), Vec<&ModelNote>> = BTreeMap::new();
    for note in notes {
        let program = if note.is_drum {
            0
        } else {
            note.program.min(127)
        };
        tracks
            .entry((note.is_drum, program))
            .or_default()
            .push(note);
    }
    let mut out = Vec::new();
    out.extend_from_slice(b"MThd");
    out.extend_from_slice(&6u32.to_be_bytes());
    out.extend_from_slice(&1u16.to_be_bytes());
    out.extend_from_slice(&(tracks.len() as u16 + 1).to_be_bytes());
    out.extend_from_slice(&480u16.to_be_bytes());
    // Tempo track: 120 bpm.
    push_track(&mut out, &[(0, vec![0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20])]);
    let mut channel = 0u8;
    for ((is_drum, program), list) in tracks {
        let ch = if is_drum {
            9
        } else {
            if channel == 9 {
                channel += 1;
            }
            let ch = channel % 16;
            channel += 1;
            ch
        };
        // (tick, order, event): note-offs sort before note-ons at the same tick.
        let mut events: Vec<(u64, u8, Vec<u8>)> = Vec::new();
        if !is_drum {
            events.push((0, 0, vec![0xC0 | ch, program]));
        }
        for note in list {
            let on = (note.onset.max(0.0) * TICKS_PER_SECOND).round() as u64;
            let off = ((note.offset.max(note.onset) * TICKS_PER_SECOND).round() as u64).max(on + 1);
            events.push((on, 2, vec![0x90 | ch, note.pitch.min(127), VELOCITY]));
            events.push((off, 1, vec![0x80 | ch, note.pitch.min(127), 0]));
        }
        events.sort_by_key(|(tick, order, _)| (*tick, *order));
        let events: Vec<(u64, Vec<u8>)> = events.into_iter().map(|(t, _, e)| (t, e)).collect();
        push_track(&mut out, &events);
    }
    out
}

/// Writes one `MTrk` chunk from events at absolute ticks.
fn push_track(out: &mut Vec<u8>, events: &[(u64, Vec<u8>)]) {
    let mut body = Vec::new();
    let mut now = 0u64;
    for (tick, event) in events {
        push_variable(&mut body, tick.saturating_sub(now));
        now = *tick.max(&now);
        body.extend_from_slice(event);
    }
    body.extend_from_slice(&[0, 0xFF, 0x2F, 0]);
    out.extend_from_slice(b"MTrk");
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
}
fn push_variable(out: &mut Vec<u8>, mut value: u64) {
    let mut bytes = vec![(value & 0x7F) as u8];
    value >>= 7;
    while value > 0 {
        bytes.push((value & 0x7F) as u8 | 0x80);
        value >>= 7;
    }
    bytes.reverse();
    out.extend_from_slice(&bytes);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A mono 16-bit WAV file of silence.
    fn wav(rate: u32, seconds: u32) -> Vec<u8> {
        let data = rate * seconds * 2;
        let mut file = Vec::new();
        file.extend_from_slice(b"RIFF");
        file.extend_from_slice(&(36 + data).to_le_bytes());
        file.extend_from_slice(b"WAVEfmt ");
        file.extend_from_slice(&16u32.to_le_bytes());
        file.extend_from_slice(&1u16.to_le_bytes()); // PCM
        file.extend_from_slice(&1u16.to_le_bytes()); // mono
        file.extend_from_slice(&rate.to_le_bytes());
        file.extend_from_slice(&(rate * 2).to_le_bytes());
        file.extend_from_slice(&2u16.to_le_bytes());
        file.extend_from_slice(&16u16.to_le_bytes());
        file.extend_from_slice(b"data");
        file.extend_from_slice(&data.to_le_bytes());
        file.resize(file.len() + data as usize, 0);
        file
    }
    #[test]
    fn validates_recordings_and_instruments() {
        assert!(validate(b"a", "mp3").is_ok());
        assert!(validate(b"", "mp3").is_err());
        assert!(
            validate(b"a", "m4a").is_err(),
            "only these formats are decoded"
        );
        assert!(check_duration(MAX_DURATION_MS).is_ok());
        assert!(check_duration(MAX_DURATION_MS + 1).is_err());
        assert_eq!(
            instruments(" electric_bass,drums ").unwrap(),
            ["electric_bass", "drums"]
        );
        assert!(instruments("").unwrap().is_empty());
        assert!(instruments("guitar").is_err());
    }
    #[test]
    fn measures_the_recording_itself() {
        assert_eq!(duration_ms(wav(8000, 2), "wav").unwrap(), 2000);
        let manifest = env!("CARGO_MANIFEST_DIR");
        let mp3 = fs::read(format!("{manifest}/../e2e/fixtures/backing-a440.mp3")).unwrap();
        let ms = duration_ms(mp3, "mp3").unwrap();
        assert!((1900..=2100).contains(&ms), "{ms}");
        assert!(duration_ms(b"not audio".to_vec(), "wav").is_err());
    }
    #[test]
    fn reads_only_the_files_the_user_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let song = dir.path().join("song.wav");
        fs::write(&song, wav(8000, 1)).unwrap();
        let dropped = Dropped::default();
        assert!(read_dropped(&dropped, &song).is_err(), "never dropped");
        dropped.record(std::slice::from_ref(&song));
        assert_eq!(read_dropped(&dropped, &song).unwrap().len(), 44 + 16000);
        assert!(read_dropped(&dropped, &song).is_err(), "read once per drop");
    }
    fn model_note(onset: f64, offset: f64, pitch: u8, program: u8, is_drum: bool) -> ModelNote {
        ModelNote {
            onset,
            offset,
            pitch,
            program,
            is_drum,
        }
    }
    #[test]
    fn names_the_instrument_of_a_program() {
        let name = |program, is_drum| instrument_id(&model_note(0.0, 1.0, 60, program, is_drum));
        assert_eq!(name(0, false), "acoustic_piano");
        assert_eq!(name(33, false), "electric_bass");
        assert_eq!(name(128, true), "drums");
        assert_eq!(name(120, false), "other");
    }
    #[test]
    fn writes_a_midi_file_with_a_track_per_program() {
        let notes = [
            model_note(0.0, 0.5, 60, 0, false),
            model_note(0.5, 1.0, 64, 0, false),
            model_note(0.0, 0.01, 38, 128, true),
            model_note(1.0, 2.0, 40, 33, false),
        ];
        let file = midi_file(&notes);
        assert_eq!(&file[..4], b"MThd");
        // Format 1: the tempo track, piano, bass and drums.
        assert_eq!(u16::from_be_bytes([file[8], file[9]]), 1);
        assert_eq!(u16::from_be_bytes([file[10], file[11]]), 4);
        assert_eq!(file.windows(4).filter(|w| w == b"MTrk").count(), 4);
        assert!(
            file.windows(3).any(|w| w == [0x99, 38, 90]),
            "drums on channel 10"
        );
        assert!(
            file.windows(2).any(|w| w == [0xC0, 0]),
            "piano on channel 1"
        );
        assert!(
            file.windows(2).any(|w| w == [0xC1, 33]),
            "bass on channel 2"
        );
        // 0.5 s is 480 ticks, the variable length 0x83 0x60.
        assert!(file.windows(2).any(|w| w == [0x83, 0x60]));
    }
    #[test]
    fn an_empty_result_is_still_a_valid_file() {
        let file = midi_file(&[]);
        assert_eq!(u16::from_be_bytes([file[10], file[11]]), 1);
    }
    #[test]
    fn variable_lengths_follow_the_midi_rules() {
        for (value, expected) in [
            (0u64, vec![0u8]),
            (127, vec![0x7F]),
            (128, vec![0x81, 0]),
            (16384, vec![0x81, 0x80, 0]),
        ] {
            let mut out = Vec::new();
            push_variable(&mut out, value);
            assert_eq!(out, expected);
        }
    }
    #[test]
    fn refuses_to_transcribe_before_the_terms_are_accepted() {
        let dir = tempfile::tempdir().unwrap();
        let stop = AtomicBool::new(false);
        let result = transcribe(
            dir.path(),
            Size::Small,
            wav(16000, 1),
            "wav",
            &[],
            &|_, _| {},
            &stop,
        );
        assert!(
            result
                .unwrap_err()
                .message
                .contains("Accept the MuScriptor terms")
        );
    }
    #[test]
    fn cancel_stops_a_running_transcription_or_one_not_started_yet() {
        let running = Running::default();
        let stopped = Arc::new(Mutex::new(false));
        let flag = stopped.clone();
        assert!(running.start("one", Box::new(move || *flag.lock().unwrap() = true)));
        running.cancel("one");
        assert!(*stopped.lock().unwrap());
        running.cancel("two");
        assert!(
            !running.start("two", Box::new(|| {})),
            "cancelled before it started"
        );
        assert!(running.start("three", Box::new(|| {})));
        running.finish("three");
        assert!(running.0.lock().unwrap().is_empty());
    }
    #[test]
    fn forgets_a_cancel_for_a_transcription_that_never_starts() {
        let running = Running::default();
        running.cancel("finished-already");
        assert_eq!(running.slots(Instant::now()).len(), 1);
        let later = Instant::now() + EARLY_CANCEL + Duration::from_secs(1);
        assert!(running.slots(later).is_empty());
    }
}
