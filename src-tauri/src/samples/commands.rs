//! The commands behind the sample browser. The page names a folder by id and a file by its
//! path inside that folder; Rust turns that into a real path only if it stays inside the
//! folder (`files::resolve`).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use super::files::{self, SampleFile};
use super::import::{self, ArchiveReport, FolderScan, Stop};
use super::store::{FolderKind, SampleFolder, SampleStore, now_ms};
use super::{SamplesState, preview};
use crate::audio::{AudioState, with_running_engine};
use crate::error::{CommandError, ErrorKind};

pub const PROGRESS_EVENT: &str = "samples://progress";
pub const PREVIEW_ENDED_EVENT: &str = "samples://preview-ended";

fn error(kind: ErrorKind, message: impl Into<String>) -> CommandError {
    CommandError::new(kind, message)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    job_id: &'a str,
    phase: &'a str,
    done: u64,
    total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewEnded<'a> {
    folder_id: &'a str,
    rel: &'a str,
}

fn existing_dir(path: &str) -> Result<PathBuf, CommandError> {
    let path = PathBuf::from(path);
    if !path.is_dir() {
        return Err(error(ErrorKind::NotFound, "That folder does not exist."));
    }
    path.canonicalize()
        .map_err(|e| error(ErrorKind::Io, format!("That folder cannot be read: {e}")))
}

fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Samples".into())
}

fn valid_id(id: &str) -> Result<(), CommandError> {
    if SampleStore::valid_id(id) {
        Ok(())
    } else {
        Err(error(ErrorKind::NotFound, "That sample folder is gone."))
    }
}

/// The folder on disk for folder `id`, which must be readable now.
fn root_for(state: &SamplesState, id: &str) -> Result<(SampleFolder, PathBuf), CommandError> {
    valid_id(id)?;
    let folder = state.store.get(id)?;
    let root = state
        .store
        .root_of(&folder)
        .filter(|root| root.is_dir())
        .ok_or_else(|| {
            error(
                ErrorKind::NotFound,
                format!("“{}” is not available right now.", folder.name),
            )
        })?;
    Ok((folder, root))
}

struct Job<'a> {
    state: &'a SamplesState,
    id: String,
    cancel: Arc<AtomicBool>,
}

impl<'a> Job<'a> {
    fn start(state: &'a SamplesState, id: &str) -> Self {
        let cancel = Arc::new(AtomicBool::new(false));
        state
            .jobs
            .lock()
            .unwrap()
            .insert(id.to_owned(), cancel.clone());
        Self {
            state,
            id: id.to_owned(),
            cancel,
        }
    }
}

impl Drop for Job<'_> {
    fn drop(&mut self) {
        self.state.jobs.lock().unwrap().remove(&self.id);
    }
}

fn stop_error(stop: Stop) -> CommandError {
    match stop {
        Stop::Cancelled => error(ErrorKind::Io, "Cancelled."),
        Stop::Failed(message) => error(ErrorKind::Io, message),
    }
}

/// Runs `fill` into a fresh temporary folder, then moves it into place as a new folder of
/// `kind`. The temporary folder is removed when anything fails or is cancelled.
fn import_into_store<R: Runtime>(
    app: &AppHandle<R>,
    state: &SamplesState,
    job_id: &str,
    kind: FolderKind,
    name: String,
    phase: &'static str,
    fill: impl FnOnce(&Path, &AtomicBool, &mut dyn FnMut(u64, u64)) -> Result<u32, Stop>,
) -> Result<SampleFolder, CommandError> {
    let job = Job::start(state, job_id);
    let id = state.store.new_id(&name);
    let staging = state.store.dir().join(format!("{id}.tmp"));
    let result = (|| {
        fs::create_dir_all(staging.join("files")).map_err(|e| {
            error(
                ErrorKind::Io,
                format!("The samples folder could not be created: {e}"),
            )
        })?;
        let mut last = Instant::now() - Duration::from_secs(1);
        let mut report = |done: u64, total: u64| {
            if done >= total || last.elapsed() >= Duration::from_millis(100) {
                last = Instant::now();
                let _ = app.emit(
                    PROGRESS_EVENT,
                    Progress {
                        job_id,
                        phase,
                        done,
                        total,
                    },
                );
            }
        };
        let count = fill(&staging.join("files"), &job.cancel, &mut report).map_err(stop_error)?;
        fs::rename(&staging, state.store.folder_dir(&id)).map_err(|e| {
            error(
                ErrorKind::Io,
                format!("The samples could not be moved into place: {e}"),
            )
        })?;
        state.store.add(SampleFolder {
            id: id.clone(),
            name,
            kind,
            path: None,
            available: true,
            file_count: Some(count),
            added_ms: now_ms(),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
        let _ = fs::remove_dir_all(state.store.folder_dir(&id));
    }
    result
}

#[tauri::command(async)]
pub fn samples_list_folders(state: State<'_, SamplesState>) -> Vec<SampleFolder> {
    state.store.list()
}

#[tauri::command(async)]
pub fn samples_scan_folder(path: String) -> Result<FolderScan, CommandError> {
    Ok(import::scan_folder(&existing_dir(&path)?))
}

#[tauri::command(async)]
pub fn samples_inspect_archive(path: String) -> ArchiveReport {
    import::inspect_archive(Path::new(&path))
}

#[tauri::command(async)]
pub fn samples_link_folder(
    path: String,
    state: State<'_, SamplesState>,
) -> Result<SampleFolder, CommandError> {
    let dir = existing_dir(&path)?;
    let here = dir.to_string_lossy().into_owned();
    if let Some(known) = state
        .store
        .list()
        .into_iter()
        .find(|f| f.kind == FolderKind::Linked && f.path.as_deref() == Some(here.as_str()))
    {
        return Ok(known);
    }
    let count = u32::try_from(files::walk(&dir).files.len()).unwrap_or(u32::MAX);
    state.store.add(SampleFolder {
        id: state.store.new_id(&here),
        name: folder_name(&dir),
        kind: FolderKind::Linked,
        path: Some(here),
        available: true,
        file_count: Some(count),
        added_ms: now_ms(),
    })
}

#[tauri::command(async)]
pub fn samples_import_folder<R: Runtime>(
    path: String,
    job_id: String,
    app: AppHandle<R>,
    state: State<'_, SamplesState>,
) -> Result<SampleFolder, CommandError> {
    let src = existing_dir(&path)?;
    let name = folder_name(&src);
    import_into_store(
        &app,
        &state,
        &job_id,
        FolderKind::Imported,
        name,
        "copying",
        |dest, cancel, progress| import::copy_folder(&src, dest, cancel, progress),
    )
}

#[tauri::command(async)]
pub fn samples_import_archive<R: Runtime>(
    path: String,
    job_id: String,
    app: AppHandle<R>,
    state: State<'_, SamplesState>,
) -> Result<SampleFolder, CommandError> {
    let archive = PathBuf::from(&path);
    if !archive.is_file() {
        return Err(error(ErrorKind::NotFound, "That archive does not exist."));
    }
    let name = archive
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Samples".into());
    import_into_store(
        &app,
        &state,
        &job_id,
        FolderKind::Archive,
        name,
        "unpacking",
        |dest, cancel, progress| import::unpack_archive(&archive, dest, cancel, progress),
    )
}

#[tauri::command]
pub fn samples_cancel(job_id: String, state: State<'_, SamplesState>) {
    if let Some(flag) = state.jobs.lock().unwrap().get(&job_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[tauri::command(async)]
pub fn samples_remove_folder(
    id: String,
    delete_copy: bool,
    state: State<'_, SamplesState>,
) -> Result<(), CommandError> {
    valid_id(&id)?;
    let Some(folder) = state.store.remove(&id)? else {
        return Ok(());
    };
    let dir = state.store.folder_dir(&id);
    if folder.kind == FolderKind::Linked {
        // Only what Smart Beat made: the linked files are never touched.
        let _ = fs::remove_dir_all(&dir);
    } else if delete_copy {
        let _ = fs::remove_dir_all(&dir);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn samples_relink_folder(
    id: String,
    path: String,
    state: State<'_, SamplesState>,
) -> Result<SampleFolder, CommandError> {
    valid_id(&id)?;
    if state.store.get(&id)?.kind != FolderKind::Linked {
        return Err(error(
            ErrorKind::Io,
            "Only a linked folder can point somewhere else.",
        ));
    }
    let dir = existing_dir(&path)?;
    let count = u32::try_from(files::walk(&dir).files.len()).unwrap_or(u32::MAX);
    let mut updated = state.store.update(&id, |f| {
        f.path = Some(dir.to_string_lossy().into_owned());
        f.file_count = Some(count);
    })?;
    updated.available = true;
    Ok(updated)
}

#[tauri::command(async)]
pub fn samples_list_files(
    folder_id: String,
    state: State<'_, SamplesState>,
) -> Result<Vec<SampleFile>, CommandError> {
    let (folder, root) = root_for(&state, &folder_id)?;
    let listed = files::list_files(&root, &state.store.index_path(&folder_id));
    let count = u32::try_from(listed.len()).unwrap_or(u32::MAX);
    if folder.file_count != Some(count) {
        let _ = state
            .store
            .update(&folder_id, |f| f.file_count = Some(count));
    }
    Ok(listed)
}

#[tauri::command(async)]
pub fn samples_probe_files(
    folder_id: String,
    rels: Vec<String>,
    state: State<'_, SamplesState>,
) -> Result<Vec<SampleFile>, CommandError> {
    let (_, root) = root_for(&state, &folder_id)?;
    files::probe_files(&root, &state.store.index_path(&folder_id), &rels)
}

#[tauri::command(async)]
pub fn samples_resolve(
    folder_id: String,
    rel: String,
    state: State<'_, SamplesState>,
) -> Result<String, CommandError> {
    let (_, root) = root_for(&state, &folder_id)?;
    Ok(files::resolve(&root, &rel)?.to_string_lossy().into_owned())
}

#[tauri::command(async)]
pub fn samples_preview_start<R: Runtime>(
    folder_id: String,
    rel: String,
    volume: f32,
    app: AppHandle<R>,
    state: State<'_, SamplesState>,
    audio: State<'_, AudioState>,
) -> Result<(), CommandError> {
    let (_, root) = root_for(&state, &folder_id)?;
    let path = files::resolve(&root, &rel)?;
    let rate = with_running_engine(&audio, |engine| engine.sample_rate())?;
    // The ticket is taken before decoding, so a stop or a newer preview that arrives while a
    // large file is still being read supersedes this one.
    let generation = state.begin_preview();
    // Decoded here, not on the audio thread; the engine only gets the finished buffer.
    let decoded = preview::load(&path, rate as u32).map_err(|e| error(ErrorKind::Audio, e))?;
    let started = state.start_if_current(generation, || {
        with_running_engine(&audio, |engine| {
            engine.start_sample_preview(decoded.clone(), volume)
        })
    });
    match started {
        // Stopped or replaced while decoding: stay silent.
        None => return Ok(()),
        Some(result) => result?.map_err(|e| error(ErrorKind::Audio, e))?,
    }
    let wait = Duration::from_secs_f64(decoded.duration() + 0.15);
    std::thread::spawn(move || {
        std::thread::sleep(wait);
        let state = app.state::<SamplesState>();
        let audio = app.state::<AudioState>();
        let finished = state.is_current(generation)
            && with_running_engine(&audio, |engine| !engine.sample_preview_active())
                .unwrap_or(true);
        if finished {
            let _ = app.emit(
                PREVIEW_ENDED_EVENT,
                PreviewEnded {
                    folder_id: &folder_id,
                    rel: &rel,
                },
            );
        }
    });
    Ok(())
}

#[tauri::command(async)]
pub fn samples_preview_stop(state: State<'_, SamplesState>, audio: State<'_, AudioState>) {
    // No engine means nothing is playing. Stopping under the same lock as starting means a
    // preview still decoding cannot start after this returns.
    state.cancel_previews(|| {
        let _ = with_running_engine(&audio, |engine| engine.stop_sample_preview());
    });
}

#[tauri::command(async)]
pub fn samples_preview_volume(volume: f32, audio: State<'_, AudioState>) {
    let _ = with_running_engine(&audio, |engine| engine.set_sample_preview_gain(volume));
}
