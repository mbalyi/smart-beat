//! Import from Audio: Smart Beat's self-hosted MuScriptor server turns a recording into MIDI
//! (docs/audio-to-midi.md). `POST /transcribe` streams progress and notes as server-sent
//! events and ends with the MIDI file. No keys, credits or jobs: a transcription is free to
//! repeat, and Cancel stops the server's work by closing the connection.
use crate::error::{CommandError, ErrorKind};
use base64::Engine;
use bytes::Bytes;
use reqwest::{
    Body, Client, Response, StatusCode,
    multipart::{Form, Part},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};
use symphonia::core::errors::Error as DemuxError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Runtime, State};

/// Smart Beat's MuScriptor server, from `TRANSCRIPTION_SERVICE_URL` at build time (build.rs).
const SERVICE_URL: Option<&str> = option_env!("TRANSCRIPTION_SERVICE_URL");
const MAX_BYTES: usize = 100 * 1024 * 1024;
/// MuScriptor's own limit for its blocking route. Each minute of audio keeps a GPU busy.
const MAX_DURATION_MS: u32 = 15 * 60 * 1000;
/// What MuScriptor's decoder (libsndfile) reads. It cannot read AAC or M4A.
const EXTENSIONS: [&str; 4] = ["mp3", "wav", "flac", "ogg"];
const INSTRUMENTS: &str = include_str!("../../src/lib/audio-transcription/instrument-ids.json");
/// One MuScriptor instance transcribes one recording at a time. It reads the whole upload,
/// then turns the request away with 503 when it is busy. Asking again may reach an idle
/// instance behind the load balancer. The wait doubles each time, so a long wait uploads the
/// recording fewer times. A rate limit in front of the server answers 429.
const BUSY: Retry = Retry {
    first: Duration::from_secs(10),
    longest: Duration::from_secs(40),
    limit: Duration::from_secs(3 * 60),
};
/// How long a Cancel that arrived before its transcription started is kept.
const EARLY_CANCEL: Duration = Duration::from_secs(60);
const STOPPED: &str = "Transcription stopped.";

fn error(message: impl Into<String>) -> CommandError {
    CommandError::new(ErrorKind::Audio, message)
}
fn service() -> Result<&'static str, CommandError> {
    SERVICE_URL
        .map(|url| url.trim().trim_end_matches('/'))
        .filter(|url| !url.is_empty())
        .ok_or_else(|| error("Audio transcription is not available in this build."))
}
#[tauri::command(async)]
pub fn transcription_configured() -> bool {
    service().is_ok()
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
fn duration_ms(bytes: Bytes, extension: &str) -> Result<u32, CommandError> {
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

fn client() -> Result<Client, CommandError> {
    Client::builder()
        .connect_timeout(Duration::from_secs(30))
        // A transcription streams for minutes. Only a server that goes silent times out.
        .read_timeout(Duration::from_secs(5 * 60))
        .build()
        .map_err(|_| error("Could not initialize the transcription connection."))
}

struct Upload {
    /// Shared by every upload attempt, so a retry does not copy the recording.
    bytes: Bytes,
    extension: String,
    duration_ms: u32,
    instruments: Vec<String>,
}
impl Upload {
    fn form(&self) -> Form {
        // A generic name: the server never learns the local file name.
        let file =
            Part::stream_with_length(Body::from(self.bytes.clone()), self.bytes.len() as u64)
                .file_name(format!("recording.{}", self.extension));
        let mut form = Form::new()
            .part("file", file)
            .text("detect_tempo", "best-effort");
        for instrument in &self.instruments {
            form = form.text("instruments", instrument.clone());
        }
        form
    }
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
/// The recording is the raw body. Headers carry the rest: `operation-id`, `file-type` (the
/// extension) and `instruments`.
#[tauri::command]
pub async fn transcribe_audio<R: Runtime>(
    app: AppHandle<R>,
    running: State<'_, Running>,
    request: Request<'_>,
) -> Result<Transcription, CommandError> {
    let base = service()?;
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
    validate(body, &extension)?;
    // The one copy of the recording, for the length check and every upload attempt.
    let bytes = Bytes::copy_from_slice(body);
    let measure = {
        let (bytes, extension) = (bytes.clone(), extension.clone());
        tauri::async_runtime::spawn_blocking(move || duration_ms(bytes, &extension))
    };
    let duration_ms = measure
        .await
        .map_err(|_| error("Could not read the recording."))??;
    check_duration(duration_ms)?;
    let upload = Upload {
        bytes,
        extension,
        duration_ms,
        instruments,
    };
    let client = client()?;
    let id = operation.clone();
    let emit = move |phase, message, percent| {
        let progress = Progress {
            operation_id: &id,
            phase,
            message,
            percent,
        };
        let _ = app.emit("transcription-progress", progress);
    };
    let task =
        tauri::async_runtime::spawn(
            async move { transcribe(base, &client, upload, BUSY, emit).await },
        );
    let abort = task.inner().abort_handle();
    if !running.start(&operation, Box::new(move || abort.abort())) {
        task.abort();
        return Err(error(STOPPED));
    }
    let result = task.await;
    running.finish(&operation);
    result.unwrap_or_else(|_| Err(error(STOPPED)))
}

#[derive(Clone, Copy)]
struct Retry {
    first: Duration,
    longest: Duration,
    limit: Duration,
}
fn checked(response: Response) -> Result<Response, CommandError> {
    let message = match response.status() {
        status if status.is_success() => return Ok(response),
        StatusCode::BAD_REQUEST => {
            "The transcription server could not read this recording. Re-export it as WAV or MP3."
        }
        StatusCode::PAYLOAD_TOO_LARGE => "The recording is too large for the transcription server.",
        StatusCode::SERVICE_UNAVAILABLE | StatusCode::TOO_MANY_REQUESTS => {
            "The transcription server is busy. Try again in a few minutes."
        }
        _ => "The transcription server could not complete the request. Try again later.",
    };
    Err(error(message))
}
/// Progress for the dialog. It stops at 99: the tempo and the MIDI file still take a few
/// seconds after the last chunk.
fn percent(completed: u32, total: u32) -> u8 {
    (u64::from(completed.min(total)) * 99 / u64::from(total.max(1))) as u8
}
async fn transcribe(
    base: &str,
    client: &Client,
    upload: Upload,
    retry: Retry,
    emit: impl Fn(&'static str, &'static str, Option<u8>),
) -> Result<Transcription, CommandError> {
    let started = Instant::now();
    let mut wait = retry.first;
    let mut response = loop {
        emit("uploading", "Uploading recording…", None);
        let response = client
            .post(format!("{base}/transcribe"))
            .multipart(upload.form())
            .send()
            .await
            .map_err(|_| {
                error("Could not reach the transcription server. Check your connection and try again.")
            })?;
        let busy = matches!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE | StatusCode::TOO_MANY_REQUESTS
        );
        if busy && started.elapsed() + wait <= retry.limit {
            emit(
                "waiting",
                "The transcription server is busy with another recording. Trying again…",
                None,
            );
            tokio::time::sleep(wait).await;
            wait = (wait * 2).min(retry.longest);
            continue;
        }
        break checked(response)?;
    };
    emit("processing", "Transcribing recording…", Some(0));
    let mut events = Events::default();
    let mut notes = Notes::default();
    loop {
        let chunk = response.chunk().await.map_err(|_| {
            error("The connection to the transcription server was interrupted. Try again.")
        })?;
        let batch = match &chunk {
            Some(chunk) => events.push(chunk),
            None => events.finish(),
        };
        for event in batch {
            match event {
                Event::Start {
                    pitch,
                    start_time,
                    index,
                    instrument,
                } => notes.start(index, pitch, start_time, instrument),
                Event::End {
                    end_time,
                    start_event_index,
                } => notes.end(start_event_index, end_time),
                Event::Progress { completed, total } if total > 0 => {
                    let message = if completed >= total {
                        "Building MIDI…"
                    } else {
                        "Transcribing recording…"
                    };
                    emit("processing", message, Some(percent(completed, total)));
                }
                Event::TranscriptionComplete {
                    data,
                    quantized_midi,
                    beat_grid,
                } => {
                    // Notes snapped to the beat grid make readable notation. Without a
                    // grid, the server sends only the performance timing.
                    let midi = quantized_midi.unwrap_or(data);
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(&midi)
                        .unwrap_or_default();
                    if !bytes.starts_with(b"MThd") {
                        return Err(error(
                            "The transcription server returned an invalid MIDI file.",
                        ));
                    }
                    let delay = beat_grid.and_then(|grid| grid.onset_delay).unwrap_or(0.0);
                    return Ok(Transcription {
                        midi_base64: midi,
                        notes: notes.finish(delay),
                        duration_seconds: f64::from(upload.duration_ms) / 1000.0,
                    });
                }
                Event::Progress { .. } | Event::Other => {}
            }
        }
        if chunk.is_none() {
            break;
        }
    }
    Err(error(
        "The transcription server stopped before it finished. Try again.",
    ))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Event {
    Start {
        pitch: f64,
        start_time: f64,
        index: u64,
        instrument: String,
    },
    End {
        end_time: f64,
        start_event_index: u64,
    },
    Progress {
        completed: u32,
        total: u32,
    },
    TranscriptionComplete {
        data: String,
        quantized_midi: Option<String>,
        beat_grid: Option<BeatGrid>,
    },
    #[serde(other)]
    Other,
}
#[derive(Debug, Deserialize)]
struct BeatGrid {
    /// Seconds the streamed note times run late against the beats. The MIDI file has it
    /// taken out already.
    onset_delay: Option<f64>,
}
/// Splits a server-sent event stream into events. A chunk can end anywhere.
#[derive(Default)]
struct Events {
    buffer: Vec<u8>,
}
impl Events {
    fn push(&mut self, chunk: &[u8]) -> Vec<Event> {
        self.buffer.extend(chunk.iter().filter(|&&b| b != b'\r'));
        let mut events = Vec::new();
        while let Some(end) = self.buffer.windows(2).position(|w| w == b"\n\n") {
            let block: Vec<u8> = self.buffer.drain(..end + 2).collect();
            for line in block.split(|&b| b == b'\n') {
                if let Some(data) = line.strip_prefix(b"data:")
                    && let Ok(event) = serde_json::from_slice(data.trim_ascii_start())
                {
                    events.push(event);
                }
            }
        }
        events
    }
    /// The last event, when the stream ends without the blank line after it.
    fn finish(&mut self) -> Vec<Event> {
        self.push(b"\n\n")
    }
}

/// MuScriptor's numbers are JSON numbers, so they may arrive as `60.0`.
#[derive(Debug, Serialize)]
pub struct Note {
    pub pitch: f64,
    pub start: f64,
    pub end: f64,
    pub instrument: Option<String>,
    pub velocity: Option<f64>,
}
impl Note {
    fn is_valid(&self) -> bool {
        self.pitch.is_finite()
            && (0.0..=127.0).contains(&self.pitch)
            && self.start.is_finite()
            && self.end.is_finite()
            && self.end >= self.start
    }
}
/// Pairs streamed note starts and ends into notes for the preview.
#[derive(Default)]
struct Notes {
    open: HashMap<u64, (f64, f64, String)>,
    closed: Vec<Note>,
}
impl Notes {
    fn start(&mut self, index: u64, pitch: f64, start: f64, instrument: String) {
        self.open.insert(index, (pitch, start, instrument));
    }
    fn end(&mut self, index: u64, end: f64) {
        if let Some((pitch, start, instrument)) = self.open.remove(&index) {
            self.closed.push(Note {
                pitch,
                start,
                end,
                instrument: Some(instrument),
                velocity: None,
            });
        }
    }
    /// Shifts the streamed times back by `delay` to match the MIDI file.
    fn finish(mut self, delay: f64) -> Vec<Note> {
        let delay = if delay.is_finite() { delay } else { 0.0 };
        let unended = self
            .open
            .into_values()
            .map(|(pitch, start, instrument)| Note {
                pitch,
                start,
                end: start,
                instrument: Some(instrument),
                velocity: None,
            });
        self.closed.extend(unended);
        let mut notes: Vec<Note> = self
            .closed
            .into_iter()
            .filter(Note::is_valid)
            .map(|note| Note {
                start: (note.start - delay).max(0.0),
                end: (note.end - delay).max(0.0),
                ..note
            })
            .collect();
        notes.sort_by(|a, b| a.start.total_cmp(&b.start));
        notes
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcription {
    midi_base64: String,
    notes: Vec<Note>,
    duration_seconds: f64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, mpsc};

    const MIDI: &str = "TVRoZAAAAAYAAQABAeA="; // "MThd" header
    const QUANTIZED: &str = "TVRoZAAAAAYAAQABAMA=";

    fn upload() -> Upload {
        Upload {
            bytes: Bytes::from_static(b"audio"),
            extension: "mp3".into(),
            duration_ms: 3000,
            instruments: vec!["electric_bass".into(), "drums".into()],
        }
    }
    /// A mono 16-bit WAV file of silence.
    fn wav(rate: u32, seconds: u32) -> Bytes {
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
        Bytes::from(file)
    }
    /// Reads one HTTP request, head and body, as text.
    fn read_request(stream: &mut TcpStream) -> String {
        let mut data = Vec::new();
        let mut buf = [0; 4096];
        loop {
            let n = stream.read(&mut buf).unwrap();
            data.extend_from_slice(&buf[..n]);
            if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&data[..end]).to_lowercase();
                let length = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                while data.len() < end + 4 + length {
                    let n = stream.read(&mut buf).unwrap();
                    if n == 0 {
                        break;
                    }
                    data.extend_from_slice(&buf[..n]);
                }
                return String::from_utf8_lossy(&data).into_owned();
            }
            if n == 0 {
                return String::from_utf8_lossy(&data).into_owned();
            }
        }
    }
    /// A local stand-in for the MuScriptor server: answers each request with the next
    /// status and body, and reports each request.
    fn serve(responses: Vec<(u16, String)>) -> (&'static str, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (sent, requests) = mpsc::channel();
        std::thread::spawn(move || {
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let _ = sent.send(read_request(&mut stream));
                let kind = if status == 200 {
                    "text/event-stream"
                } else {
                    "application/json"
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} Test\r\nContent-Type: {kind}\r\nConnection: close\r\n\r\n{body}"
                );
            }
        });
        (Box::leak(base.into_boxed_str()), requests)
    }
    fn sse(events: &[&str]) -> String {
        events.iter().map(|e| format!("data: {e}\n\n")).collect()
    }
    fn complete(quantized: Option<&str>, onset_delay: f64) -> String {
        let quantized = quantized.map_or("null".into(), |q| format!("\"{q}\""));
        format!(
            r#"{{"type":"transcription_complete","data":"{MIDI}","quantized_midi":{quantized},"beat_grid":{{"bpm":120,"beats_per_bar":4,"first_downbeat":0.5,"onset_delay":{onset_delay}}}}}"#
        )
    }
    type Phases = Arc<Mutex<Vec<&'static str>>>;
    fn run(base: &'static str, retry: Retry) -> (Result<Transcription, CommandError>, Phases) {
        let phases: Phases = Arc::default();
        let seen = phases.clone();
        let emit = move |phase, _message, _percent| seen.lock().unwrap().push(phase);
        let client = Client::builder().no_proxy().build().unwrap();
        let result =
            tauri::async_runtime::block_on(transcribe(base, &client, upload(), retry, emit));
        (result, phases)
    }
    const NO_RETRY: Retry = Retry {
        first: Duration::from_millis(10),
        longest: Duration::from_millis(10),
        limit: Duration::ZERO,
    };
    const QUICK_RETRY: Retry = Retry {
        first: Duration::from_millis(10),
        longest: Duration::from_millis(20),
        limit: Duration::from_secs(5),
    };

    #[test]
    fn validates_recordings_and_instruments() {
        assert!(validate(b"a", "mp3").is_ok());
        assert!(validate(b"", "mp3").is_err());
        assert!(validate(b"a", "m4a").is_err(), "libsndfile cannot read AAC");
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
        let ms = duration_ms(Bytes::from(mp3), "mp3").unwrap();
        assert!((1900..=2100).contains(&ms), "{ms}");
        assert!(duration_ms(Bytes::from_static(b"not audio"), "wav").is_err());
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
    #[test]
    fn reads_events_split_anywhere_and_ignores_unknown_ones() {
        let stream = "data: {\"type\":\"progress\",\"completed\":0,\"total\":4}\r\n\r\ndata: {\"type\":\"heartbeat\"}\n\ndata: {\"type\":\"start\",\"pitch\":60,\"start_time\":0.5,\"index\":0,\"instrument\":\"drums\"}\n\n";
        let mut events = Events::default();
        let mut all = Vec::new();
        for chunk in stream.as_bytes().chunks(7) {
            all.extend(events.push(chunk));
        }
        assert!(matches!(
            all[0],
            Event::Progress {
                completed: 0,
                total: 4
            }
        ));
        assert!(matches!(all[1], Event::Other));
        assert!(
            matches!(&all[2], Event::Start { index: 0, instrument, .. } if instrument == "drums")
        );
        assert_eq!(all.len(), 3);
    }
    #[test]
    fn computes_progress_without_overflow() {
        assert_eq!(percent(0, 4), 0);
        assert_eq!(percent(2, 4), 49);
        assert_eq!(percent(4, 4), 99);
        assert_eq!(percent(u32::MAX - 1, u32::MAX), 98);
        assert_eq!(percent(u32::MAX, u32::MAX), 99);
    }
    #[test]
    fn pairs_notes_and_removes_the_onset_delay() {
        let mut notes = Notes::default();
        notes.start(0, 60.0, 1.25, "acoustic_piano".into());
        notes.start(1, 64.0, 0.25, "drums".into());
        notes.end(0, 2.25);
        notes.end(7, 9.0); // no matching start
        notes.start(2, 200.0, 1.0, "drums".into()); // out of range
        let notes = notes.finish(0.25);
        assert_eq!(notes.len(), 2);
        assert_eq!(
            (notes[0].pitch, notes[0].start, notes[0].end),
            (64.0, 0.0, 0.0),
            "unended"
        );
        assert_eq!((notes[1].start, notes[1].end), (1.0, 2.0));
    }
    #[test]
    fn transcribes_with_quantized_midi_and_a_generic_file_name() {
        let stream = sse(&[
            r#"{"type":"progress","completed":0,"total":2}"#,
            r#"{"type":"start","pitch":60,"start_time":0.75,"index":0,"instrument":"electric_bass"}"#,
            r#"{"type":"end","end_time":1.25,"start_event_index":0}"#,
            r#"{"type":"progress","completed":2,"total":2}"#,
            &complete(Some(QUANTIZED), 0.25),
        ]);
        let (base, requests) = serve(vec![(200, stream)]);
        let (result, phases) = run(base, NO_RETRY);
        let result = result.unwrap();
        assert_eq!(
            result.midi_base64, QUANTIZED,
            "notation needs the beat grid"
        );
        assert_eq!((result.notes[0].start, result.notes[0].end), (0.5, 1.0));
        assert_eq!(result.duration_seconds, 3.0);
        assert_eq!(
            *phases.lock().unwrap(),
            ["uploading", "processing", "processing", "processing"]
        );
        let request = requests.recv().unwrap();
        assert!(request.starts_with("POST /transcribe "), "{request}");
        assert!(request.contains("filename=\"recording.mp3\""));
        assert!(request.contains("\r\n\r\naudio\r\n"), "the recording");
        assert_eq!(request.matches("name=\"instruments\"").count(), 2);
        let head = request.to_lowercase();
        assert!(!head.contains("authorization"), "no keys");
        assert!(!head.contains("x-client-id"), "no identifier");
    }
    #[test]
    fn falls_back_to_performance_timing_without_a_beat_grid() {
        let (base, _) = serve(vec![(200, sse(&[&complete(None, 0.0)]))]);
        assert_eq!(run(base, NO_RETRY).0.unwrap().midi_base64, MIDI);
    }
    #[test]
    fn keeps_the_last_event_when_the_stream_ends_without_a_blank_line() {
        let (base, _) = serve(vec![(200, format!("data: {}\n", complete(None, 0.0)))]);
        assert_eq!(run(base, NO_RETRY).0.unwrap().midi_base64, MIDI);
    }
    #[test]
    fn waits_while_the_server_is_busy_or_rate_limited_then_gives_up() {
        let busy = r#"{"detail":"server busy: another transcription is in progress"}"#.to_owned();
        let (base, requests) = serve(vec![
            (503, busy.clone()),
            (429, "{}".into()),
            (200, sse(&[&complete(None, 0.0)])),
        ]);
        let (result, phases) = run(base, QUICK_RETRY);
        assert!(result.is_ok());
        assert_eq!(requests.iter().take(3).count(), 3);
        assert_eq!(
            phases
                .lock()
                .unwrap()
                .iter()
                .filter(|p| **p == "waiting")
                .count(),
            2
        );

        let (base, _) = serve(vec![(503, busy)]);
        let message = run(base, NO_RETRY).0.err().unwrap().message;
        assert_eq!(
            message,
            "The transcription server is busy. Try again in a few minutes."
        );
    }
    #[test]
    fn explains_rejected_broken_and_unfinished_transcriptions() {
        let (base, _) = serve(vec![(400, r#"{"detail":"could not decode"}"#.into())]);
        assert!(
            run(base, NO_RETRY)
                .0
                .err()
                .unwrap()
                .message
                .contains("could not read this recording")
        );
        let broken = r#"{"type":"transcription_complete","data":"bm90IG1pZGk=","quantized_midi":null,"beat_grid":null}"#;
        let (base, _) = serve(vec![(200, sse(&[broken]))]);
        assert!(
            run(base, NO_RETRY)
                .0
                .err()
                .unwrap()
                .message
                .contains("invalid MIDI")
        );
        let (base, _) = serve(vec![(
            200,
            sse(&[r#"{"type":"progress","completed":1,"total":4}"#]),
        )]);
        assert!(
            run(base, NO_RETRY)
                .0
                .err()
                .unwrap()
                .message
                .contains("stopped before it finished")
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
