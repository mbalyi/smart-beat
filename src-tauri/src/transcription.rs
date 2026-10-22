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
    /// Stops every running transcription. The app does this when it quits: the engine holds its
    /// model for the whole run, and unloading it on exit would wait for the end of the song.
    pub fn cancel_all(&self) {
        let slots = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for slot in slots.values() {
            if let Slot::Running(abort) = slot {
                abort();
            }
        }
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
    muscriptor_model::require_terms(&folder, size)?;
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
    muscriptor_model::require_terms(folder, size)?;
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

/// The MIDI program the model emits for each instrument group, by group id: the
/// `GROUP_REPRESENTATIVE` table of `native/muscriptor/src/instrument_groups.inc`. A group
/// is not a General MIDI family (group 1, the electric piano, is program 2), and the model
/// emits only the representative. A test reads the `.inc` file and fails if this drifts.
const GROUP_REPRESENTATIVE: [u8; 66] = [
    0, 2, 8, 16, 24, 26, 29, 32, 33, 40, 41, 42, 43, 46, 47, 48, 50, 52, 55, 56, 57, 58, 60, 61,
    64, 66, 67, 68, 69, 70, 71, 72, 80, 88, 100, 101, 96, 97, 98, 99, 102, 103, 104, 105, 106, 107,
    108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126,
    127,
];

/// The `instrument-ids.json` ids of the named groups 0 to 33, by group id. The groups after
/// them have no id of their own (drums are group 36, told apart by the drum flag).
const GROUP_IDS: [&str; 34] = [
    "acoustic_piano",
    "electric_piano",
    "chromatic_percussion",
    "organ",
    "acoustic_guitar",
    "clean_electric_guitar",
    "distorted_electric_guitar",
    "acoustic_bass",
    "electric_bass",
    "violin",
    "viola",
    "cello",
    "contrabass",
    "orchestral_harp",
    "timpani",
    "string_ensemble",
    "synth_strings",
    "voice",
    "orchestra_hit",
    "trumpet",
    "trombone",
    "tuba",
    "french_horn",
    "brass_section",
    "soprano_and_alto_sax",
    "tenor_sax",
    "baritone_sax",
    "oboe",
    "english_horn",
    "bassoon",
    "clarinet",
    "flutes",
    "synth_lead",
    "synth_pad",
];

/// The `instrument-ids.json` id of the instrument group the model put a note in, found by the
/// program it emits for that group. A program no group emits has no id: "other".
fn instrument_id(note: &ModelNote) -> &'static str {
    if note.is_drum {
        return "drums";
    }
    GROUP_REPRESENTATIVE
        .iter()
        .position(|&program| program == note.program)
        .and_then(|group| GROUP_IDS.get(group))
        .copied()
        .unwrap_or("other")
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
/// channel 10. Every melodic track has a channel of its own; past the 15 melodic channels of a
/// port the next tracks go to a further port (`melodic_slot`). The tempo is a fixed 120 beats per minute, so the notes keep their real time
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
    let mut melodic = 0usize;
    for ((is_drum, program), list) in tracks {
        let (port, ch) = if is_drum {
            (0, 9)
        } else {
            let slot = melodic_slot(melodic);
            melodic += 1;
            slot
        };
        // (tick, order, event): note-offs sort before note-ons at the same tick.
        let mut events: Vec<(u64, u8, Vec<u8>)> = Vec::new();
        // The first port is the default; a later one is named, so players with several ports
        // keep the programs on a channel number apart.
        if port > 0 {
            events.push((0, 0, vec![0xFF, 0x21, 0x01, port]));
        }
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

/// The MIDI port and channel of the `index`-th melodic track. A port has 16 channels and channel
/// 10 (index 9) belongs to the drums, so each port holds 15 melodic tracks; the next track
/// starts a new port instead of reusing a channel. A file has at most 128 melodic programs, so
/// the port number always fits in a byte.
fn melodic_slot(index: usize) -> (u8, u8) {
    const MELODIC_CHANNELS: usize = 15;
    let channel = (index % MELODIC_CHANNELS) as u8;
    (
        (index / MELODIC_CHANNELS) as u8,
        channel + u8::from(channel >= 9),
    )
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
        // Group 1 is the electric piano and the model emits program 2 for it.
        assert_eq!(name(2, false), "electric_piano");
        // A program no group emits has no id.
        assert_eq!(name(1, false), "other");
    }
    #[test]
    fn two_piano_groups_keep_two_labels() {
        let notes = [
            model_note(0.0, 1.0, 60, 0, false),
            model_note(0.0, 1.0, 64, 2, false),
        ];
        let labels: Vec<_> = preview_notes(&notes)
            .into_iter()
            .map(|n| n.instrument.unwrap())
            .collect();
        assert_eq!(labels, ["acoustic_piano", "electric_piano"]);
    }
    /// Reads the native group table, so a change to it fails here instead of mislabelling notes.
    #[test]
    fn the_group_tables_match_the_native_ones() {
        let inc = include_str!("../native/muscriptor/src/instrument_groups.inc");
        let block = |start: &str| {
            let from = inc.find(start).unwrap_or_else(|| panic!("{start} is gone"));
            let rest = &inc[from..];
            let open = rest.find("{{").unwrap() + 2;
            let close = rest.find("}}").unwrap();
            rest[open..close].to_owned()
        };
        let representatives: Vec<u8> = block("GROUP_REPRESENTATIVE")
            .split(|c: char| !c.is_ascii_digit())
            .filter(|s| !s.is_empty())
            .map(|s| s.parse().unwrap())
            .collect();
        assert_eq!(representatives, GROUP_REPRESENTATIVE);
        // NAMED_GROUPS entries are {"name", group id}: the named groups 0 to 33 are in id
        // order, then the drums (group 36).
        let named = block("NAMED_GROUPS");
        let named: Vec<(&str, usize)> = named
            .split('{')
            .filter_map(|entry| {
                let (name, id) = entry.split_once(',')?;
                Some((
                    name.trim().trim_matches('"'),
                    id.trim()
                        .trim_end_matches([',', '}', ' ', '\n'])
                        .parse()
                        .ok()?,
                ))
            })
            .collect();
        for (name, id) in named.iter().filter(|(_, id)| *id < GROUP_IDS.len()) {
            assert_eq!(GROUP_IDS[*id], *name, "group {id}");
        }
        assert_eq!(
            named.iter().filter(|(_, id)| *id < GROUP_IDS.len()).count(),
            GROUP_IDS.len()
        );
        assert!(named.contains(&("drums", 36)));
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
    /// Where each track of a file the writer made plays: (port, channel, drums). The writer
    /// uses explicit status bytes, so no running status is read.
    fn slots_of(file: &[u8]) -> Vec<(u8, u8, bool)> {
        fn variable(bytes: &[u8], at: &mut usize) -> usize {
            let mut value = 0usize;
            loop {
                let byte = bytes[*at];
                *at += 1;
                value = (value << 7) | usize::from(byte & 0x7F);
                if byte & 0x80 == 0 {
                    return value;
                }
            }
        }
        let mut slots = Vec::new();
        let mut at = 14;
        while at < file.len() {
            assert_eq!(&file[at..at + 4], b"MTrk");
            let length = u32::from_be_bytes(file[at + 4..at + 8].try_into().unwrap()) as usize;
            let (start, end) = (at + 8, at + 8 + length);
            let mut cursor = start;
            let (mut port, mut channel) = (0u8, None);
            while cursor < end {
                variable(file, &mut cursor);
                let status = file[cursor];
                cursor += 1;
                match status {
                    0xFF => {
                        let kind = file[cursor];
                        cursor += 1;
                        let len = variable(file, &mut cursor);
                        if kind == 0x21 {
                            port = file[cursor];
                        }
                        cursor += len;
                    }
                    0xC0..=0xCF => {
                        channel = Some(status & 0x0F);
                        cursor += 1;
                    }
                    0x80..=0x9F => {
                        channel = Some(status & 0x0F);
                        cursor += 2;
                    }
                    other => panic!("unexpected status {other:#x}"),
                }
            }
            if let Some(channel) = channel {
                slots.push((port, channel, channel == 9));
            }
            at = end;
        }
        slots
    }
    fn programs(count: u8) -> Vec<ModelNote> {
        (0..count)
            .map(|program| model_note(0.0, 1.0, 60, program, false))
            .collect()
    }
    #[test]
    fn fifteen_melodic_programs_get_fifteen_channels_without_the_drum_channel() {
        let slots = slots_of(&midi_file(&programs(15)));
        let mut channels: Vec<u8> = slots.iter().map(|(_, channel, _)| *channel).collect();
        channels.sort_unstable();
        assert_eq!(
            channels,
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]
        );
        assert!(slots.iter().all(|(port, _, _)| *port == 0));
    }
    #[test]
    fn more_programs_move_to_further_ports_instead_of_reusing_a_channel() {
        for count in [16u8, 20, 40, 128] {
            let mut notes = programs(count);
            notes.push(model_note(0.0, 0.01, 38, 128, true));
            let slots = slots_of(&midi_file(&notes));
            let melodic: Vec<_> = slots.iter().filter(|(_, _, drums)| !drums).collect();
            assert_eq!(melodic.len(), usize::from(count));
            let mut seen = std::collections::HashSet::new();
            for (port, channel, _) in &melodic {
                assert_ne!(*channel, 9, "no melodic track on the drum channel");
                assert!(
                    seen.insert((*port, *channel)),
                    "{count}: a channel is shared"
                );
            }
            // The drums stay on channel 10 of the first port.
            assert_eq!(slots.iter().filter(|(_, _, drums)| *drums).count(), 1);
            assert!(slots.contains(&(0, 9, true)));
            assert_eq!(
                melodic.iter().map(|(port, _, _)| *port).max().unwrap(),
                (count as usize - 1) as u8 / 15,
                "{count}: 15 melodic channels per port"
            );
        }
    }
    #[test]
    fn the_first_port_is_the_default_and_later_ones_are_named() {
        let file = midi_file(&programs(16));
        assert_eq!(
            file.windows(4)
                .filter(|w| *w == [0xFF, 0x21, 0x01, 1])
                .count(),
            1
        );
        assert_eq!(
            file.windows(3).filter(|w| w[..2] == [0xFF, 0x21]).count(),
            1
        );
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
    fn cancel_all_stops_every_running_transcription() {
        let running = Running::default();
        let stopped = Arc::new(Mutex::new(Vec::new()));
        for id in ["one", "two"] {
            let log = stopped.clone();
            assert!(running.start(id, Box::new(move || log.lock().unwrap().push(id))));
        }
        running.cancel_all();
        let mut log = stopped.lock().unwrap().clone();
        log.sort_unstable();
        assert_eq!(log, ["one", "two"]);
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
