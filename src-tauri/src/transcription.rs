//! Import from Audio: Smart Beat's self-hosted MuScriptor server turns a recording into MIDI
//! (docs/audio-to-midi.md). `POST /transcribe` streams progress and notes as server-sent
//! events and ends with the MIDI file. No keys, credits or jobs: a transcription is free to
//! repeat, and Cancel stops the server's work by closing the connection.
use crate::error::{CommandError, ErrorKind};
use base64::Engine;
use reqwest::{
    Client, Response, StatusCode,
    multipart::{Form, Part},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::Path,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
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
/// One MuScriptor instance transcribes one recording at a time and turns others away with
/// 503 at once. Asking again may reach an idle instance behind the load balancer.
const BUSY: Retry = Retry {
    every: Duration::from_secs(10),
    limit: Duration::from_secs(3 * 60),
};
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

fn validate(bytes: &[u8], duration_ms: u32, extension: &str) -> Result<(), CommandError> {
    if bytes.is_empty() {
        return Err(error("The audio file is empty."));
    }
    if bytes.len() > MAX_BYTES {
        return Err(error("The audio file exceeds the 100 MiB limit."));
    }
    if duration_ms == 0 || duration_ms > MAX_DURATION_MS {
        return Err(error("Choose a recording up to 15 minutes long."));
    }
    if !EXTENSIONS.contains(&extension) {
        return Err(error("Choose MP3, WAV, FLAC or OGG audio."));
    }
    Ok(())
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
#[tauri::command(async)]
pub fn read_transcription_audio(path: String) -> Result<tauri::ipc::Response, CommandError> {
    let path = Path::new(&path);
    let extension = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !EXTENSIONS.contains(&extension.as_str()) {
        return Err(error("Choose MP3, WAV, FLAC or OGG audio."));
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
    Ok(tauri::ipc::Response::new(bytes))
}

fn client() -> Result<Client, CommandError> {
    Client::builder()
        .connect_timeout(Duration::from_secs(30))
        // A transcription streams for minutes. Only a server that goes silent times out.
        .read_timeout(Duration::from_secs(5 * 60))
        .build()
        .map_err(|_| error("Could not initialize the transcription connection."))
}
/// Sent as `X-Client-Id`. MuScriptor lets a new request from the same client stop that
/// client's earlier run, so a retry after Cancel never waits for the abandoned one.
fn client_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        use std::hash::{BuildHasher, Hasher};
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u32(std::process::id());
        format!("smart-beat-{:016x}", hasher.finish())
    })
}

struct Upload {
    bytes: Vec<u8>,
    extension: String,
    duration_ms: u32,
    instruments: Vec<String>,
}
impl Upload {
    fn form(&self) -> Form {
        // A generic name: the server never learns the local file name.
        let file =
            Part::bytes(self.bytes.clone()).file_name(format!("recording.{}", self.extension));
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
/// Transcriptions in flight by operation id, so Cancel can stop one. `None` marks a Cancel
/// that arrived before its transcription started.
#[derive(Default)]
pub struct Running(Mutex<HashMap<String, Option<Abort>>>);
impl Running {
    /// Registers how to stop an operation. False when it was cancelled already.
    fn start(&self, id: &str, abort: Abort) -> bool {
        let mut running = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(running.remove(id), Some(None)) {
            return false;
        }
        running.insert(id.to_owned(), Some(abort));
        true
    }
    fn finish(&self, id: &str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }
    fn cancel(&self, id: &str) {
        let mut running = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match running.remove(id) {
            Some(Some(abort)) => abort(),
            _ => {
                running.insert(id.to_owned(), None);
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
/// extension), `duration-ms` (measured by the webview) and `instruments`.
#[tauri::command]
pub async fn transcribe_audio<R: Runtime>(
    app: AppHandle<R>,
    running: State<'_, Running>,
    request: Request<'_>,
) -> Result<Transcription, CommandError> {
    let base = service()?;
    let InvokeBody::Raw(bytes) = request.body() else {
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
    let upload = Upload {
        extension: header("file-type")?.to_lowercase(),
        duration_ms: header("duration-ms")?
            .parse()
            .map_err(|_| error("Could not read the recording duration."))?,
        instruments: instruments(header("instruments").unwrap_or(""))?,
        bytes: bytes.clone(),
    };
    validate(&upload.bytes, upload.duration_ms, &upload.extension)?;
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
    every: Duration,
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
async fn transcribe(
    base: &str,
    client: &Client,
    upload: Upload,
    retry: Retry,
    emit: impl Fn(&'static str, &'static str, Option<u8>),
) -> Result<Transcription, CommandError> {
    let started = Instant::now();
    let mut response = loop {
        emit("uploading", "Uploading recording…", None);
        let response = client
            .post(format!("{base}/transcribe"))
            .header("x-client-id", client_id())
            .multipart(upload.form())
            .send()
            .await
            .map_err(|_| {
                error("Could not reach the transcription server. Check your connection and try again.")
            })?;
        if response.status() == StatusCode::SERVICE_UNAVAILABLE
            && started.elapsed() + retry.every <= retry.limit
        {
            emit(
                "waiting",
                "The transcription server is busy with another recording. Trying again…",
                None,
            );
            tokio::time::sleep(retry.every).await;
            continue;
        }
        break checked(response)?;
    };
    emit("processing", "Transcribing recording…", Some(0));
    let mut events = Events::default();
    let mut notes = Notes::default();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        error("The connection to the transcription server was interrupted. Try again.")
    })? {
        for event in events.push(&chunk) {
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
                    // The tempo and the MIDI file still take a few seconds after the last chunk.
                    let percent = (completed.min(total) * 99 / total) as u8;
                    let message = if completed >= total {
                        "Building MIDI…"
                    } else {
                        "Transcribing recording…"
                    };
                    emit("processing", message, Some(percent));
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
            bytes: b"audio".to_vec(),
            extension: "mp3".into(),
            duration_ms: 3000,
            instruments: vec!["electric_bass".into(), "drums".into()],
        }
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
        every: Duration::from_millis(10),
        limit: Duration::ZERO,
    };

    #[test]
    fn validates_recordings_and_instruments() {
        assert!(validate(b"a", 1000, "mp3").is_ok());
        assert!(validate(b"", 1000, "mp3").is_err());
        assert!(validate(b"a", MAX_DURATION_MS + 1, "mp3").is_err());
        assert!(
            validate(b"a", 1000, "m4a").is_err(),
            "libsndfile cannot read AAC"
        );
        assert_eq!(
            instruments(" electric_bass,drums ").unwrap(),
            ["electric_bass", "drums"]
        );
        assert!(instruments("").unwrap().is_empty());
        assert!(instruments("guitar").is_err());
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
        assert!(request.to_lowercase().contains("x-client-id: smart-beat-"));
        assert_eq!(request.matches("name=\"instruments\"").count(), 2);
        assert!(!request.to_lowercase().contains("authorization"), "no keys");
    }
    #[test]
    fn falls_back_to_performance_timing_without_a_beat_grid() {
        let (base, _) = serve(vec![(200, sse(&[&complete(None, 0.0)]))]);
        assert_eq!(run(base, NO_RETRY).0.unwrap().midi_base64, MIDI);
    }
    #[test]
    fn waits_while_the_server_is_busy_then_gives_up() {
        let busy = r#"{"detail":"server busy: another transcription is in progress"}"#.to_owned();
        let retry = Retry {
            every: Duration::from_millis(10),
            limit: Duration::from_secs(5),
        };
        let (base, requests) = serve(vec![
            (503, busy.clone()),
            (200, sse(&[&complete(None, 0.0)])),
        ]);
        let (result, phases) = run(base, retry);
        assert!(result.is_ok());
        assert_eq!(requests.iter().take(2).count(), 2);
        assert!(phases.lock().unwrap().contains(&"waiting"));

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
}
