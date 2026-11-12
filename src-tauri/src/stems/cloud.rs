//! Saved stems in the connected cloud accounts (#186): Google Drive, OneDrive and Dropbox.
//!
//! The `.sbstems` file is made and read by [`super::bundle`] exactly as for a file on this
//! computer. Here it only goes through a temporary file: a save writes the bundle there and the
//! provider uploads it in chunks from disk; an open downloads it there and opens it. Nothing is
//! held in memory whole (a bundle is tens to hundreds of MB) and the temporary folder is removed
//! on success, on failure and on cancel. The bundle lives in the provider's Smart Beat folder
//! next to the tabs and is told apart by its name ([`crate::cloud_commands::is_stems_name`]).

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use super::bundle::{self, PROGRESS_EVENT, Progress, STOPPED, SaveRequest};
use super::store::StemStore;
use super::{StemSong, StemsRun};
use crate::cloud::{self, ProviderKind};
use crate::cloud_commands::{self, CloudState};
use crate::error::{CommandError, ErrorKind};

/// What the page asks for. Mirrored by `StemCloudSaveRequest` in `src/lib/tauri.ts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSaveRequest {
    /// The song in the cache.
    pub id: String,
    pub provider: ProviderKind,
    /// Embed the audio file the stems were made from, when it can still be found.
    pub include_original: bool,
    /// The mixer state to keep with the song, any JSON object the page can read back.
    #[serde(default)]
    pub state: Option<Value>,
}

/// Mirrored by `StemCloudSaveResult` in `src/lib/tauri.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSaveResult {
    /// The file's item id, `drive:<id>`: what [`stems_cloud_open`] takes.
    pub item: String,
    /// The file name in the cloud, `<song name>.sbstems`, numbered when the name was taken.
    pub name: String,
    pub provider: ProviderKind,
    /// The size of the file.
    pub bytes: u64,
    /// False when it was not asked for, or when the source file is gone or changed.
    pub original_included: bool,
}

/// Mirrored by `StemCloudOpenRequest` in `src/lib/tauri.ts`.
#[derive(Debug, Clone, Deserialize)]
pub struct CloudOpenRequest {
    /// The file's item id, `drive:<id>`, from `cloud_list_stems` or a save.
    pub item: String,
}

fn io(message: impl Into<String>) -> CommandError {
    CommandError::new(ErrorKind::Io, message)
}

/// A stopped transfer is reported the way a stopped file save is, so the page treats both alike.
fn stop_as_stopped(error: CommandError) -> CommandError {
    if error.message == STOPPED {
        CommandError::new(ErrorKind::Audio, STOPPED)
    } else {
        error
    }
}

/// A file name made of the song's name: no path parts, no characters a drive refuses.
pub(super) fn safe_base(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let base: String = trimmed.chars().take(120).collect();
    if base.is_empty() {
        "Stems".to_owned()
    } else {
        base
    }
}

/// `<base>.sbstems`, or `<base> (2).sbstems`, `(3)`… when a file of that name is there already.
fn unique_name(base: &str, taken: &[String]) -> String {
    let is_taken = |name: &str| taken.iter().any(|t| t.eq_ignore_ascii_case(name));
    let first = format!("{base}.sbstems");
    if !is_taken(&first) {
        return first;
    }
    (2..)
        .map(|n| format!("{base} ({n}).sbstems"))
        .find(|name| !is_taken(name))
        .unwrap_or(first)
}

/// Saves a cached song into a connected account: the bundle is written to a temporary file and
/// uploaded from there. `emit(stage, fraction)` gets `writing`, then `uploading`. `cancel` stops
/// either step with [`STOPPED`]; the temporary file is gone in every case.
pub fn save_to_cloud(
    cloud: &CloudState,
    store: &StemStore,
    app_version: &str,
    request: &CloudSaveRequest,
    cancel: &AtomicBool,
    emit: &mut dyn FnMut(&'static str, f32),
) -> Result<CloudSaveResult, CommandError> {
    let song = store.get(&request.id).ok_or_else(|| {
        CommandError::new(ErrorKind::NotFound, "That song is not saved any more.")
    })?;
    let previous_path = song.saved_path.clone();
    // The account first: a sign-in that is gone says so before minutes of encoding.
    let (provider, token) = cloud.session(request.provider)?;
    let taken: Vec<String> = provider
        .list(&token)?
        .into_iter()
        .map(|file| file.name)
        .collect();
    let name = unique_name(&safe_base(&song.name), &taken);

    let dir = tempfile::Builder::new()
        .prefix("smart-beat-stems-")
        .tempdir()
        .map_err(|e| io(format!("A temporary file could not be made: {e}")))?;
    let dest = dir.path().join(&name);
    let saved = bundle::save(
        store,
        &SaveRequest {
            id: request.id.clone(),
            dest: dest.to_string_lossy().into_owned(),
            include_original: request.include_original,
            state: request.state.clone(),
        },
        app_version,
        cancel,
        &mut |fraction| emit("writing", fraction),
    )?;
    // `save` pointed the song at the temporary file, which is about to go: from here on it is
    // either in the cloud (set below) or where it was before.
    let restore = |path: Option<String>| {
        let _ = store.update(&request.id, |s| s.saved_path = path);
    };
    if cancel.load(Ordering::Relaxed) {
        restore(previous_path);
        return Err(bundle::stopped());
    }
    let uploaded =
        provider.upload_file(&token, &name, &dest, &mut |f| emit("uploading", f), cancel);
    let file = match uploaded {
        Ok(file) => file,
        Err(error) => {
            restore(previous_path);
            return Err(stop_as_stopped(error));
        }
    };
    let item = cloud::item_id(request.provider, &file.id);
    restore(Some(item.clone()));
    emit("uploading", 1.0);
    Ok(CloudSaveResult {
        item,
        name: if file.name.is_empty() {
            name
        } else {
            file.name
        },
        provider: request.provider,
        bytes: saved.bytes,
        original_included: saved.original_included,
    })
}

/// Opens a saved stems file of a connected account: it is downloaded to a temporary file and
/// opened from there, so the song is in the cache like any other and its `saved_path` is the
/// item id. `emit(stage, fraction)` gets `downloading`, then `reading`.
pub fn open_from_cloud(
    cloud: &CloudState,
    store: &StemStore,
    request: &CloudOpenRequest,
    cancel: &AtomicBool,
    emit: &mut dyn FnMut(&'static str, f32),
) -> Result<StemSong, CommandError> {
    let (kind, id) = cloud_commands::parse_item(&request.item)?;
    let (provider, token) = cloud.session(kind)?;
    let meta = provider.metadata(&token, id)?;
    if !cloud_commands::is_stems_name(&meta.name) {
        return Err(CommandError::new(
            ErrorKind::UnsupportedType,
            format!("“{}” is not a Smart Beat stems file.", meta.name),
        ));
    }
    let dir = tempfile::Builder::new()
        .prefix("smart-beat-stems-")
        .tempdir()
        .map_err(|e| io(format!("A temporary file could not be made: {e}")))?;
    let stem = Path::new(&meta.name)
        .file_stem()
        .map_or_else(|| "Stems".to_owned(), |s| s.to_string_lossy().into_owned());
    let dest = dir.path().join(format!("{}.sbstems", safe_base(&stem)));
    provider
        .download_file(&token, id, &dest, &mut |f| emit("downloading", f), cancel)
        .map_err(stop_as_stopped)?;
    if cancel.load(Ordering::Relaxed) {
        return Err(bundle::stopped());
    }
    let song = bundle::open(store, &dest, cancel, &mut |f| emit("reading", f))?;
    // `open` pointed the song at the temporary file; it belongs to the cloud file.
    store
        .update(&song.id, |s| s.saved_path = Some(request.item.clone()))
        .map_err(io)
}

/// Throttles progress: one event per percent per stage.
fn event_sender<R: Runtime>(app: &AppHandle<R>) -> impl FnMut(&'static str, f32) + use<'_, R> {
    let mut last: (&'static str, i32) = ("", -1);
    move |stage, fraction| {
        let percent = (fraction.clamp(0.0, 1.0) * 100.0) as i32;
        if (stage, percent) != last {
            last = (stage, percent);
            let _ = app.emit(PROGRESS_EVENT, Progress { stage, fraction });
        }
    }
}

/// Saves a cached song as a `.sbstems` file in a connected account's Smart Beat folder. Emits
/// `stems-bundle-progress` (`{ stage: "writing" | "uploading", fraction }`). Stopped by
/// `stems_cancel` with the message of [`STOPPED`].
#[tauri::command]
pub async fn stems_cloud_save<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, StemStore>,
    run: State<'_, StemsRun>,
    request: CloudSaveRequest,
) -> Result<CloudSaveResult, CommandError> {
    let store = store.inner().clone();
    let version = app.package_info().version.to_string();
    let stop = run.start_bundle();
    let worker = {
        let stop = stop.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let cloud = app.state::<CloudState>();
            let mut emit = event_sender(&app);
            save_to_cloud(&cloud, &store, &version, &request, &stop, &mut emit)
        })
    };
    let result = worker.await;
    run.finish_bundle(&stop);
    result.unwrap_or_else(|_| Err(io("The stems could not be saved.")))
}

/// Opens a saved stems file of a connected account and returns its song. Emits
/// `stems-bundle-progress` (`{ stage: "downloading" | "reading", fraction }`). Stopped by
/// `stems_cancel` with the message of [`STOPPED`].
#[tauri::command]
pub async fn stems_cloud_open<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, StemStore>,
    run: State<'_, StemsRun>,
    request: CloudOpenRequest,
) -> Result<StemSong, CommandError> {
    let store = store.inner().clone();
    let stop = run.start_bundle();
    let worker = {
        let stop = stop.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let cloud = app.state::<CloudState>();
            let mut emit = event_sender(&app);
            open_from_cloud(&cloud, &store, &request, &stop, &mut emit)
        })
    };
    let result = worker.await;
    run.finish_bundle(&stop);
    result.unwrap_or_else(|_| Err(io("The stems file could not be opened.")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::keychain::{MemoryStore, TokenStore};
    use crate::cloud::{Provider, RemoteFile, Tokens};
    use crate::stems::codec::tests::{signal, write_pcm};
    use crate::stems::{StemEngine, StemInfo, StemKind};
    use std::cell::RefCell;
    use std::path::PathBuf;

    const ID: &str = "0123456789abcdef";

    /// What the fake cloud holds and does. The tests of one thread share nothing with another's
    /// (the commands run on the calling thread), so a `thread_local` is the fake's memory.
    #[derive(Default)]
    struct Cloud {
        files: Vec<(RemoteFile, Vec<u8>)>,
        /// Fail the list with this kind of error.
        fail: Option<ErrorKind>,
        /// Set the cancel flag in the middle of the upload.
        cancel_mid_upload: bool,
        /// The temporary file the last upload read from.
        uploaded_from: Option<PathBuf>,
        downloaded_to: Option<PathBuf>,
        next_id: u32,
    }

    thread_local! {
        static CLOUD: RefCell<Cloud> = RefCell::new(Cloud::default());
    }

    fn with_cloud<T>(f: impl FnOnce(&mut Cloud) -> T) -> T {
        CLOUD.with(|c| f(&mut c.borrow_mut()))
    }

    fn remote(id: &str, name: &str, modified_ms: u64, size: u64) -> RemoteFile {
        RemoteFile {
            id: id.into(),
            name: name.into(),
            revision: "r".into(),
            size,
            modified_ms,
        }
    }

    struct Fake;

    impl Provider for Fake {
        fn kind(&self) -> ProviderKind {
            ProviderKind::Drive
        }
        fn account_name(&self, _: &str) -> Result<String, CommandError> {
            Ok("me".into())
        }
        fn list(&self, _: &str) -> Result<Vec<RemoteFile>, CommandError> {
            with_cloud(|c| match c.fail {
                Some(kind) => Err(CommandError::new(kind, "the provider said no")),
                None => Ok(c.files.iter().map(|(f, _)| f.clone()).collect()),
            })
        }
        fn metadata(&self, _: &str, id: &str) -> Result<RemoteFile, CommandError> {
            with_cloud(|c| {
                c.files
                    .iter()
                    .find(|(f, _)| f.id == id)
                    .map(|(f, _)| f.clone())
                    .ok_or_else(|| CommandError::new(ErrorKind::NotFound, "gone"))
            })
        }
        fn read(&self, _: &str, _: &str) -> Result<(Vec<u8>, RemoteFile), CommandError> {
            Err(io("not used"))
        }
        fn write_if_revision(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &[u8],
        ) -> Result<RemoteFile, CommandError> {
            Err(io("not used"))
        }
        fn create(&self, _: &str, _: &str, _: &[u8]) -> Result<RemoteFile, CommandError> {
            Err(io("not used"))
        }
        fn revoke(&self, _: &str) -> Result<(), CommandError> {
            Ok(())
        }
        fn upload_file(
            &self,
            _: &str,
            name: &str,
            path: &Path,
            progress: &mut dyn FnMut(f32),
            cancel: &AtomicBool,
        ) -> Result<RemoteFile, CommandError> {
            let bytes = std::fs::read(path).unwrap();
            progress(0.0);
            progress(0.5);
            if with_cloud(|c| {
                c.uploaded_from = Some(path.to_path_buf());
                c.cancel_mid_upload
            }) {
                cancel.store(true, Ordering::Relaxed);
                return Err(CommandError::new(ErrorKind::Io, cloud::STOPPED));
            }
            progress(1.0);
            Ok(with_cloud(|c| {
                c.next_id += 1;
                let file = remote(
                    &format!("file{}", c.next_id),
                    name,
                    1_000 + u64::from(c.next_id),
                    bytes.len() as u64,
                );
                c.files.push((file.clone(), bytes));
                file
            }))
        }
        fn download_file(
            &self,
            _: &str,
            id: &str,
            dest: &Path,
            progress: &mut dyn FnMut(f32),
            _: &AtomicBool,
        ) -> Result<RemoteFile, CommandError> {
            let (file, bytes) = with_cloud(|c| {
                c.downloaded_to = Some(dest.to_path_buf());
                c.files.iter().find(|(f, _)| f.id == id).cloned()
            })
            .ok_or_else(|| CommandError::new(ErrorKind::NotFound, "gone"))?;
            progress(0.5);
            std::fs::write(dest, bytes).unwrap();
            progress(1.0);
            Ok(file)
        }
    }

    fn fake(_: ProviderKind) -> Box<dyn Provider> {
        Box::new(Fake)
    }

    /// A cloud state with a Google Drive sign-in, or none.
    fn cloud_state(dir: &Path, signed_in: bool) -> CloudState {
        let tokens = MemoryStore::default();
        if signed_in {
            tokens
                .save(
                    ProviderKind::Drive,
                    &Tokens {
                        access_token: "at".into(),
                        refresh_token: None,
                        expires_at: 0,
                        account: "me".into(),
                    },
                )
                .unwrap();
        }
        CloudState::with_parts(Box::new(tokens), dir.join("pending"), fake)
    }

    /// A song in the cache with two stems.
    fn cached(store: &StemStore, name: &str) -> StemSong {
        let staging = store.staging(ID).unwrap();
        let stems = [
            (StemKind::Drums, signal(20_000)),
            (
                StemKind::Other,
                signal(20_000).iter().map(|s| s / 2).collect(),
            ),
        ];
        let mut infos = Vec::new();
        for (kind, samples) in &stems {
            let path = staging.path().join(format!("{}.wav", kind.id()));
            write_pcm(&path, 44_100, samples);
            infos.push(StemInfo {
                kind: *kind,
                bytes: std::fs::metadata(&path).unwrap().len(),
            });
        }
        let song = StemSong {
            id: ID.into(),
            name: name.into(),
            duration_seconds: 20_000.0 / 44_100.0,
            sample_rate: 44_100,
            engine: StemEngine::Htdemucs,
            strong_drums: false,
            bytes: infos.iter().map(|s| s.bytes).sum(),
            stems: infos,
            mono: false,
            skipped: Vec::new(),
            panned_share: 0.0,
            created_at_ms: 1_000,
            pinned: false,
            last_opened: None,
            saved_path: None,
            has_original: false,
            tempo: None,
        };
        store.commit(staging, &song).unwrap();
        song
    }

    fn request(original: bool) -> CloudSaveRequest {
        CloudSaveRequest {
            id: ID.into(),
            provider: ProviderKind::Drive,
            include_original: original,
            state: Some(serde_json::json!({ "volume": 0.5 })),
        }
    }

    fn setup() -> (tempfile::TempDir, StemStore, CloudState) {
        with_cloud(|c| *c = Cloud::default());
        let dir = tempfile::tempdir().unwrap();
        let store = StemStore::new(dir.path().join("cache"));
        let cloud = cloud_state(dir.path(), true);
        (dir, store, cloud)
    }

    fn save(
        cloud: &CloudState,
        store: &StemStore,
        request: &CloudSaveRequest,
        cancel: &AtomicBool,
    ) -> (
        Result<CloudSaveResult, CommandError>,
        Vec<(&'static str, f32)>,
    ) {
        let mut events = Vec::new();
        let result = save_to_cloud(cloud, store, "1.2.3", request, cancel, &mut |s, f| {
            events.push((s, f));
        });
        (result, events)
    }

    #[test]
    fn a_saved_song_is_uploaded_as_a_bundle_that_opens_again() {
        let (_dir, store, cloud) = setup();
        let song = cached(&store, "Band Song");

        let (result, events) = save(&cloud, &store, &request(false), &AtomicBool::new(false));
        let saved = result.unwrap();
        assert_eq!(saved.name, "Band Song.sbstems");
        assert_eq!(saved.item, "drive:file1");
        assert_eq!(saved.provider, ProviderKind::Drive);
        assert!(saved.bytes > 1_000);
        assert!(!saved.original_included);
        let json = serde_json::to_value(&saved).unwrap();
        assert_eq!(json["originalIncluded"], false);
        assert_eq!(json["provider"], "drive");

        // The stages come in order: writing, then uploading, each ending at 1.
        let stages: Vec<&str> = events.iter().map(|(s, _)| *s).collect();
        let first_upload = stages.iter().position(|s| *s == "uploading").unwrap();
        assert!(first_upload > 0);
        assert!(stages[..first_upload].iter().all(|s| *s == "writing"));
        assert!(stages[first_upload..].iter().all(|s| *s == "uploading"));
        assert_eq!(events[first_upload - 1].1, 1.0);
        assert_eq!(events.last().unwrap(), &("uploading", 1.0));

        // The uploaded bytes are a real bundle: a fresh cache opens it, the song is the same.
        let fresh = StemStore::new(_dir.path().join("fresh"));
        let opened = open_from_cloud(
            &cloud,
            &fresh,
            &CloudOpenRequest {
                item: saved.item.clone(),
            },
            &AtomicBool::new(false),
            &mut |_, _| {},
        )
        .unwrap();
        assert_eq!(opened.id, song.id);
        assert_eq!(opened.name, "Band Song");
        assert_eq!(opened.stems.len(), 2);
        // It belongs to the cloud file, not to the temporary one.
        assert_eq!(opened.saved_path.as_deref(), Some("drive:file1"));
        assert_eq!(
            fresh.get(ID).unwrap().saved_path.as_deref(),
            Some("drive:file1")
        );
        // And the song that was saved points there too.
        assert_eq!(
            store.get(ID).unwrap().saved_path.as_deref(),
            Some("drive:file1")
        );
    }

    #[test]
    fn the_temporary_files_never_stay() {
        let (_dir, store, cloud) = setup();
        cached(&store, "Band Song");
        let (result, _) = save(&cloud, &store, &request(false), &AtomicBool::new(false));
        let item = result.unwrap().item;
        let uploaded_from = with_cloud(|c| c.uploaded_from.clone()).unwrap();
        assert!(!uploaded_from.exists());
        assert!(!uploaded_from.parent().unwrap().exists());

        let fresh = StemStore::new(_dir.path().join("fresh"));
        open_from_cloud(
            &cloud,
            &fresh,
            &CloudOpenRequest { item },
            &AtomicBool::new(false),
            &mut |_, _| {},
        )
        .unwrap();
        let downloaded_to = with_cloud(|c| c.downloaded_to.clone()).unwrap();
        assert!(!downloaded_to.exists());
        assert!(!downloaded_to.parent().unwrap().exists());
    }

    #[test]
    fn a_name_that_is_taken_gets_a_number() {
        let (_dir, store, cloud) = setup();
        cached(&store, "Band Song");
        with_cloud(|c| {
            c.files
                .push((remote("a", "band song.SBSTEMS", 1, 1), Vec::new()));
            c.files
                .push((remote("b", "Band Song (2).sbstems", 1, 1), Vec::new()));
        });
        let (result, _) = save(&cloud, &store, &request(false), &AtomicBool::new(false));
        assert_eq!(result.unwrap().name, "Band Song (3).sbstems");
    }

    #[test]
    fn names_are_safe_and_unique() {
        assert_eq!(safe_base("AC/DC: Back in Black?"), "AC_DC_ Back in Black_");
        assert_eq!(safe_base("  ..  "), "Stems");
        assert_eq!(safe_base(&"x".repeat(300)).len(), 120);
        assert_eq!(unique_name("A", &[]), "A.sbstems");
        assert_eq!(
            unique_name("A", &["a.sbstems".into(), "A (2).sbstems".into()]),
            "A (3).sbstems"
        );
    }

    #[test]
    fn stopping_during_the_upload_ends_with_stopped_and_leaves_nothing() {
        let (_dir, store, cloud) = setup();
        cached(&store, "Band Song");
        with_cloud(|c| c.cancel_mid_upload = true);
        let cancel = AtomicBool::new(false);
        let (result, _) = save(&cloud, &store, &request(false), &cancel);
        let error = result.unwrap_err();
        assert_eq!(error.message, STOPPED);
        assert!(cancel.load(Ordering::Relaxed));
        let uploaded_from = with_cloud(|c| c.uploaded_from.clone()).unwrap();
        assert!(!uploaded_from.exists());
        assert!(with_cloud(|c| c.files.is_empty()));
        // The song is not pointed at a file that is gone.
        assert_eq!(store.get(ID).unwrap().saved_path, None);
    }

    #[test]
    fn a_stop_before_the_upload_never_reaches_the_provider() {
        let (_dir, store, cloud) = setup();
        cached(&store, "Band Song");
        let (result, _) = save(&cloud, &store, &request(false), &AtomicBool::new(true));
        assert_eq!(result.unwrap_err().message, STOPPED);
        assert!(with_cloud(|c| c.uploaded_from.is_none()));
        assert_eq!(store.get(ID).unwrap().saved_path, None);
    }

    #[test]
    fn a_failed_upload_keeps_the_place_the_song_was_saved_before() {
        let (_dir, store, cloud) = setup();
        cached(&store, "Band Song");
        store
            .update(ID, |s| s.saved_path = Some("/Music/old.sbstems".into()))
            .unwrap();
        with_cloud(|c| c.cancel_mid_upload = true);
        let (result, _) = save(&cloud, &store, &request(false), &AtomicBool::new(false));
        assert!(result.is_err());
        assert_eq!(
            store.get(ID).unwrap().saved_path.as_deref(),
            Some("/Music/old.sbstems")
        );
    }

    #[test]
    fn a_provider_that_refuses_the_sign_in_passes_the_error_through() {
        let (_dir, store, cloud) = setup();
        cached(&store, "Band Song");
        with_cloud(|c| c.fail = Some(ErrorKind::AuthExpired));
        let (result, _) = save(&cloud, &store, &request(false), &AtomicBool::new(false));
        assert_eq!(result.unwrap_err().kind, ErrorKind::AuthExpired);
        assert!(with_cloud(|c| c.uploaded_from.is_none()));
    }

    #[test]
    fn an_account_that_is_not_connected_says_so_before_any_encoding() {
        let dir = tempfile::tempdir().unwrap();
        with_cloud(|c| *c = Cloud::default());
        let store = StemStore::new(dir.path().join("cache"));
        cached(&store, "Band Song");
        let cloud = cloud_state(dir.path(), false);
        let mut events = 0;
        let error = save_to_cloud(
            &cloud,
            &store,
            "1.2.3",
            &request(false),
            &AtomicBool::new(false),
            &mut |_, _| events += 1,
        )
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::AuthExpired);
        assert_eq!(events, 0);

        let error = open_from_cloud(
            &cloud,
            &store,
            &CloudOpenRequest {
                item: "drive:x".into(),
            },
            &AtomicBool::new(false),
            &mut |_, _| {},
        )
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::AuthExpired);
    }

    #[test]
    fn a_song_that_left_the_cache_is_not_found() {
        let (_dir, store, cloud) = setup();
        let (result, _) = save(&cloud, &store, &request(false), &AtomicBool::new(false));
        assert_eq!(result.unwrap_err().kind, ErrorKind::NotFound);
    }

    #[test]
    fn opening_reports_downloading_then_reading() {
        let (dir, store, cloud) = setup();
        cached(&store, "Band Song");
        let (result, _) = save(&cloud, &store, &request(false), &AtomicBool::new(false));
        let item = result.unwrap().item;
        let fresh = StemStore::new(dir.path().join("fresh"));
        let mut events: Vec<(&'static str, f32)> = Vec::new();
        open_from_cloud(
            &cloud,
            &fresh,
            &CloudOpenRequest { item },
            &AtomicBool::new(false),
            &mut |s, f| events.push((s, f)),
        )
        .unwrap();
        let stages: Vec<&str> = events.iter().map(|(s, _)| *s).collect();
        let first_read = stages.iter().position(|s| *s == "reading").unwrap();
        assert!(first_read > 0);
        assert!(stages[..first_read].iter().all(|s| *s == "downloading"));
        assert!(stages[first_read..].iter().all(|s| *s == "reading"));
    }

    #[test]
    fn a_file_that_is_not_a_stems_file_is_refused_without_downloading() {
        let (_dir, store, cloud) = setup();
        with_cloud(|c| c.files.push((remote("t", "riff.gp", 1, 1), vec![1])));
        let error = open_from_cloud(
            &cloud,
            &store,
            &CloudOpenRequest {
                item: "drive:t".into(),
            },
            &AtomicBool::new(false),
            &mut |_, _| {},
        )
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::UnsupportedType);
        assert!(with_cloud(|c| c.downloaded_to.is_none()));
        let error = open_from_cloud(
            &cloud,
            &store,
            &CloudOpenRequest {
                item: "/Users/me/a.sbstems".into(),
            },
            &AtomicBool::new(false),
            &mut |_, _| {},
        )
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);
    }

    #[test]
    fn a_download_that_is_not_a_bundle_is_reported_and_leaves_nothing() {
        let (_dir, store, cloud) = setup();
        with_cloud(|c| {
            c.files
                .push((remote("junk", "bad.sbstems", 1, 4), b"junk".to_vec()))
        });
        let error = open_from_cloud(
            &cloud,
            &store,
            &CloudOpenRequest {
                item: "drive:junk".into(),
            },
            &AtomicBool::new(false),
            &mut |_, _| {},
        )
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::UnsupportedType);
        let downloaded_to = with_cloud(|c| c.downloaded_to.clone()).unwrap();
        assert!(!downloaded_to.exists());
    }

    #[test]
    fn the_request_arrives_in_camel_case() {
        let request: CloudSaveRequest = serde_json::from_value(serde_json::json!({
            "id": ID,
            "provider": "onedrive",
            "includeOriginal": true,
        }))
        .unwrap();
        assert_eq!(request.provider, ProviderKind::Onedrive);
        assert!(request.include_original);
        assert!(request.state.is_none());
        let open: CloudOpenRequest =
            serde_json::from_value(serde_json::json!({ "item": "dropbox:/a.sbstems" })).unwrap();
        assert_eq!(open.item, "dropbox:/a.sbstems");
    }
}
