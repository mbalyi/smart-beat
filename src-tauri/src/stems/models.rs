//! The optional ONNX separation models (issue #186): SCNet Small, SCNet XL and HTDemucs. Each is
//! one file the user downloads once, after accepting that model's terms, into its own folder in
//! the app's data folder (`models/<id>`), and each runs through `tract` (see
//! `separation::onnx`). Nothing ships with the app.
//!
//! The file table pins the exact size and SHA-256 of every file; the download keeps a file only
//! when both match. SCNet Small is fetched from the public release of its ONNX export. The XL and
//! HTDemucs files are our own conversions of the upstream checkpoints (the upstream projects
//! only publish PyTorch files), hosted as assets of the `stem-models-v1` release of this
//! project. While [`HOSTED`] is false those two report `available: false` and refuse to
//! download, and no request is made to their address.

use super::model_files::{self, Spec};
use super::umx_model::DownloadRun;
use crate::error::{CommandError, ErrorKind};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// Event with the download progress of any of these models.
const PROGRESS_EVENT: &str = "stem-model-download-progress";
/// Bump when the terms of any model change; everyone then has to accept that model's terms again.
pub const TERMS_VERSION: u32 = 1;

/// Where the converted XL and HTDemucs files are hosted: assets of the `stem-models-v1` release
/// of this project.
const HOSTED_BASE: &str = "https://github.com/mbalyi/smart-beat/releases/download/stem-models-v1/";
/// The two converted files are published at [`HOSTED_BASE`]. Set to `false` to withdraw them
/// from the app (the download then refuses) when a rights holder raises an obligation.
const HOSTED: bool = true;

/// The public release of the SCNet Small ONNX export (demixr/scnet-executorch, tag v0.1.2).
const SCNET_BASE: &str = "https://github.com/demixr/scnet-executorch/releases/download/v0.1.2/";

/// Which model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ModelId {
    Scnet,
    ScnetXl,
    Htdemucs,
}

impl ModelId {
    pub const ALL: [ModelId; 3] = [ModelId::Scnet, ModelId::ScnetXl, ModelId::Htdemucs];

    pub fn id(self) -> &'static str {
        match self {
            Self::Scnet => "scnet",
            Self::ScnetXl => "scnet-xl",
            Self::Htdemucs => "htdemucs",
        }
    }

    pub fn parse(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|m| m.id() == id)
    }

    pub fn info(self) -> &'static Model {
        match self {
            Self::Scnet => &SCNET,
            Self::ScnetXl => &SCNET_XL,
            Self::Htdemucs => &HTDEMUCS,
        }
    }
}

/// Everything fixed about one model.
#[derive(Debug)]
pub struct Model {
    pub id: ModelId,
    /// Name in messages.
    pub label: &'static str,
    /// Folder inside the app data folder.
    pub folder: &'static str,
    /// Address the file is under (ends in a slash); the file name follows.
    pub base_url: &'static str,
    pub file: Spec<'static>,
    /// The file is published, so the download can start.
    pub available: bool,
    pub terms: &'static str,
    pub licence_summary: &'static str,
}

pub const SCNET: Model = Model {
    id: ModelId::Scnet,
    label: "SCNet Small",
    folder: "models/scnet",
    base_url: SCNET_BASE,
    file: Spec {
        name: "scnet_cpu.onnx",
        bytes: 52_271_228,
        sha256: "f2c050b7264d2b2401497beb712c26a50e6162dfb951041060f23f84929d600e",
    },
    available: true,
    terms: SCNET_TERMS,
    licence_summary: "MIT according to the author of the weights and of the ONNX export. Trained on MUSDB18-HQ, whose own terms say educational use only; the author does not say whether those terms reach the weights.",
};

pub const SCNET_XL: Model = Model {
    id: ModelId::ScnetXl,
    label: "SCNet XL",
    folder: "models/scnet-xl",
    base_url: HOSTED_BASE,
    file: Spec {
        name: "scnet_xl_core.onnx",
        bytes: 216_163_649,
        sha256: "4ee5107c1978fd68cc666aa35898c9e866fa7c7d47278086a75bf4448807f0ee",
    },
    available: HOSTED,
    terms: SCNET_XL_TERMS,
    licence_summary: "No licence is stated for these weights. Trained on MUSDB18-HQ, whose own terms say educational use only. The file is Smart Beat's conversion of the published checkpoint.",
};

pub const HTDEMUCS: Model = Model {
    id: ModelId::Htdemucs,
    label: "HTDemucs",
    folder: "models/htdemucs",
    base_url: HOSTED_BASE,
    file: Spec {
        name: "htdemucs_core.onnx",
        bytes: 176_589_623,
        sha256: "105da2c479af1f11e2f2057a9d5435f97b27b9f9d1d7c728390bf0a8ab5107ee",
    },
    available: HOSTED,
    terms: HTDEMUCS_TERMS,
    licence_summary: "Code MIT; no licence is stated for the weights. Trained on MUSDB18-HQ and 800 private songs. The file is Smart Beat's conversion of the published checkpoint.",
};

/// What the user reads before the download and accepts. Paragraphs are separated by a blank line.
/// Change the facts here only together with `docs/licensing.md` and bump `TERMS_VERSION`.
const SCNET_TERMS: &str = "\
SCNet (Sparse Compression Network) is a neural network that splits a song into drums, bass, \
vocals and the rest. It was made by Weinan Tong and colleagues. This is the Small model, in the \
ONNX export published by the demixr project (scnet-executorch, release v0.1.2). The author of \
the weights and of the export gives them under the MIT licence.

Smart Beat does not include, host or mirror the model. When you press Download, this computer \
fetches one file (about 52 MB) straight from the GitHub release of that project. The file is \
checked against a fixed size and SHA-256 sum before it is kept. It stays in Smart Beat's data \
folder and you can delete it at any time. Separating a song then runs on this computer; \
nothing is uploaded.

The model was trained on MUSDB18-HQ. The terms of that dataset (Zenodo record 3338373, licence \
field other-nc) say the tracks are \"provided for educational purposes only\" and \"should not \
be used for any commercial purpose without the express permission of the copyright holders\". \
The author does not say whether those terms reach the weights.

By accepting you confirm that you only use music you have the rights to.";

const SCNET_XL_TERMS: &str = "\
SCNet (Sparse Compression Network) is a neural network that splits a song into drums, bass, \
vocals and the rest. It was made by Weinan Tong and colleagues. The XL checkpoint was trained \
and published by ZFTurbo in the Music-Source-Separation-Training project (release v1.0.15).

The authors publish that checkpoint as a PyTorch file only. The Smart Beat project converted it \
to ONNX so the app can run it, and hosts the converted file (about 216 MB) as an asset of a \
release on its own GitHub page. When you press Download, this computer fetches that file and \
checks it against a fixed size and SHA-256 sum before it is kept. It stays in Smart Beat's data folder and you \
can delete it at any time. Separating a song then runs on this computer; nothing is uploaded. \
It is slow and needs about 3.5 GB of memory.

The authors do not state a licence for these weights. The model was trained on MUSDB18-HQ. The \
terms of that dataset (Zenodo record 3338373, licence field other-nc) say the tracks are \
\"provided for educational purposes only\" and \"should not be used for any commercial purpose \
without the express permission of the copyright holders\". The authors do not say whether those \
terms reach the weights. If a rights holder raises an obligation, the Smart Beat project removes \
the hosted file and the download stops working.

By accepting you confirm that you only use music you have the rights to.";

const HTDEMUCS_TERMS: &str = "\
HTDemucs (Hybrid Transformer Demucs) is a neural network that splits a song into drums, bass, \
vocals and the rest. It was made by Simon Rouard, Francisco Massa and Alexandre Défossez at \
Meta. The Demucs code is under the MIT licence.

Meta publishes the trained weights as a PyTorch file only. The Smart Beat project converted it \
to ONNX so the app can run it, and hosts the converted file (about 177 MB) as an asset of a \
release on its own GitHub page. When you press Download, this computer fetches that file and \
checks it against a fixed size and SHA-256 sum before it is kept. It stays in Smart Beat's data folder and you \
can delete it at any time. Separating a song then runs on this computer; nothing is uploaded.

The authors do not state a licence for the weights. The model was trained on MUSDB18-HQ and on \
800 additional songs that are not public. The terms of MUSDB18-HQ (Zenodo record 3338373, \
licence field other-nc) say the tracks are \"provided for educational purposes only\" and \
\"should not be used for any commercial purpose without the express permission of the copyright \
holders\". The authors do not say whether those terms reach the weights. If a rights holder \
raises an obligation, the Smart Beat project removes the hosted file and the download stops \
working.

By accepting you confirm that you only use music you have the rights to.";

/// The folder one model's file and acceptance live in.
pub fn model_dir<R: Runtime>(app: &AppHandle<R>, model: ModelId) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(model.info().folder))
        .map_err(|e| e.to_string())
}

/// The model's file is present and complete, and the user accepted its terms.
pub fn is_ready<R: Runtime>(app: &AppHandle<R>, model: ModelId) -> bool {
    model_dir(app, model).is_ok_and(|dir| ready_in(&dir, model.info()))
}

/// The path of the model file inside its folder.
pub fn model_file(dir: &Path, model: ModelId) -> PathBuf {
    dir.join(model.info().file.name)
}

fn ready_in(dir: &Path, info: &Model) -> bool {
    model_files::files_present(dir, &[info.file]) && model_files::terms_accepted(dir, TERMS_VERSION)
}

/// What the dialog shows about one model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub model: String,
    /// The file is on this computer, complete.
    pub downloaded: bool,
    /// The user accepted the current terms and confirmed their rights.
    pub terms_accepted: bool,
    pub terms_version: u32,
    /// The size of the download, in bytes.
    pub download_bytes: u64,
    /// The terms the user accepts.
    pub licence: String,
    /// One line for the model card.
    pub licence_summary: String,
    /// The file is published, so it can be downloaded.
    pub available: bool,
}

fn status_of(dir: &Path, info: &Model) -> ModelStatus {
    ModelStatus {
        model: info.id.id().to_string(),
        downloaded: model_files::files_present(dir, &[info.file]),
        terms_accepted: model_files::terms_accepted(dir, TERMS_VERSION),
        terms_version: TERMS_VERSION,
        download_bytes: info.file.bytes,
        licence: info.terms.to_string(),
        licence_summary: info.licence_summary.to_string(),
        available: info.available,
    }
}

fn require_terms(dir: &Path, info: &Model) -> Result<(), CommandError> {
    model_files::require_terms(
        dir,
        TERMS_VERSION,
        &format!(
            "Accept the {} terms and confirm your rights to the music first.",
            info.label
        ),
    )
}

/// Downloads the model's file into `dir` from `base` + name, if it is not there yet. Refuses
/// when the file is not published yet and until the terms are accepted. `on_progress` gets
/// (bytes so far, bytes in total).
fn download(
    dir: &Path,
    base: &str,
    info: &Model,
    on_progress: &mut dyn FnMut(u64, u64),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), CommandError> {
    if !info.available {
        return Err(model_files::error(
            ErrorKind::Network,
            format!(
                "{} is not published for download yet. It will be offered in a later update.",
                info.label
            ),
        ));
    }
    require_terms(dir, info)?;
    model_files::download_all(
        dir,
        base,
        "",
        &[info.file],
        info.label,
        on_progress,
        cancelled,
    )
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    model: String,
    downloaded_bytes: u64,
    total_bytes: u64,
}

fn parse(model: &str) -> Result<ModelId, CommandError> {
    ModelId::parse(model).ok_or_else(|| {
        model_files::error(
            ErrorKind::NotFound,
            format!("There is no model called {model}."),
        )
    })
}

fn folder<R: Runtime>(app: &AppHandle<R>, model: ModelId) -> Result<PathBuf, CommandError> {
    model_dir(app, model).map_err(|e| {
        model_files::error(
            ErrorKind::Io,
            format!("Could not find the app's data folder: {e}"),
        )
    })
}

#[tauri::command]
pub fn stem_model_status<R: Runtime>(
    app: AppHandle<R>,
    model: String,
) -> Result<ModelStatus, CommandError> {
    let id = parse(&model)?;
    Ok(status_of(&folder(&app, id)?, id.info()))
}

/// Records the acceptance of the model's terms and the confirmation that the user only uses
/// music they have the rights to.
#[tauri::command]
pub fn stem_model_accept_terms<R: Runtime>(
    app: AppHandle<R>,
    model: String,
) -> Result<ModelStatus, CommandError> {
    let id = parse(&model)?;
    let dir = folder(&app, id)?;
    model_files::write_terms(&dir, TERMS_VERSION)?;
    Ok(status_of(&dir, id.info()))
}

/// Downloads the model file. Emits `stem-model-download-progress`. Fails with `Download stopped.`
/// when cancelled, and with a clear message while the file is not published.
#[tauri::command]
pub async fn stem_model_download<R: Runtime>(
    app: AppHandle<R>,
    run: State<'_, DownloadRun>,
    model: String,
) -> Result<ModelStatus, CommandError> {
    let id = parse(&model)?;
    let info = id.info();
    let dir = folder(&app, id)?;
    if !info.available {
        return Err(model_files::error(
            ErrorKind::Network,
            format!(
                "{} is not published for download yet. It will be offered in a later update.",
                info.label
            ),
        ));
    }
    require_terms(&dir, info)?;
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
            download(
                &dir,
                info.base_url,
                info,
                &mut |done, total| {
                    let fraction = done as f64 / total.max(1) as f64;
                    if fraction - last >= 0.005 || done >= total {
                        last = fraction;
                        let _ = app.emit(
                            PROGRESS_EVENT,
                            Progress {
                                model: info.id.id().to_string(),
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
    result.map_err(|_| {
        model_files::error(
            ErrorKind::Io,
            format!("Could not download the {} model.", info.label),
        )
    })??;
    Ok(status_of(&dir, info))
}

/// Stops the running download. The part already saved is deleted.
#[tauri::command]
pub fn stem_model_cancel(run: State<'_, DownloadRun>) {
    run.stop();
}

/// Deletes the downloaded file and any part of it. The accepted terms stay on file.
#[tauri::command]
pub fn stem_model_remove<R: Runtime>(
    app: AppHandle<R>,
    model: String,
) -> Result<ModelStatus, CommandError> {
    let id = parse(&model)?;
    let dir = folder(&app, id)?;
    model_files::remove_files(&dir, &[id.info().file])?;
    Ok(status_of(&dir, id.info()))
}

#[cfg(test)]
mod tests {
    use super::model_files::{STOPPED, part_of, sum_hex, write_terms};
    use super::*;
    use sha2::{Digest, Sha256};
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::AtomicUsize;

    /// A server on a free local port that answers `GET /<name>` from `table` (404 otherwise).
    /// Returns the base URL, ending in a slash, and a counter of the requests it served.
    fn serve(table: HashMap<String, Vec<u8>>) -> (String, Arc<AtomicUsize>) {
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

    fn body(len: usize) -> Vec<u8> {
        (0..len).map(|k| (k * 7 + 3) as u8).collect()
    }

    /// An available model whose file is `bytes`, the way the real ones are pinned.
    fn fixture(bytes: &[u8], sha: Option<String>) -> Model {
        let sha = sha.unwrap_or_else(|| sum_hex(Sha256::new().chain_update(bytes)));
        Model {
            id: ModelId::Scnet,
            label: "Test model",
            folder: "models/test",
            base_url: "http://127.0.0.1:9/",
            file: Spec {
                name: "test.onnx",
                bytes: bytes.len() as u64,
                sha256: Box::leak(sha.into_boxed_str()),
            },
            available: true,
            terms: "terms",
            licence_summary: "summary",
        }
    }

    fn run(dir: &Path, base: &str, info: &Model) -> Result<(), CommandError> {
        download(dir, base, info, &mut |_, _| {}, &|| false)
    }

    #[test]
    fn the_registry_pins_every_file() {
        let cases = [
            (
                ModelId::Scnet,
                "scnet",
                "models/scnet",
                "scnet_cpu.onnx",
                52_271_228,
                "f2c050b7264d2b2401497beb712c26a50e6162dfb951041060f23f84929d600e",
            ),
            (
                ModelId::ScnetXl,
                "scnet-xl",
                "models/scnet-xl",
                "scnet_xl_core.onnx",
                216_163_649,
                "4ee5107c1978fd68cc666aa35898c9e866fa7c7d47278086a75bf4448807f0ee",
            ),
            (
                ModelId::Htdemucs,
                "htdemucs",
                "models/htdemucs",
                "htdemucs_core.onnx",
                176_589_623,
                "105da2c479af1f11e2f2057a9d5435f97b27b9f9d1d7c728390bf0a8ab5107ee",
            ),
        ];
        for (id, name, folder, file, bytes, sha) in cases {
            let info = id.info();
            assert_eq!(info.id, id);
            assert_eq!(id.id(), name);
            assert_eq!(ModelId::parse(name), Some(id));
            assert_eq!(info.folder, folder);
            assert_eq!(info.file.name, file);
            assert_eq!(info.file.bytes, bytes);
            assert_eq!(info.file.sha256, sha);
            assert!(info.base_url.starts_with("https:") && info.base_url.ends_with('/'));
            assert!(!info.terms.contains("://"));
        }
        assert_eq!(ModelId::parse("umx-hq"), None);
        assert_eq!(ModelId::parse(""), None);
        // Folders are distinct from each other and from the UMX-HQ one.
        let mut folders: Vec<_> = ModelId::ALL.iter().map(|m| m.info().folder).collect();
        folders.push(super::super::umx_model::FOLDER);
        folders.sort();
        folders.dedup();
        assert_eq!(folders.len(), 4);
    }

    #[test]
    fn all_three_are_published_and_the_converted_ones_point_at_the_project_release() {
        const { assert!(SCNET.available) };
        assert_eq!(
            SCNET.base_url,
            "https://github.com/demixr/scnet-executorch/releases/download/v0.1.2/"
        );
        // HOSTED is the one switch that withdraws the converted two.
        assert_eq!(SCNET_XL.available, HOSTED);
        assert_eq!(HTDEMUCS.available, HOSTED);
        for info in [&SCNET_XL, &HTDEMUCS] {
            assert_eq!(
                info.base_url,
                "https://github.com/mbalyi/smart-beat/releases/download/stem-models-v1/"
            );
        }
        const { assert!(HOSTED) };
    }

    #[test]
    fn the_terms_state_the_facts() {
        for needle in [
            "SCNet",
            "Weinan Tong",
            "MIT",
            "MUSDB18-HQ",
            "record 3338373",
            "other-nc",
            "provided for educational purposes only",
            "should not be used for any commercial purpose without the express permission of the copyright holders",
            "does not say whether those terms reach the weights",
            "rights to",
            "does not include, host or mirror",
        ] {
            assert!(SCNET_TERMS.contains(needle), "scnet: missing {needle}");
        }
        for needle in [
            "ZFTurbo",
            "v1.0.15",
            "converted",
            "do not state a licence",
            "MUSDB18-HQ",
            "other-nc",
            "rights to",
            "3.5 GB",
            "removes the hosted file",
        ] {
            assert!(
                SCNET_XL_TERMS.contains(needle),
                "scnet-xl: missing {needle}"
            );
        }
        for needle in [
            "Rouard",
            "Massa",
            "Défossez",
            "Meta",
            "converted",
            "do not state a licence",
            "800 additional songs",
            "MUSDB18-HQ",
            "rights to",
            "removes the hosted file",
        ] {
            assert!(
                HTDEMUCS_TERMS.contains(needle),
                "htdemucs: missing {needle}"
            );
        }
    }

    #[test]
    fn an_unpublished_model_refuses_before_any_request() {
        let bytes = body(500);
        let (base, hits) = serve(HashMap::from([("test.onnx".to_string(), bytes.clone())]));
        let mut info = fixture(&bytes, None);
        info.available = false;
        let dir = tempfile::tempdir().unwrap();
        write_terms(dir.path(), TERMS_VERSION).unwrap();
        let err = run(dir.path(), &base, &info).unwrap_err();
        assert!(err.message.contains("not published for download yet"));
        assert_eq!(hits.load(Ordering::Relaxed), 0);
        assert!(!dir.path().join("test.onnx").exists());
    }

    #[test]
    fn nothing_downloads_before_the_terms_are_accepted() {
        let bytes = body(500);
        let (base, hits) = serve(HashMap::from([("test.onnx".to_string(), bytes.clone())]));
        let info = fixture(&bytes, None);
        let dir = tempfile::tempdir().unwrap();
        let err = run(dir.path(), &base, &info).unwrap_err();
        assert!(err.message.contains("Accept the Test model terms"));
        assert_eq!(hits.load(Ordering::Relaxed), 0);
        assert!(!dir.path().join("test.onnx").exists());
    }

    #[test]
    fn a_good_download_keeps_the_verified_file_and_a_second_run_asks_for_nothing() {
        let bytes = body(150_000);
        let (base, hits) = serve(HashMap::from([("test.onnx".to_string(), bytes.clone())]));
        let info = fixture(&bytes, None);
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        assert!(!ready_in(d, &info));
        write_terms(d, TERMS_VERSION).unwrap();
        assert!(!ready_in(d, &info), "terms alone are not ready");
        let mut seen = Vec::new();
        download(
            d,
            &base,
            &info,
            &mut |done, total| {
                assert_eq!(total, bytes.len() as u64);
                seen.push(done);
            },
            &|| false,
        )
        .unwrap();
        assert_eq!(std::fs::read(d.join("test.onnx")).unwrap(), bytes);
        assert!(!part_of(&d.join("test.onnx")).exists());
        assert!(seen.windows(2).all(|w| w[0] <= w[1]));
        assert_eq!(seen.last(), Some(&(bytes.len() as u64)));
        assert!(ready_in(d, &info));
        assert_eq!(hits.load(Ordering::Relaxed), 1);

        run(d, &base, &info).unwrap();
        assert_eq!(
            hits.load(Ordering::Relaxed),
            1,
            "present file is not fetched again"
        );

        // The acceptance of an older version does not count.
        std::fs::write(
            d.join(model_files::TERMS_FILE),
            format!(
                r#"{{"version":{},"rightsConfirmed":true,"acceptedAt":1}}"#,
                TERMS_VERSION + 1
            ),
        )
        .unwrap();
        assert!(!ready_in(d, &info));
    }

    #[test]
    fn a_wrong_size_or_sum_is_rejected_and_nothing_is_left() {
        let bytes = body(2_000);
        let (base, _) = serve(HashMap::from([("test.onnx".to_string(), bytes.clone())]));
        let dir = tempfile::tempdir().unwrap();
        write_terms(dir.path(), TERMS_VERSION).unwrap();

        let mut longer = fixture(&bytes, None);
        longer.file.bytes += 1;
        let err = run(dir.path(), &base, &longer).unwrap_err();
        assert!(
            err.message.contains("not the expected file"),
            "{}",
            err.message
        );
        assert!(err.message.contains("Test model"));

        let mut shorter = fixture(&bytes, None);
        shorter.file.bytes -= 1;
        let err = run(dir.path(), &base, &shorter).unwrap_err();
        assert!(err.message.contains("not the expected file"));

        let wrong = fixture(&bytes, Some("0".repeat(64)));
        let err = run(dir.path(), &base, &wrong).unwrap_err();
        assert!(err.message.contains("not the expected file"));

        let dest = dir.path().join("test.onnx");
        assert!(!dest.exists() && !part_of(&dest).exists());
    }

    #[test]
    fn a_missing_file_is_an_error_without_leftovers() {
        let bytes = body(300);
        let (base, _) = serve(HashMap::new());
        let info = fixture(&bytes, None);
        let dir = tempfile::tempdir().unwrap();
        write_terms(dir.path(), TERMS_VERSION).unwrap();
        let err = run(dir.path(), &base, &info).unwrap_err();
        assert!(err.message.contains("404"));
        assert!(!part_of(&dir.path().join("test.onnx")).exists());
    }

    #[test]
    fn cancelling_stops_and_removes_the_part_file() {
        let bytes = body(400_000);
        let (base, _) = serve(HashMap::from([("test.onnx".to_string(), bytes.clone())]));
        let info = fixture(&bytes, None);
        let dir = tempfile::tempdir().unwrap();
        write_terms(dir.path(), TERMS_VERSION).unwrap();
        let stop = AtomicBool::new(false);
        let err = download(
            dir.path(),
            &base,
            &info,
            &mut |done, _| {
                if done > 0 {
                    stop.store(true, Ordering::Relaxed);
                }
            },
            &|| stop.load(Ordering::Relaxed),
        )
        .unwrap_err();
        assert_eq!(err.message, STOPPED);
        let dest = dir.path().join("test.onnx");
        assert!(!dest.exists() && !part_of(&dest).exists());
    }

    #[test]
    fn the_status_reports_each_step_and_removing_keeps_the_terms() {
        let bytes = body(1_000);
        let (base, _) = serve(HashMap::from([("test.onnx".to_string(), bytes.clone())]));
        let info = fixture(&bytes, None);
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();

        let s = status_of(d, &info);
        assert!(!s.downloaded && !s.terms_accepted && s.available);
        assert_eq!(s.download_bytes, 1_000);
        assert_eq!(s.terms_version, TERMS_VERSION);
        assert_eq!(
            (s.licence.as_str(), s.licence_summary.as_str()),
            ("terms", "summary")
        );

        write_terms(d, TERMS_VERSION).unwrap();
        assert!(status_of(d, &info).terms_accepted);
        run(d, &base, &info).unwrap();
        let s = status_of(d, &info);
        assert!(s.downloaded && s.terms_accepted);

        std::fs::write(part_of(&d.join("test.onnx")), b"half").unwrap();
        model_files::remove_files(d, &[info.file]).unwrap();
        assert!(!d.join("test.onnx").exists() && !part_of(&d.join("test.onnx")).exists());
        let s = status_of(d, &info);
        assert!(!s.downloaded && s.terms_accepted);
        model_files::remove_files(d, &[info.file]).unwrap();
    }

    #[test]
    fn the_status_and_progress_serialize_in_camel_case() {
        let json =
            serde_json::to_value(status_of(Path::new("/nonexistent-model"), &SCNET_XL)).unwrap();
        for key in [
            "model",
            "downloaded",
            "termsAccepted",
            "termsVersion",
            "downloadBytes",
            "licence",
            "licenceSummary",
            "available",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
        assert_eq!(json["model"], "scnet-xl");
        assert_eq!(json["available"], true);
        assert_eq!(json["downloadBytes"], 216_163_649u64);
        let progress = serde_json::to_value(Progress {
            model: "htdemucs".into(),
            downloaded_bytes: 1,
            total_bytes: 2,
        })
        .unwrap();
        assert_eq!(progress["model"], "htdemucs");
        assert_eq!(progress["downloadedBytes"], 1);
        assert_eq!(progress["totalBytes"], 2);
    }

    #[test]
    fn an_unknown_model_name_is_an_error() {
        let err = parse("umx-hq").unwrap_err();
        assert!(err.message.contains("umx-hq"));
        assert_eq!(parse("htdemucs").unwrap(), ModelId::Htdemucs);
    }
}
