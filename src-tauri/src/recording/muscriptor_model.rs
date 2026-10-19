//! The MuScriptor model files (issue #150): where they are, the one-time download and the
//! record of the user's acceptance. The weights are CC BY-NC 4.0 and never ship with the app and
//! are never hosted by Smart Beat: they come straight from the GGUF mirror on Hugging Face at a
//! pinned revision, are checked against the sizes and SHA-256 sums below, and stay in the app's
//! data folder. The download and the transcription both refuse to run until the user accepted the
//! terms and confirmed that they only use music they have the rights to (`terms.json`).

use super::error;
use crate::error::CommandError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// The revision of `DamRsn/muscriptor-gguf` the sizes and sums below belong to.
pub const REVISION: &str = "d7045f94e8b19427f4ff9542975035e66596e51c";
const BASE_URL: &str = "https://huggingface.co/DamRsn/muscriptor-gguf/resolve/";
const FOLDER: &str = "models/muscriptor";
const TERMS_FILE: &str = "terms.json";
const PROGRESS_EVENT: &str = "muscriptor-model-download-progress";
/// Bump when the terms the user accepts change; everyone then has to accept again.
pub const TERMS_VERSION: u32 = 1;
const STOPPED: &str = "Download stopped.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Size {
    Small,
    Medium,
    Large,
}
impl Size {
    pub const ALL: [Size; 3] = [Size::Small, Size::Medium, Size::Large];
    pub fn file(self) -> &'static str {
        match self {
            Self::Small => "muscriptor-small-f16.gguf",
            Self::Medium => "muscriptor-medium-f16.gguf",
            Self::Large => "muscriptor-large-f16.gguf",
        }
    }
    pub fn bytes(self) -> u64 {
        match self {
            Self::Small => 209_425_152,
            Self::Medium => 618_442_496,
            Self::Large => 2_739_142_176,
        }
    }
    pub fn sha256(self) -> &'static str {
        match self {
            Self::Small => "925f55af65a20ebc4f8b45ceaf095a12b72493d436cb112623cd0041a1af23d4",
            Self::Medium => "3850cc9e5b436b17a09bd25b8f2615cb3366ab96a71e7b50f73a793a917fdf03",
            Self::Large => "35a750fb1ab1e77195cdc2c0b9b4aeea2f4d59f11f729f02af9920c4854ef72e",
        }
    }
    fn url(self) -> String {
        format!("{BASE_URL}{REVISION}/v1/{}", self.file())
    }
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|size| value.trim().eq_ignore_ascii_case(size.name()))
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::Medium => "medium",
            Self::Large => "large",
        }
    }
}

/// The folder the model files live in.
pub fn dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, CommandError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| error(format!("Could not find the app's data folder: {e}")))?;
    Ok(base.join(FOLDER))
}

/// The file is there with the right size. The sum was checked when it was downloaded.
pub fn is_installed(dir: &Path, size: Size) -> bool {
    std::fs::metadata(dir.join(size.file())).is_ok_and(|m| m.is_file() && m.len() == size.bytes())
}

/// What the user accepted and when. Only the fixed fields, no free text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Terms {
    pub version: u32,
    pub rights_confirmed: bool,
    /// Seconds since the Unix epoch.
    pub accepted_at: u64,
}
fn read_terms(dir: &Path) -> Option<Terms> {
    let text = std::fs::read_to_string(dir.join(TERMS_FILE)).ok()?;
    let terms: Terms = serde_json::from_str(&text).ok()?;
    (terms.version == TERMS_VERSION && terms.rights_confirmed).then_some(terms)
}
/// The check every download and transcription goes through, not only the dialog.
pub fn require_terms(dir: &Path) -> Result<(), CommandError> {
    read_terms(dir).map(|_| ()).ok_or_else(|| {
        error("Accept the MuScriptor terms and confirm your rights to the music first.")
    })
}
fn write_terms(dir: &Path, rights_confirmed: bool) -> Result<(), CommandError> {
    if !rights_confirmed {
        return Err(error(
            "Confirm that you only use music you have the rights to.",
        ));
    }
    std::fs::create_dir_all(dir)
        .map_err(|e| error(format!("Could not make a folder for the model: {e}")))?;
    let terms = Terms {
        version: TERMS_VERSION,
        rights_confirmed,
        accepted_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs()),
    };
    let text = serde_json::to_string(&terms).expect("terms serialize");
    std::fs::write(dir.join(TERMS_FILE), text)
        .map_err(|e| error(format!("Could not save your acceptance: {e}")))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeStatus {
    pub size: Size,
    /// The download, in bytes.
    pub bytes: u64,
    pub installed: bool,
    /// Bytes of an interrupted download that a new one continues from.
    pub partial_bytes: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub terms_accepted: bool,
    pub terms_version: u32,
    pub sizes: Vec<SizeStatus>,
}
pub fn status_of(dir: &Path) -> Status {
    Status {
        terms_accepted: read_terms(dir).is_some(),
        terms_version: TERMS_VERSION,
        sizes: Size::ALL
            .into_iter()
            .map(|size| SizeStatus {
                size,
                bytes: size.bytes(),
                installed: is_installed(dir, size),
                partial_bytes: std::fs::metadata(dir.join(size.file()).with_extension("part"))
                    .map_or(0, |m| m.len().min(size.bytes())),
            })
            .collect(),
    }
}

/// The stop switch of the running download.
#[derive(Default)]
pub struct DownloadRun(Mutex<Option<Arc<AtomicBool>>>);

/// One download at a time, for the whole app.
static DOWNLOADING: Mutex<()> = Mutex::new(());

fn sum_hex(hasher: Sha256) -> String {
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// How often and how patiently a download asks again after a 5xx answer or a dropped connection.
#[derive(Debug, Clone, Copy)]
pub struct Retries {
    pub times: u32,
    pub pause: Duration,
}

/// How a request ended.
enum Attempt {
    Done,
    /// A network error or a 5xx answer: worth another try.
    Retry(String),
}

/// Downloads `url` to `dest` and checks size and SHA-256. Continues an earlier `.part` file with an
/// HTTP `Range` request. The file appears under its name only when it is complete and right; a
/// wrong file is deleted. A 5xx answer or a dropped connection is retried `retries` times after
/// `retries.pause`. `on_bytes` gets the bytes saved so far.
pub fn download_file(
    url: &str,
    dest: &Path,
    bytes: u64,
    sha256: &str,
    retries: Retries,
    on_bytes: &mut dyn FnMut(u64),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), CommandError> {
    let partial = dest.with_extension("part");
    let mut failure = String::new();
    for attempt in 0..=retries.times {
        if attempt > 0 {
            std::thread::sleep(retries.pause * attempt);
        }
        match fetch(url, &partial, bytes, on_bytes, cancelled)? {
            Attempt::Done => return finish(&partial, dest, bytes, sha256),
            Attempt::Retry(why) => failure = why,
        }
    }
    Err(error(format!(
        "Could not download the MuScriptor model: {failure}. Try again to continue where it stopped."
    )))
}

fn fetch(
    url: &str,
    partial: &Path,
    bytes: u64,
    on_bytes: &mut dyn FnMut(u64),
    cancelled: &dyn Fn() -> bool,
) -> Result<Attempt, CommandError> {
    let io = |e: std::io::Error| error(format!("Could not save the MuScriptor model: {e}"));
    let have = std::fs::metadata(partial).map_or(0, |m| m.len());
    if have > bytes {
        let _ = std::fs::remove_file(partial);
        return fetch(url, partial, bytes, on_bytes, cancelled);
    }
    if have == bytes {
        return Ok(Attempt::Done);
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_recv_response(Some(Duration::from_secs(60)))
        .timeout_recv_body(Some(Duration::from_secs(60)))
        .build()
        .into();
    let mut request = agent.get(url);
    if have > 0 {
        request = request.header("Range", format!("bytes={have}-"));
    }
    let mut response = match request.call() {
        Ok(response) => response,
        Err(e) => return Ok(Attempt::Retry(e.to_string())),
    };
    let status = response.status().as_u16();
    let mut resumed = have;
    match status {
        206 => {}
        200 => resumed = 0,
        416 => {
            // The part file is not a prefix of this file any more. Start again.
            let _ = std::fs::remove_file(partial);
            return fetch(url, partial, bytes, on_bytes, cancelled);
        }
        500..=599 => return Ok(Attempt::Retry(format!("the server answered {status}"))),
        _ => {
            return Err(error(format!(
                "Could not download the MuScriptor model: the server answered {status}."
            )));
        }
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed > 0)
        .truncate(resumed == 0)
        .open(partial)
        .map_err(io)?;
    let mut reader = response.body_mut().as_reader();
    let mut done = resumed;
    let mut chunk = vec![0u8; 256 * 1024];
    while done < bytes {
        if cancelled() {
            file.flush().map_err(io)?;
            return Err(error(STOPPED));
        }
        let n = match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                file.flush().map_err(io)?;
                return Ok(Attempt::Retry(e.to_string()));
            }
        };
        let n = n.min((bytes - done) as usize);
        file.write_all(&chunk[..n]).map_err(io)?;
        done += n as u64;
        on_bytes(done);
    }
    file.flush().map_err(io)?;
    if done < bytes {
        return Ok(Attempt::Retry("the connection closed early".into()));
    }
    Ok(Attempt::Done)
}

fn finish(partial: &Path, dest: &Path, bytes: u64, sha256: &str) -> Result<(), CommandError> {
    let io = |e: std::io::Error| error(format!("Could not save the MuScriptor model: {e}"));
    let mut file = std::fs::File::open(partial).map_err(io)?;
    let (mut hasher, mut size) = (Sha256::new(), 0u64);
    let mut chunk = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut chunk).map_err(io)?;
        if n == 0 {
            break;
        }
        hasher.update(&chunk[..n]);
        size += n as u64;
    }
    if size != bytes || sum_hex(hasher) != sha256 {
        let _ = std::fs::remove_file(partial);
        return Err(error(
            "The downloaded MuScriptor model is not the expected file, so it was deleted. Try again later.",
        ));
    }
    std::fs::rename(partial, dest).map_err(io)
}

/// Downloads `size` into `folder` unless it is there. A second call waits for the first.
pub fn download_size(
    folder: &Path,
    base: &str,
    size: Size,
    on_progress: &mut dyn FnMut(u64),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), CommandError> {
    let _only_one = DOWNLOADING.lock().unwrap_or_else(|e| e.into_inner());
    std::fs::create_dir_all(folder)
        .map_err(|e| error(format!("Could not make a folder for the model: {e}")))?;
    let dest = folder.join(size.file());
    if is_installed(folder, size) {
        on_progress(size.bytes());
        return Ok(());
    }
    let url = if base.is_empty() {
        size.url()
    } else {
        format!("{base}{}", size.file())
    };
    download_file(
        &url,
        &dest,
        size.bytes(),
        size.sha256(),
        Retries {
            times: 3,
            pause: Duration::from_secs(2),
        },
        on_progress,
        cancelled,
    )
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    size: Size,
    fraction: f32,
    bytes: u64,
}

#[tauri::command]
pub fn muscriptor_status<R: Runtime>(app: AppHandle<R>) -> Result<Status, CommandError> {
    Ok(status_of(&dir(&app)?))
}

/// Records the acceptance of the terms and the confirmation that the user only uses music they
/// have the rights to.
#[tauri::command]
pub fn accept_muscriptor_terms<R: Runtime>(
    app: AppHandle<R>,
    rights_confirmed: bool,
) -> Result<Status, CommandError> {
    let folder = dir(&app)?;
    write_terms(&folder, rights_confirmed)?;
    Ok(status_of(&folder))
}

/// Downloads a size (`small`, `medium` or `large`). Emits `muscriptor-model-download-progress`.
#[tauri::command]
pub async fn download_muscriptor_model<R: Runtime>(
    app: AppHandle<R>,
    run: State<'_, DownloadRun>,
    size: String,
) -> Result<Status, CommandError> {
    let size = Size::parse(&size).ok_or_else(|| error("Choose small, medium or large."))?;
    let folder = dir(&app)?;
    require_terms(&folder)?;
    let stop = Arc::new(AtomicBool::new(false));
    if let Some(old) = run
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .replace(stop.clone())
    {
        old.store(true, Ordering::Relaxed);
    }
    let worker = {
        let (folder, stop, app) = (folder.clone(), stop.clone(), app.clone());
        tauri::async_runtime::spawn_blocking(move || {
            let mut last = -1.0f32;
            download_size(
                &folder,
                "",
                size,
                &mut |done| {
                    let fraction = done as f32 / size.bytes() as f32;
                    if fraction - last >= 0.005 || fraction >= 1.0 {
                        last = fraction;
                        let _ = app.emit(
                            PROGRESS_EVENT,
                            Progress {
                                size,
                                fraction,
                                bytes: done,
                            },
                        );
                    }
                },
                &|| stop.load(Ordering::Relaxed),
            )
        })
    };
    let result = worker.await;
    let mut slot = run.0.lock().unwrap_or_else(|e| e.into_inner());
    if slot.as_ref().is_some_and(|c| Arc::ptr_eq(c, &stop)) {
        *slot = None;
    }
    drop(slot);
    result.map_err(|_| error("Could not download the MuScriptor model."))??;
    Ok(status_of(&folder))
}

/// Stops the running download. The part already saved is kept, so the next download continues.
#[tauri::command]
pub fn cancel_muscriptor_download(run: State<'_, DownloadRun>) {
    if let Some(stop) = run.0.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        stop.store(true, Ordering::Relaxed);
    }
}

/// Deletes a downloaded size and any part of it.
#[tauri::command]
pub fn delete_muscriptor_model<R: Runtime>(
    app: AppHandle<R>,
    size: String,
) -> Result<Status, CommandError> {
    let size = Size::parse(&size).ok_or_else(|| error("Choose small, medium or large."))?;
    let folder = dir(&app)?;
    let file = folder.join(size.file());
    for path in [file.clone(), file.with_extension("part")] {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(error(format!("Could not delete the model: {e}"))),
        }
    }
    Ok(status_of(&folder))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    const BODY: &[u8] = b"0123456789abcdefghij";

    /// Serves `BODY` with Range support. `failures` first answers 503.
    fn serve(failures: usize, honour_range: bool) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let mut left = failures;
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut request = [0u8; 2048];
                let n = stream.read(&mut request).unwrap_or(0);
                let text = String::from_utf8_lossy(&request[..n]).to_ascii_lowercase();
                if left > 0 {
                    left -= 1;
                    let _ = stream.write_all(
                        b"HTTP/1.1 503 Busy\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                    continue;
                }
                let start = text
                    .split("range: bytes=")
                    .nth(1)
                    .and_then(|r| r.split('-').next())
                    .and_then(|r| r.trim().parse::<usize>().ok())
                    .filter(|_| honour_range);
                let (head, body) = match start {
                    Some(start) => (
                        format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            BODY.len() - start
                        ),
                        &BODY[start..],
                    ),
                    None => (
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            BODY.len()
                        ),
                        BODY,
                    ),
                };
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body);
            }
        });
        format!("http://{address}/file")
    }
    fn sum() -> String {
        sum_hex(Sha256::new().chain_update(BODY))
    }
    fn get(url: &str, dest: &Path, sha: &str) -> Result<(), CommandError> {
        download_file(
            url,
            dest,
            BODY.len() as u64,
            sha,
            Retries {
                times: 2,
                pause: Duration::from_millis(1),
            },
            &mut |_| {},
            &|| false,
        )
    }

    #[test]
    fn the_sizes_match_the_published_files() {
        assert_eq!(Size::Small.bytes(), 209_425_152);
        assert!(Size::ALL.iter().all(|s| s.sha256().len() == 64));
        assert!(Size::Medium.url().contains(REVISION));
        assert!(Size::Medium.url().starts_with(BASE_URL));
        assert_eq!(Size::parse(" Large "), Some(Size::Large));
        assert_eq!(Size::parse("huge"), None);
    }

    #[test]
    fn nothing_runs_before_the_terms_are_accepted() {
        let dir = tempfile::tempdir().unwrap();
        assert!(require_terms(dir.path()).is_err());
        assert!(!status_of(dir.path()).terms_accepted);
        assert!(write_terms(dir.path(), false).is_err());
        assert!(require_terms(dir.path()).is_err());
        write_terms(dir.path(), true).unwrap();
        assert!(require_terms(dir.path()).is_ok());
        assert!(status_of(dir.path()).terms_accepted);
    }

    #[test]
    fn terms_of_an_older_version_must_be_accepted_again() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(TERMS_FILE),
            r#"{"version":0,"rightsConfirmed":true,"acceptedAt":1}"#,
        )
        .unwrap();
        assert!(require_terms(dir.path()).is_err());
        std::fs::write(
            dir.path().join(TERMS_FILE),
            format!(r#"{{"version":{TERMS_VERSION},"rightsConfirmed":false,"acceptedAt":1}}"#),
        )
        .unwrap();
        assert!(require_terms(dir.path()).is_err());
    }

    #[test]
    fn a_short_file_is_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_installed(dir.path(), Size::Small));
        std::fs::write(dir.path().join(Size::Small.file()), b"short").unwrap();
        assert!(!is_installed(dir.path(), Size::Small));
    }

    #[test]
    fn a_good_download_appears_under_its_name() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.gguf");
        get(&serve(0, true), &dest, &sum()).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), BODY);
        assert!(!dest.with_extension("part").exists());
    }

    #[test]
    fn an_interrupted_download_continues_with_a_range_request() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.gguf");
        std::fs::write(dest.with_extension("part"), &BODY[..8]).unwrap();
        get(&serve(0, true), &dest, &sum()).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), BODY);
    }

    #[test]
    fn a_server_that_ignores_range_restarts_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.gguf");
        std::fs::write(dest.with_extension("part"), &BODY[..8]).unwrap();
        get(&serve(0, false), &dest, &sum()).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), BODY);
    }

    #[test]
    fn a_busy_server_is_asked_again() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.gguf");
        get(&serve(2, true), &dest, &sum()).unwrap();
        assert!(dest.exists());
        let dest = dir.path().join("b.gguf");
        let err = get(&serve(5, true), &dest, &sum()).unwrap_err();
        assert!(err.message.contains("Could not download"));
        assert!(!dest.exists());
    }

    #[test]
    fn a_wrong_file_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.gguf");
        let err = get(&serve(0, true), &dest, &"0".repeat(64)).unwrap_err();
        assert!(err.message.contains("not the expected file"));
        assert!(!dest.exists() && !dest.with_extension("part").exists());
    }

    #[test]
    fn stopping_keeps_the_part_for_the_next_try() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.gguf");
        let err = download_file(
            &serve(0, true),
            &dest,
            BODY.len() as u64,
            &sum(),
            Retries {
                times: 0,
                pause: Duration::ZERO,
            },
            &mut |_| {},
            &|| true,
        )
        .unwrap_err();
        assert_eq!(err.message, STOPPED);
        assert!(!dest.exists());
    }

    #[test]
    fn no_server_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = get(
            "http://127.0.0.1:9/none",
            &dir.path().join("a.gguf"),
            &sum(),
        )
        .unwrap_err();
        assert!(err.message.contains("Could not download"));
    }
}
