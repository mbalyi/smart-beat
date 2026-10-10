//! Mirelo Audio-to-MIDI: uploads, paid jobs that survive a restart, and results.
//! Job creation is NOT idempotent. Journal the attempt before sending it.
use crate::error::{CommandError, ErrorKind};
use base64::Engine;
use reqwest::{
    Response,
    multipart::{Form, Part},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Runtime, State};

const API_BASE: &str = "https://api.mirelo.ai";
const MAX_BYTES: usize = 100 * 1024 * 1024;
const MAX_DURATION_MS: u32 = 30 * 60 * 1000;
const INSTRUMENTS: &str = include_str!("../../src/lib/audio-transcription/instrument-ids.json");
fn error(message: impl Into<String>) -> CommandError {
    CommandError::new(ErrorKind::Audio, message)
}
/// Smart Beat's own key, compiled in from the `MIRELO_AI_API_KEY` environment variable:
/// the GitHub secret in release builds, `.env` or the shell locally (build.rs). Users never
/// enter a key. Anyone with the app can extract it, so the key needs a spending cap
/// (docs/mirelo-audio-to-midi.md).
const API_KEY: Option<&str> = option_env!("MIRELO_AI_API_KEY");

fn api_key() -> Result<&'static str, CommandError> {
    API_KEY
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .ok_or_else(|| error("Audio transcription is not available in this build."))
}
#[tauri::command(async)]
pub fn mirelo_configured() -> bool {
    api_key().is_ok()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub asset_id: String,
    pub duration_ms: u32,
    pub credits: u32,
    pub estimated_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Pending {
    quote: Quote,
    job_url: Option<String>,
}
/// Contains no credentials, audio content, or source filenames.
pub struct JobStore {
    path: PathBuf,
    pending: Mutex<Option<Pending>>,
    creating: AtomicBool,
}
impl JobStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            pending: Mutex::new(None),
            creating: AtomicBool::new(false),
        }
    }
    fn claim(&self) -> Result<CreateGuard<'_>, CommandError> {
        if self.creating.swap(true, Ordering::SeqCst) {
            return Err(error(
                "A transcription is already being submitted. Resume its job instead.",
            ));
        }
        Ok(CreateGuard(&self.creating))
    }
    fn discard(&self) -> Result<(), CommandError> {
        if self.creating.load(Ordering::SeqCst) {
            return Err(error(
                "Wait for the create request to finish before dismissing this attempt.",
            ));
        }
        self.write(None)
    }
    fn read(&self) -> Result<Option<Pending>, CommandError> {
        if let Some(pending) = self
            .pending
            .lock()
            .map_err(|_| error("The job store is unavailable."))?
            .clone()
        {
            return Ok(Some(pending));
        }
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
                error(
                    "The saved job reference is damaged. Dismiss it to start a new transcription.",
                )
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(error("Could not read the saved job reference.")),
        }
    }
    fn write(&self, value: Option<Pending>) -> Result<(), CommandError> {
        let mut slot = self
            .pending
            .lock()
            .map_err(|_| error("The job store is unavailable."))?;
        self.persist(&value)?;
        *slot = value;
        Ok(())
    }
    fn persist(&self, value: &Option<Pending>) -> Result<(), CommandError> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| error("Invalid job store path."))?;
        fs::create_dir_all(parent).map_err(|_| error("Could not create the job store."))?;
        let mut file = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| error("Could not save the job reference."))?;
        file.write_all(
            &serde_json::to_vec(value).map_err(|_| error("Could not encode the job reference."))?,
        )
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| error("Could not save the job reference."))?;
        file.persist(&self.path)
            .map_err(|_| error("Could not save the job reference."))?;
        Ok(())
    }
    fn begin(&self, quote: Quote) -> Result<(), CommandError> {
        let mut slot = self
            .pending
            .lock()
            .map_err(|_| error("The job store is unavailable."))?;
        if slot.is_some()
            || self.path.exists()
                && fs::read(&self.path).map_err(|_| error("Could not read the job store."))?
                    != b"null"
        {
            return Err(error(
                "A previous job must be recovered or explicitly dismissed before starting another.",
            ));
        }
        let value = Some(Pending {
            quote,
            job_url: None,
        });
        self.persist(&value)?;
        *slot = value;
        Ok(())
    }
}
struct CreateGuard<'a>(&'a AtomicBool);
impl Drop for CreateGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
#[tauri::command]
pub fn mirelo_pending(store: State<'_, JobStore>) -> Result<Option<Quote>, CommandError> {
    Ok(store.read()?.map(|p| p.quote))
}
#[tauri::command]
pub fn mirelo_discard_pending(store: State<'_, JobStore>) -> Result<(), CommandError> {
    store.discard()
}

fn validate_audio(bytes: &[u8], duration: u32, content_type: &str) -> Result<(), CommandError> {
    if bytes.is_empty() {
        return Err(error("The audio file is empty."));
    }
    if bytes.len() > MAX_BYTES {
        return Err(error("The audio file exceeds the 100 MiB limit."));
    }
    if duration == 0 || duration > MAX_DURATION_MS {
        return Err(error(
            "Choose a recording between 1 ms and 30 minutes long.",
        ));
    }
    if !matches!(
        content_type,
        "audio/mpeg" | "audio/wav" | "audio/flac" | "audio/ogg" | "audio/aac"
    ) {
        return Err(error("Mirelo accepts MP3, WAV, FLAC, OGG, and AAC audio."));
    }
    Ok(())
}
fn audio_extension(path: &Path) -> Result<String, CommandError> {
    let ext = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !matches!(ext.as_str(), "mp3" | "wav" | "flac" | "ogg" | "aac") {
        return Err(error("Choose MP3, WAV, FLAC, OGG, or AAC audio."));
    }
    Ok(ext)
}
#[tauri::command(async)]
pub fn read_transcription_audio(path: String) -> Result<tauri::ipc::Response, CommandError> {
    let path = Path::new(&path);
    audio_extension(path)?;
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
        return Err(error("The recording exceeds 100 MiB."));
    }
    Ok(tauri::ipc::Response::new(bytes))
}
fn client() -> Result<reqwest::Client, CommandError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| error("Could not initialize the Mirelo connection."))
}
#[derive(Deserialize)]
struct ApiFailure {
    error: FailureDetail,
}
#[derive(Deserialize)]
struct FailureDetail {
    #[serde(default)]
    code: String,
}
fn failure_message(status: u16, code: &str) -> &'static str {
    match (status, code) {
        (401 | 403, _) => {
            "The transcription service rejected this build's key. Update Smart Beat or try again later."
        }
        (402, _) => {
            "Transcription is unavailable: the service has no credits left. Try again later."
        }
        (429, _) => "Mirelo's rate or concurrent-job limit was reached. Wait before trying again.",
        (_, "invalid_audio" | "audio_format_unsupported" | "invalid_asset") => {
            "Mirelo could not decode this recording. Re-export it as WAV or MP3."
        }
        (_, "audio_too_long" | "audio_too_short") => {
            "The recording duration is outside Mirelo's supported limits."
        }
        (_, "asset_not_ready") => "The upload is not ready yet. Wait briefly before trying again.",
        _ => "Mirelo could not complete the request. Check your connection or try again later.",
    }
}
async fn checked(response: Result<Response, reqwest::Error>) -> Result<Response, CommandError> {
    let response = response
        .map_err(|_| error("The Mirelo request timed out or the connection was interrupted."))?;
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status().as_u16();
    let body = response.json::<ApiFailure>().await.ok();
    Err(error(failure_message(
        status,
        body.as_ref().map(|v| v.error.code.as_str()).unwrap_or(""),
    )))
}
#[derive(Deserialize)]
struct AssetTicket {
    id: String,
    upload_url: String,
    fields: HashMap<String, String>,
    max_bytes: usize,
}
#[derive(Deserialize)]
struct Preflight {
    credits: u32,
    credit_shortfall: u32,
    provisioning_state: Option<String>,
    estimated_ms: u64,
    #[serde(default)]
    billing_mode: String,
}
fn affordable(quote: &Preflight) -> Result<(), CommandError> {
    if quote.billing_mode == "unmetered" {
        return Ok(());
    }
    if quote
        .provisioning_state
        .as_deref()
        .is_some_and(|state| state != "ready")
    {
        return Err(error(
            "Transcription is unavailable: the service has no credits ready. Try again later.",
        ));
    }
    if quote.credit_shortfall > 0 {
        return Err(error(
            "Transcription is unavailable: the service has too few credits left. Try a shorter recording or try again later.",
        ));
    }
    Ok(())
}
fn secure_url(value: &str) -> Result<reqwest::Url, CommandError> {
    let url = reqwest::Url::parse(value).map_err(|_| error("Mirelo returned an invalid URL."))?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err(error("Mirelo returned an insecure URL."));
    }
    Ok(url)
}
fn job_url(value: &str) -> Result<String, CommandError> {
    let absolute = if value.starts_with('/') {
        format!("{API_BASE}{value}")
    } else {
        value.to_owned()
    };
    let url = secure_url(&absolute)?;
    if url.host_str() != Some("api.mirelo.ai")
        || url.port_or_known_default() != Some(443)
        || !url.path().starts_with("/v2/audio-to-midi/v1.0/jobs/")
    {
        return Err(error("Mirelo returned an unexpected job URL."));
    }
    Ok(url.into())
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    operation_id: &'a str,
    phase: &'a str,
    message: &'a str,
}
#[tauri::command(async)]
pub async fn quote_audio<R: Runtime>(
    app: AppHandle<R>,
    request: Request<'_>,
) -> Result<Quote, CommandError> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        _ => return Err(error("The recording is missing.")),
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| error(format!("Missing {name}.")))
    };
    // The webview's Content-Type is always application/octet-stream for a raw body.
    let content_type = header("audio-type")?;
    let duration_ms = header("duration-ms")?
        .parse()
        .map_err(|_| error("Could not read the recording duration."))?;
    validate_audio(bytes, duration_ms, content_type)?;
    let operation_id = header("operation-id")?;
    let emit = |phase, message| {
        let _ = app.emit(
            "mirelo-upload-progress",
            Progress {
                operation_id,
                phase,
                message,
            },
        );
    };
    let key = api_key()?;
    let client = client()?;
    emit("quoting", "Checking the transcription service…");
    let preflight: Preflight = checked(
        client
            .get(format!(
                "{API_BASE}/v2/audio-to-midi/v1.0/preflight?duration_ms={duration_ms}"
            ))
            .bearer_auth(key)
            .send()
            .await,
    )
    .await?
    .json()
    .await
    .map_err(|_| error("Mirelo returned an invalid quote."))?;
    affordable(&preflight)?;
    let ticket: AssetTicket = checked(
        client
            .post(format!("{API_BASE}/v3/assets"))
            .bearer_auth(key)
            .json(&serde_json::json!({"content_type": content_type}))
            .send()
            .await,
    )
    .await?
    .json()
    .await
    .map_err(|_| error("Mirelo returned an invalid upload ticket."))?;
    if bytes.len() > ticket.max_bytes {
        return Err(error(
            "This recording exceeds the provider's current upload limit. Try a compressed MP3.",
        ));
    }
    let upload_url = secure_url(&ticket.upload_url)?;
    let mut form = Form::new();
    for (name, value) in ticket.fields {
        form = form.text(name, value);
    }
    let extension = match content_type {
        "audio/mpeg" => "mp3",
        "audio/wav" => "wav",
        "audio/flac" => "flac",
        "audio/ogg" => "ogg",
        _ => "aac",
    };
    form = form.part(
        "file",
        Part::bytes(bytes.to_vec())
            .file_name(format!("recording.{extension}"))
            .mime_str(content_type)
            .map_err(|_| error("Unsupported audio type."))?,
    );
    emit("uploading", "Uploading recording securely…");
    // 100 MiB over a slow uplink takes far longer than one API call.
    checked(
        client
            .post(upload_url)
            .timeout(Duration::from_secs(30 * 60))
            .multipart(form)
            .send()
            .await,
    )
    .await?;
    Ok(Quote {
        asset_id: ticket.id,
        duration_ms,
        credits: preflight.credits,
        estimated_ms: preflight.estimated_ms,
    })
}
#[derive(Deserialize)]
struct Accepted {
    job_url: String,
}
fn payload(quote: &Quote, instruments: &[String]) -> Result<serde_json::Value, CommandError> {
    validate_audio(&[1], quote.duration_ms, "audio/wav")?;
    if quote.asset_id.is_empty() || quote.asset_id.len() > 128 {
        return Err(error("Invalid uploaded asset."));
    }
    let allowed: Vec<String> = serde_json::from_str(INSTRUMENTS).expect("instrument list");
    if instruments.len() > allowed.len() || instruments.iter().any(|v| !allowed.contains(v)) {
        return Err(error(
            "Choose instruments from the supported instrument list.",
        ));
    }
    // Quantized notes land on the beat grid, which notation needs. Mirelo falls
    // back to performance timing when it finds no reliable grid.
    let mut value = serde_json::json!({"audio": {"type": "asset", "asset_id": quote.asset_id}, "timing": "quantized"});
    if !instruments.is_empty() {
        value["instruments"] = serde_json::json!(instruments);
    }
    Ok(value)
}
#[tauri::command]
pub async fn transcribe_audio(
    store: State<'_, JobStore>,
    quote: Quote,
    instruments: Vec<String>,
) -> Result<(), CommandError> {
    let key = api_key()?;
    let payload = payload(&quote, &instruments)?;
    let client = client()?;
    let _guard = store.claim()?;
    store.begin(quote.clone())?;
    let response = client
        .post(format!("{API_BASE}/v2/audio-to-midi/v1.0/jobs"))
        .bearer_auth(key)
        .json(&payload)
        .send()
        .await;
    // A definite 4xx rejection did not start a job. Timeouts remain ambiguous.
    if response
        .as_ref()
        .is_ok_and(|r| r.status().is_client_error() && r.status().as_u16() != 408)
    {
        store.write(None)?;
    }
    let accepted: Accepted = checked(response).await?.json().await.map_err(|_| error("The job may have started, but its reference was unreadable. Dismiss it before submitting again."))?;
    let url = job_url(&accepted.job_url)?;
    store.write(Some(Pending {
        quote,
        job_url: Some(url),
    }))
}
/// The schema types pitch and velocity as JSON numbers, so they may arrive as `60.0`.
#[derive(Debug, Deserialize, Serialize)]
pub struct Note {
    pub pitch: f64,
    pub start: f64,
    pub end: f64,
    pub instrument: Option<String>,
    pub velocity: Option<f64>,
}
impl Note {
    fn is_valid(&self) -> bool {
        let midi = |v: f64| v.is_finite() && (0.0..=127.0).contains(&v);
        midi(self.pitch)
            && self.velocity.is_none_or(midi)
            && self.start.is_finite()
            && self.end.is_finite()
            && self.start >= 0.0
            && self.end >= self.start
    }
}
#[derive(Deserialize)]
struct JobResult {
    midi_url: String,
    duration_seconds: f64,
    #[serde(default)]
    notes: Vec<Note>,
    model: Option<String>,
}
#[derive(Deserialize)]
struct JobStatus {
    status: String,
    result: Option<JobResult>,
    error: Option<FailureDetail>,
    progress_percent: Option<u8>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcription {
    midi_base64: String,
    notes: Vec<Note>,
    duration_seconds: f64,
    model: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    status: String,
    percent: Option<u8>,
    result: Option<Transcription>,
}
#[tauri::command]
pub async fn poll_audio(store: State<'_, JobStore>) -> Result<Snapshot, CommandError> {
    let pending = store
        .read()?
        .ok_or_else(|| error("There is no saved transcription to recover."))?;
    let url = pending.job_url.ok_or_else(|| error("The transcription may or may not have started. Dismiss this attempt to start a new one."))?;
    let client = client()?;
    let status: JobStatus = checked(
        client
            .get(job_url(&url)?)
            .bearer_auth(api_key()?)
            .send()
            .await,
    )
    .await?
    .json()
    .await
    .map_err(|_| {
        error("Mirelo returned an unreadable job status. You can resume checking this job.")
    })?;
    match status.status.as_str() {
        "succeeded" => {
            let result = status
                .result
                .ok_or_else(|| error("Mirelo completed without a result."))?;
            let midi = checked(client.get(secure_url(&result.midi_url)?).send().await).await?;
            let bytes = midi.bytes().await.map_err(|_| {
                error("Could not download MIDI. Resume to download this result again.")
            })?;
            if !bytes.starts_with(b"MThd") {
                return Err(error("Mirelo returned an invalid MIDI file."));
            }
            if !result.duration_seconds.is_finite()
                || result.duration_seconds <= 0.0
                || !result.notes.iter().all(Note::is_valid)
            {
                return Err(error("Mirelo returned invalid note timing."));
            }
            Ok(Snapshot {
                status: status.status,
                percent: Some(100),
                result: Some(Transcription {
                    midi_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                    notes: result.notes,
                    duration_seconds: result.duration_seconds,
                    model: result.model,
                }),
            })
        }
        "errored" | "failed" => {
            store.write(None)?;
            // Provider messages may contain source details. Show the error code instead.
            let failure = status.error;
            let message = failure
                .as_ref()
                .map(|f| failure_message(0, &f.code))
                .unwrap_or("The transcription failed. Check the recording and try again.");
            Err(error(message))
        }
        // `processing`, or a state added later: the API marks the list as open.
        // Keep polling; the frontend bounds the wait.
        _ => Ok(Snapshot {
            status: status.status,
            percent: status.progress_percent,
            result: None,
        }),
    }
}

/// Opens one of the provider's pages in the system browser. The webview
/// cannot: Tauri ignores `target="_blank"` links.
#[tauri::command(async)]
pub fn mirelo_open_page(page: String) -> Result<(), CommandError> {
    let url = match page.as_str() {
        "privacy" => "https://mirelo.ai/privacy",
        "terms" => "https://mirelo.ai/terms",
        _ => return Err(error("Unknown provider page.")),
    };
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler");
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = std::process::Command::new("xdg-open");
    // The openers return once the browser has the URL; waiting reaps the child.
    match command.arg(url).status() {
        Ok(status) if status.success() => Ok(()),
        _ => Err(error(format!("Could not open a browser. Visit {url}."))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn quote() -> Quote {
        Quote {
            asset_id: "asset-1".into(),
            duration_ms: 3000,
            credits: 8,
            estimated_ms: 6000,
        }
    }
    #[test]
    fn validates_audio_and_instrument_conditioning() {
        assert!(validate_audio(&[], 1, "audio/wav").is_err());
        assert!(validate_audio(&[1], MAX_DURATION_MS + 1, "audio/wav").is_err());
        assert!(validate_audio(&[1], 1, "audio/aiff").is_err());
        assert!(payload(&quote(), &["guitar".into()]).is_err());
        let p = payload(
            &quote(),
            &["distorted_electric_guitar".into(), "drums".into()],
        )
        .unwrap();
        assert_eq!(p["instruments"][0], "distorted_electric_guitar");
        assert_eq!(p["timing"], "quantized");
        assert!(payload(&quote(), &[]).unwrap().get("instruments").is_none());
    }
    #[test]
    fn reads_numeric_note_fields_and_rejects_out_of_range_notes() {
        let notes: Vec<Note> = serde_json::from_str(
            r#"[{"pitch":60.0,"start":0,"end":0.5,"instrument":"drums","velocity":90.5},
                {"pitch":64,"start":0.5,"end":1}]"#,
        )
        .unwrap();
        assert!(notes.iter().all(Note::is_valid));
        let bad = |json: &str| !serde_json::from_str::<Note>(json).unwrap().is_valid();
        assert!(bad(r#"{"pitch":128,"start":0,"end":1}"#));
        assert!(bad(r#"{"pitch":60,"start":0,"end":1,"velocity":200}"#));
        assert!(bad(r#"{"pitch":60,"start":1,"end":0.5}"#));
    }
    #[test]
    fn opens_only_known_provider_pages() {
        assert!(mirelo_open_page("https://evil.example".into()).is_err());
    }
    #[test]
    fn journals_attempt_before_create_and_recovers_across_restart() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("pending.json");
        let store = JobStore::new(path.clone());
        let guard = store.claim().unwrap();
        assert!(store.claim().is_err());
        assert!(store.discard().is_err());
        store.begin(quote()).unwrap();
        drop(guard);
        assert!(store.begin(quote()).is_err());
        let restarted = JobStore::new(path.clone());
        assert!(restarted.read().unwrap().unwrap().job_url.is_none());
        assert!(restarted.begin(quote()).is_err());
        restarted
            .write(Some(Pending {
                quote: quote(),
                job_url: Some("https://api.mirelo.ai/v2/audio-to-midi/v1.0/jobs/one".into()),
            }))
            .unwrap();
        assert!(
            JobStore::new(path)
                .read()
                .unwrap()
                .unwrap()
                .job_url
                .is_some()
        );
        restarted.write(None).unwrap();
        restarted.begin(quote()).unwrap();
    }
    #[test]
    fn rejects_credential_leaks_and_insecure_urls() {
        assert!(job_url("https://evil.example/v2/audio-to-midi/v1.0/jobs/one").is_err());
        assert!(job_url("http://api.mirelo.ai/v2/audio-to-midi/v1.0/jobs/one").is_err());
        assert!(secure_url("https://user:password@example.com/file").is_err());
        assert!(job_url("/v2/audio-to-midi/v1.0/jobs/one").is_ok());
    }
    #[test]
    fn quotes_support_unmetered_and_nullable_provisioning() {
        let p: Preflight = serde_json::from_str(r#"{"credits":8,"credit_shortfall":0,"provisioning_state":null,"estimated_ms":1000,"billing_mode":"unmetered"}"#).unwrap();
        assert!(affordable(&p).is_ok());
        assert_eq!(
            failure_message(429, ""),
            "Mirelo's rate or concurrent-job limit was reached. Wait before trying again."
        );
    }
}
