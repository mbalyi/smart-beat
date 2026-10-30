//! The optional Open-Unmix UMX-HQ model files (issue #186): where they are, the one-time download
//! and the record of the user's acceptance. The weights never ship with the app and are never
//! hosted or mirrored by Smart Beat: the four files come straight from Zenodo (record 3370489),
//! are checked against the sizes and SHA-256 sums below and stay in the app's data folder. The
//! download refuses to start, and the model counts as unusable, until the user accepted the terms
//! (`terms.json`) and confirmed that they only use music they have the rights to.
//!
//! Whether this download is offered at all is the owner's decision; the UI keeps it behind the
//! `stem-separation-neural` feature flag.

use crate::error::{CommandError, ErrorKind};
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

/// Folder (inside the app data folder) of the downloaded model.
pub const FOLDER: &str = "models/umx-hq";
/// Where the files are. The file name and `DOWNLOAD_QUERY` follow it.
const BASE_URL: &str = "https://zenodo.org/records/3370489/files/";
const DOWNLOAD_QUERY: &str = "?download=1";
const TERMS_FILE: &str = "terms.json";
const PROGRESS_EVENT: &str = "umx-model-download-progress";
/// Bump when the terms the user accepts change; everyone then has to accept again.
pub const TERMS_VERSION: u32 = 1;
const STOPPED: &str = "Download stopped.";

/// One weight file: its name on Zenodo, exact size and SHA-256.
#[derive(Debug, Clone, Copy)]
pub struct Spec<'a> {
    pub name: &'a str,
    pub bytes: u64,
    pub sha256: &'a str,
}

/// The four files of UMX-HQ (one network per target), 35,637,796 bytes each.
pub const FILES: [Spec<'static>; 4] = [
    Spec {
        name: "drums-9619578f.pth",
        bytes: 35_637_796,
        sha256: "9619578f885c54737cb0234f9f9a4a679ee4f31438fd77fd1dbe02bb16c2da0a",
    },
    Spec {
        name: "bass-8d85a5bd.pth",
        bytes: 35_637_796,
        sha256: "8d85a5bd3f996a8867fca0e8442e077e5a3f5ec747a6112742452a8f347b39c8",
    },
    Spec {
        name: "vocals-b62c91ce.pth",
        bytes: 35_637_796,
        sha256: "b62c91cedbc7a066f1778ead5b5cecb377aa3a46a31af1cce7c5c8769339d083",
    },
    Spec {
        name: "other-b52fbbf7.pth",
        bytes: 35_637_796,
        sha256: "b52fbbf76479e752bd72e02304c602ac7802aa5bfbfb9cd12054b2695d5093ab",
    },
];

/// What the user reads before the download and accepts. Paragraphs are separated by a blank line.
/// Change the facts here only together with `docs/licensing.md` and bump `TERMS_VERSION`.
pub const TERMS_TEXT: &str = "\
Open-Unmix UMX-HQ is a neural network that splits a song into drums, bass, vocals and the rest. \
It was made by Fabian-Robert Stöter, Stefan Uhlich, Antoine Liutkus and Yuki Mitsufuji. The \
Open-Unmix code is under the MIT licence.

Smart Beat does not include, host or mirror the model. When you press Download, this computer \
fetches four files (about 143 MB in total) straight from Zenodo, record 3370489. Each file is \
checked against a fixed size and SHA-256 sum before it is kept. The files stay in Smart Beat's \
data folder and you can delete them at any time. Separating a song then runs on this computer; \
nothing is uploaded.

Zenodo lists the licence of these weights as MIT. The model was trained on MUSDB18-HQ. The terms \
of that dataset (Zenodo record 3338373, licence field other-nc) say the tracks are \"provided for \
educational purposes only\" and \"should not be used for any commercial purpose without the \
express permission of the copyright holders\". The authors of Open-Unmix do not say whether those \
terms reach the weights.

By accepting you confirm that you only use music you have the rights to.";

/// A short line for lists and the model card.
pub const LICENCE_SUMMARY: &str = "Code MIT. Weights listed on Zenodo as MIT; trained on MUSDB18-HQ, whose own terms say educational use only. The authors do not say whether those terms reach the weights.";

fn error(kind: ErrorKind, message: impl Into<String>) -> CommandError {
    CommandError::new(kind, message)
}
fn io_error(what: &str, e: std::io::Error) -> CommandError {
    error(ErrorKind::Io, format!("{what}: {e}"))
}

/// The folder the model files live in.
pub fn model_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(FOLDER))
        .map_err(|e| e.to_string())
}

/// All four weight files are present and complete, and the user accepted the terms.
pub fn is_ready<R: Runtime>(app: &AppHandle<R>) -> bool {
    model_dir(app).is_ok_and(|dir| ready_in(&dir, &FILES))
}

/// Every file is there with the right size. The sum was checked when it was downloaded.
fn files_present(dir: &Path, files: &[Spec]) -> bool {
    files.iter().all(|f| {
        std::fs::metadata(dir.join(f.name)).is_ok_and(|m| m.is_file() && m.len() == f.bytes)
    })
}
fn ready_in(dir: &Path, files: &[Spec]) -> bool {
    files_present(dir, files) && terms_accepted(dir)
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
fn terms_accepted(dir: &Path) -> bool {
    read_terms(dir).is_some()
}
fn require_terms(dir: &Path) -> Result<(), CommandError> {
    if terms_accepted(dir) {
        Ok(())
    } else {
        Err(error(
            ErrorKind::Io,
            "Accept the Open-Unmix terms and confirm your rights to the music first.",
        ))
    }
}
fn write_terms(dir: &Path) -> Result<(), CommandError> {
    std::fs::create_dir_all(dir)
        .map_err(|e| io_error("Could not make a folder for the model", e))?;
    let terms = Terms {
        version: TERMS_VERSION,
        rights_confirmed: true,
        accepted_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs()),
    };
    let text = serde_json::to_string(&terms).expect("terms serialize");
    std::fs::write(dir.join(TERMS_FILE), text)
        .map_err(|e| io_error("Could not save your acceptance", e))
}

/// What the dialog shows about the model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UmxStatus {
    /// All four files are on this computer, complete.
    pub downloaded: bool,
    /// The user accepted the current terms and confirmed their rights.
    pub terms_accepted: bool,
    pub terms_version: u32,
    /// The size of the whole download, in bytes.
    pub download_bytes: u64,
    /// The terms the user accepts (see `TERMS_TEXT`).
    pub licence: String,
}
fn status_of(dir: &Path, files: &[Spec]) -> UmxStatus {
    UmxStatus {
        downloaded: files_present(dir, files),
        terms_accepted: terms_accepted(dir),
        terms_version: TERMS_VERSION,
        download_bytes: files.iter().map(|f| f.bytes).sum(),
        licence: TERMS_TEXT.to_string(),
    }
}

/// The stop switch of the running download.
#[derive(Default)]
pub struct DownloadRun(Mutex<Option<Arc<AtomicBool>>>);
impl DownloadRun {
    /// Stops the running download, if any. The part already saved is deleted.
    pub fn stop(&self) {
        if let Some(stop) = self.0.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            stop.store(true, Ordering::Relaxed);
        }
    }
}

/// One download at a time, for the whole app.
static DOWNLOADING: Mutex<()> = Mutex::new(());

fn sum_hex(hasher: Sha256) -> String {
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn part_of(dest: &Path) -> PathBuf {
    let mut name = dest.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

/// Downloads one file to `dest` through a `.part` file. The file appears under its name only when
/// it has exactly `spec.bytes` bytes and the right SHA-256; a wrong file is deleted. `on_bytes`
/// gets the bytes of this file saved so far. Stopping deletes the `.part` file.
fn download_file(
    url: &str,
    dest: &Path,
    spec: &Spec,
    on_bytes: &mut dyn FnMut(u64),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), CommandError> {
    let partial = part_of(dest);
    let result = fetch(url, &partial, spec, on_bytes, cancelled);
    match result {
        Ok(()) => std::fs::rename(&partial, dest).map_err(|e| {
            let _ = std::fs::remove_file(&partial);
            io_error("Could not save the Open-Unmix model", e)
        }),
        Err(e) => {
            let _ = std::fs::remove_file(&partial);
            Err(e)
        }
    }
}

fn fetch(
    url: &str,
    partial: &Path,
    spec: &Spec,
    on_bytes: &mut dyn FnMut(u64),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), CommandError> {
    let network = |why: String| {
        error(
            ErrorKind::Network,
            format!("Could not download the Open-Unmix model: {why}. Try again."),
        )
    };
    let save = |e: std::io::Error| io_error("Could not save the Open-Unmix model", e);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_recv_response(Some(Duration::from_secs(60)))
        .timeout_recv_body(Some(Duration::from_secs(60)))
        .build()
        .into();
    if cancelled() {
        return Err(error(ErrorKind::Io, STOPPED));
    }
    let mut response = agent.get(url).call().map_err(|e| network(e.to_string()))?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(network(format!("the server answered {status}")));
    }
    let mut file = std::fs::File::create(partial).map_err(save)?;
    let mut reader = response.body_mut().as_reader();
    let (mut hasher, mut done) = (Sha256::new(), 0u64);
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        if cancelled() {
            return Err(error(ErrorKind::Io, STOPPED));
        }
        let n = reader
            .read(&mut chunk)
            .map_err(|e| network(e.to_string()))?;
        if n == 0 {
            break;
        }
        done += n as u64;
        if done > spec.bytes {
            break;
        }
        hasher.update(&chunk[..n]);
        file.write_all(&chunk[..n]).map_err(save)?;
        on_bytes(done);
    }
    file.flush().map_err(save)?;
    if done != spec.bytes || sum_hex(hasher) != spec.sha256 {
        return Err(error(
            ErrorKind::Io,
            "A downloaded Open-Unmix file is not the expected file, so it was deleted. Try again later.",
        ));
    }
    Ok(())
}

/// Downloads every file of `files` into `dir` that is not there yet, from `base` + name + query.
/// Refuses until the terms are accepted. `on_progress` gets (bytes of the whole download so far,
/// bytes in total). A second call waits for the first.
fn download_all(
    dir: &Path,
    base: &str,
    files: &[Spec],
    on_progress: &mut dyn FnMut(u64, u64),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), CommandError> {
    require_terms(dir)?;
    let _only_one = DOWNLOADING.lock().unwrap_or_else(|e| e.into_inner());
    std::fs::create_dir_all(dir)
        .map_err(|e| io_error("Could not make a folder for the model", e))?;
    let total: u64 = files.iter().map(|f| f.bytes).sum();
    let mut before = 0u64;
    for spec in files {
        let dest = dir.join(spec.name);
        let present = std::fs::metadata(&dest).is_ok_and(|m| m.is_file() && m.len() == spec.bytes);
        if !present {
            let url = format!("{base}{}{DOWNLOAD_QUERY}", spec.name);
            let offset = before;
            download_file(
                &url,
                &dest,
                spec,
                &mut |done| on_progress(offset + done, total),
                cancelled,
            )?;
        }
        before += spec.bytes;
        on_progress(before, total);
    }
    Ok(())
}

/// Deletes the model files and any part of them. The accepted terms stay on file.
fn remove_files(dir: &Path, files: &[Spec]) -> Result<(), CommandError> {
    for spec in files {
        let file = dir.join(spec.name);
        for path in [part_of(&file), file] {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(io_error("Could not delete the model", e)),
            }
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded_bytes: u64,
    total_bytes: u64,
}

fn folder<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, CommandError> {
    model_dir(app).map_err(|e| {
        error(
            ErrorKind::Io,
            format!("Could not find the app's data folder: {e}"),
        )
    })
}

#[tauri::command]
pub fn umx_model_status<R: Runtime>(app: AppHandle<R>) -> Result<UmxStatus, CommandError> {
    Ok(status_of(&folder(&app)?, &FILES))
}

/// Records the acceptance of the terms and the confirmation that the user only uses music they
/// have the rights to.
#[tauri::command]
pub fn umx_model_accept_terms<R: Runtime>(app: AppHandle<R>) -> Result<UmxStatus, CommandError> {
    let dir = folder(&app)?;
    write_terms(&dir)?;
    Ok(status_of(&dir, &FILES))
}

/// Downloads the four files. Emits `umx-model-download-progress`. Fails with `Download stopped.`
/// when cancelled.
#[tauri::command]
pub async fn umx_model_download<R: Runtime>(
    app: AppHandle<R>,
    run: State<'_, DownloadRun>,
) -> Result<UmxStatus, CommandError> {
    let dir = folder(&app)?;
    require_terms(&dir)?;
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
        let (dir, stop, app) = (dir.clone(), stop.clone(), app.clone());
        tauri::async_runtime::spawn_blocking(move || {
            let mut last = -1.0f64;
            download_all(
                &dir,
                BASE_URL,
                &FILES,
                &mut |done, total| {
                    let fraction = done as f64 / total.max(1) as f64;
                    if fraction - last >= 0.005 || done >= total {
                        last = fraction;
                        let _ = app.emit(
                            PROGRESS_EVENT,
                            Progress {
                                downloaded_bytes: done,
                                total_bytes: total,
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
    result.map_err(|_| error(ErrorKind::Io, "Could not download the Open-Unmix model."))??;
    Ok(status_of(&dir, &FILES))
}

/// Stops the running download. The part already saved is deleted.
#[tauri::command]
pub fn umx_model_cancel(run: State<'_, DownloadRun>) {
    run.stop();
}

/// Deletes the downloaded files and any part of them.
#[tauri::command]
pub fn umx_model_remove<R: Runtime>(app: AppHandle<R>) -> Result<UmxStatus, CommandError> {
    let dir = folder(&app)?;
    remove_files(&dir, &FILES)?;
    Ok(status_of(&dir, &FILES))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::net::TcpListener;
    use std::sync::atomic::AtomicUsize;

    /// The fixture files the local server hands out, by name.
    type Table = HashMap<String, Vec<u8>>;

    /// A server on a free local port that answers `GET /<name>?...` from `table` (404 otherwise).
    /// Returns the base URL, ending in a slash, and a counter of the requests it served.
    fn serve(table: Table) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut request = [0u8; 2048];
                let n = stream.read(&mut request).unwrap_or(0);
                let text = String::from_utf8_lossy(&request[..n]).to_string();
                let path = text
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("/")
                    .split('?')
                    .next()
                    .unwrap_or("/")
                    .trim_start_matches('/')
                    .to_string();
                counter.fetch_add(1, Ordering::Relaxed);
                match table.get(&path) {
                    Some(body) => {
                        let head = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(head.as_bytes());
                        let _ = stream.write_all(body);
                    }
                    None => {
                        let _ = stream.write_all(
                            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                    }
                }
            }
        });
        (format!("http://{address}/"), hits)
    }

    fn sum(body: &[u8]) -> String {
        sum_hex(Sha256::new().chain_update(body))
    }

    /// Four small fixture files: (names, bodies, sums). Different content and length each.
    struct Fixture {
        names: [String; 4],
        bodies: [Vec<u8>; 4],
        sums: [String; 4],
    }
    impl Fixture {
        fn new() -> Self {
            let names = ["drums.pth", "bass.pth", "vocals.pth", "other.pth"].map(String::from);
            let bodies: [Vec<u8>; 4] = std::array::from_fn(|i| {
                (0..(1000 + 37 * i))
                    .map(|k| (k * 7 + i * 13) as u8)
                    .collect()
            });
            let sums = std::array::from_fn(|i| sum(&bodies[i]));
            Fixture {
                names,
                bodies,
                sums,
            }
        }
        fn specs(&self) -> Vec<Spec<'_>> {
            (0..4)
                .map(|i| Spec {
                    name: &self.names[i],
                    bytes: self.bodies[i].len() as u64,
                    sha256: &self.sums[i],
                })
                .collect()
        }
        fn table(&self) -> Table {
            (0..4)
                .map(|i| (self.names[i].clone(), self.bodies[i].clone()))
                .collect()
        }
    }

    fn download(dir: &Path, base: &str, specs: &[Spec]) -> Result<(), CommandError> {
        download_all(dir, base, specs, &mut |_, _| {}, &|| false)
    }

    #[test]
    fn the_real_table_matches_the_contract() {
        assert_eq!(FILES.len(), 4);
        for spec in FILES {
            assert_eq!(spec.bytes, 35_637_796);
            assert_eq!(spec.sha256.len(), 64);
            assert!(spec.sha256.bytes().all(|b| b.is_ascii_hexdigit()));
            // The short sum is part of the file name.
            assert!(spec.name.contains(&spec.sha256[..8]), "{}", spec.name);
        }
        let names: Vec<_> = FILES.iter().map(|f| f.name).collect();
        assert_eq!(
            names,
            [
                "drums-9619578f.pth",
                "bass-8d85a5bd.pth",
                "vocals-b62c91ce.pth",
                "other-b52fbbf7.pth"
            ]
        );
        let status = status_of(Path::new("/nonexistent-umx"), &FILES);
        assert_eq!(status.download_bytes, 142_551_184);
        assert!(BASE_URL.starts_with("https://zenodo.org/records/3370489/files/"));
    }

    #[test]
    fn the_terms_state_the_facts() {
        for needle in [
            "Open-Unmix UMX-HQ",
            "Stöter",
            "Uhlich",
            "Liutkus",
            "Mitsufuji",
            "MIT",
            "record 3370489",
            "MUSDB18-HQ",
            "record 3338373",
            "other-nc",
            "provided for educational purposes only",
            "should not be used for any commercial purpose without the express permission of the copyright holders",
            "do not say whether those terms reach the weights",
            "rights to",
        ] {
            assert!(TERMS_TEXT.contains(needle), "missing: {needle}");
        }
        assert!(TERMS_TEXT.contains("does not include, host or mirror"));
    }

    #[test]
    fn nothing_downloads_before_the_terms_are_accepted() {
        let fx = Fixture::new();
        let (base, hits) = serve(fx.table());
        let dir = tempfile::tempdir().unwrap();
        let err = download(dir.path(), &base, &fx.specs()).unwrap_err();
        assert!(err.message.contains("Accept the Open-Unmix terms"));
        assert_eq!(hits.load(Ordering::Relaxed), 0, "no request was made");
        assert!(!dir.path().join(fx.names[0].as_str()).exists());
        assert!(!terms_accepted(dir.path()));
    }

    #[test]
    fn terms_of_an_older_version_or_unconfirmed_ones_do_not_count() {
        let dir = tempfile::tempdir().unwrap();
        let record = |version: u32, confirmed: bool| {
            std::fs::write(
                dir.path().join(TERMS_FILE),
                format!(r#"{{"version":{version},"rightsConfirmed":{confirmed},"acceptedAt":1}}"#),
            )
            .unwrap();
        };
        record(TERMS_VERSION, true);
        assert!(terms_accepted(dir.path()));
        record(TERMS_VERSION - 1, true);
        assert!(!terms_accepted(dir.path()));
        record(TERMS_VERSION, false);
        assert!(!terms_accepted(dir.path()));
        std::fs::write(dir.path().join(TERMS_FILE), "not json").unwrap();
        assert!(!terms_accepted(dir.path()));
    }

    #[test]
    fn accepting_is_recorded_and_ready_needs_files_and_terms() {
        let fx = Fixture::new();
        let specs = fx.specs();
        let (base, _) = serve(fx.table());
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();

        assert!(!ready_in(d, &specs));
        write_terms(d).unwrap();
        assert!(terms_accepted(d));
        assert!(!ready_in(d, &specs), "terms alone are not enough");

        download(d, &base, &specs).unwrap();
        assert!(ready_in(d, &specs));

        // Files without the terms are not ready either.
        std::fs::remove_file(d.join(TERMS_FILE)).unwrap();
        assert!(files_present(d, &specs));
        assert!(!ready_in(d, &specs));
        write_terms(d).unwrap();
        assert!(ready_in(d, &specs));

        // A truncated file is not ready.
        std::fs::write(d.join(&fx.names[2]), b"short").unwrap();
        assert!(!ready_in(d, &specs));
    }

    #[test]
    fn a_good_download_keeps_four_verified_files_and_reports_progress() {
        let fx = Fixture::new();
        let specs = fx.specs();
        let (base, hits) = serve(fx.table());
        let dir = tempfile::tempdir().unwrap();
        write_terms(dir.path()).unwrap();
        let total: u64 = specs.iter().map(|s| s.bytes).sum();
        let mut seen = Vec::new();
        download_all(
            dir.path(),
            &base,
            &specs,
            &mut |done, all| {
                assert_eq!(all, total);
                seen.push(done);
            },
            &|| false,
        )
        .unwrap();
        for i in 0..4 {
            assert_eq!(
                std::fs::read(dir.path().join(&fx.names[i])).unwrap(),
                fx.bodies[i]
            );
            assert!(!part_of(&dir.path().join(&fx.names[i])).exists());
        }
        assert!(seen.windows(2).all(|w| w[0] <= w[1]), "progress only grows");
        assert_eq!(seen.last(), Some(&total));
        assert_eq!(hits.load(Ordering::Relaxed), 4);

        // A second run finds everything and asks for nothing.
        download(dir.path(), &base, &specs).unwrap();
        assert_eq!(hits.load(Ordering::Relaxed), 4);
    }

    #[test]
    fn a_wrong_size_is_rejected_and_the_file_deleted() {
        let fx = Fixture::new();
        let mut specs = fx.specs();
        // The table promises one byte more than the server sends.
        specs[1].bytes += 1;
        let (base, _) = serve(fx.table());
        let dir = tempfile::tempdir().unwrap();
        write_terms(dir.path()).unwrap();
        let err = download(dir.path(), &base, &specs).unwrap_err();
        assert!(err.message.contains("not the expected file"));
        let bad = dir.path().join(&fx.names[1]);
        assert!(!bad.exists() && !part_of(&bad).exists());
        // The first file was good and stays, but the model is not ready.
        assert!(dir.path().join(&fx.names[0]).exists());
        assert!(!ready_in(dir.path(), &specs));

        // The server sends more than the table says.
        let mut specs = fx.specs();
        specs[2].bytes -= 1;
        let err = download(dir.path(), &base, &specs).unwrap_err();
        assert!(err.message.contains("not the expected file"));
        let bad = dir.path().join(&fx.names[2]);
        assert!(!bad.exists() && !part_of(&bad).exists());
    }

    #[test]
    fn a_wrong_sha256_is_rejected_and_the_file_deleted() {
        let fx = Fixture::new();
        let mut specs = fx.specs();
        let wrong = "0".repeat(64);
        specs[3].sha256 = &wrong;
        let (base, _) = serve(fx.table());
        let dir = tempfile::tempdir().unwrap();
        write_terms(dir.path()).unwrap();
        let err = download(dir.path(), &base, &specs).unwrap_err();
        assert!(err.message.contains("not the expected file"));
        let bad = dir.path().join(&fx.names[3]);
        assert!(!bad.exists() && !part_of(&bad).exists());
        assert!(!ready_in(dir.path(), &specs));
    }

    #[test]
    fn a_missing_file_or_server_is_an_error_without_leftovers() {
        let fx = Fixture::new();
        let specs = fx.specs();
        let mut table = fx.table();
        table.remove(&fx.names[0]);
        let (base, _) = serve(table);
        let dir = tempfile::tempdir().unwrap();
        write_terms(dir.path()).unwrap();
        let err = download(dir.path(), &base, &specs).unwrap_err();
        assert!(err.message.contains("404"));
        assert!(!part_of(&dir.path().join(&fx.names[0])).exists());

        let err = download(dir.path(), "http://127.0.0.1:9/", &specs).unwrap_err();
        assert!(err.message.contains("Could not download"));
    }

    #[test]
    fn cancelling_stops_and_removes_the_part_file() {
        // A file larger than one read chunk, so the stop is seen between chunks.
        let body: Vec<u8> = (0..400_000u32).map(|k| (k % 251) as u8).collect();
        let name = "big.pth".to_string();
        let spec = Spec {
            name: &name,
            bytes: body.len() as u64,
            sha256: &sum(&body),
        };
        let (base, _) = serve(HashMap::from([(name.clone(), body)]));
        let dir = tempfile::tempdir().unwrap();
        write_terms(dir.path()).unwrap();
        let stop = AtomicBool::new(false);
        let err = download_all(
            dir.path(),
            &base,
            &[spec],
            &mut |done, _| {
                if done > 0 {
                    stop.store(true, Ordering::Relaxed);
                }
            },
            &|| stop.load(Ordering::Relaxed),
        )
        .unwrap_err();
        assert_eq!(err.message, STOPPED);
        let dest = dir.path().join(&name);
        assert!(!dest.exists() && !part_of(&dest).exists());
    }

    #[test]
    fn cancelling_before_the_first_byte_leaves_nothing() {
        let fx = Fixture::new();
        let specs = fx.specs();
        let (base, _) = serve(fx.table());
        let dir = tempfile::tempdir().unwrap();
        write_terms(dir.path()).unwrap();
        let err = download_all(dir.path(), &base, &specs, &mut |_, _| {}, &|| true).unwrap_err();
        assert_eq!(err.message, STOPPED);
        for name in &fx.names {
            let dest = dir.path().join(name);
            assert!(!dest.exists() && !part_of(&dest).exists());
        }
    }

    #[test]
    fn the_stop_switch_flips_only_while_a_download_runs() {
        let run = DownloadRun::default();
        run.stop();
        let flag = Arc::new(AtomicBool::new(false));
        *run.0.lock().unwrap() = Some(flag.clone());
        run.stop();
        assert!(flag.load(Ordering::Relaxed));
    }

    #[test]
    fn removing_deletes_the_files_and_parts_but_keeps_the_accepted_terms() {
        let fx = Fixture::new();
        let specs = fx.specs();
        let (base, _) = serve(fx.table());
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        write_terms(d).unwrap();
        download(d, &base, &specs).unwrap();
        std::fs::write(part_of(&d.join(&fx.names[0])), b"half").unwrap();
        assert!(ready_in(d, &specs));

        remove_files(d, &specs).unwrap();
        for name in &fx.names {
            assert!(!d.join(name).exists() && !part_of(&d.join(name)).exists());
        }
        assert!(!ready_in(d, &specs));
        assert!(terms_accepted(d), "the acceptance stays on file");
        // Removing again, with nothing there, is fine.
        remove_files(d, &specs).unwrap();
    }

    #[test]
    fn the_status_reports_each_step() {
        let fx = Fixture::new();
        let specs = fx.specs();
        let (base, _) = serve(fx.table());
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let total: u64 = specs.iter().map(|s| s.bytes).sum();

        let s = status_of(d, &specs);
        assert!(!s.downloaded && !s.terms_accepted);
        assert_eq!(s.terms_version, TERMS_VERSION);
        assert_eq!(s.download_bytes, total);
        assert_eq!(s.licence, TERMS_TEXT);

        write_terms(d).unwrap();
        let s = status_of(d, &specs);
        assert!(!s.downloaded && s.terms_accepted);

        download(d, &base, &specs).unwrap();
        let s = status_of(d, &specs);
        assert!(s.downloaded && s.terms_accepted);

        remove_files(d, &specs).unwrap();
        let s = status_of(d, &specs);
        assert!(!s.downloaded && s.terms_accepted);
    }

    #[test]
    fn the_status_serializes_in_camel_case() {
        let json = serde_json::to_value(status_of(Path::new("/nonexistent-umx"), &FILES)).unwrap();
        for key in [
            "downloaded",
            "termsAccepted",
            "termsVersion",
            "downloadBytes",
            "licence",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
        let progress = serde_json::to_value(Progress {
            downloaded_bytes: 1,
            total_bytes: 2,
        })
        .unwrap();
        assert_eq!(progress["downloadedBytes"], 1);
        assert_eq!(progress["totalBytes"], 2);
    }
}
