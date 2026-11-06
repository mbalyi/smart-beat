//! Songs the operating system asks Smart Beat to open: a double-click in Finder or Explorer,
//! "Open With", or a second launch while the app is already running.
//!
//! macOS delivers the files as `RunEvent::Opened`; Windows and Linux pass them as launch
//! arguments (a second launch forwards them to the running app, see `lib.rs`). Files go into a
//! queue first, so one that arrives while the page is still loading is not lost. The page is
//! then told to collect them with `take_pending_open_files`.
//!
//! A saved stem separation (`.sbstems`, see `stems::bundle`) is not a score. It goes to the page
//! as the event `stems-bundle-opened` with `{ path }`. A file that arrives before the page asked
//! for them (the launch) waits in [`PendingBundles`] until `take_pending_stem_bundles`.

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::score_file;
use crate::stems::bundle;

/// Sent (without payload) when the queue has new files. Mirrored in `src/lib/tauri.ts`.
pub const OPEN_EXTERNAL_FILE_EVENT: &str = "open-external-file";

/// Sent with `{ path }` when the system opens a `.sbstems` file and the page is listening.
/// Mirrored in `src/lib/tauri.ts`.
pub const STEMS_BUNDLE_OPENED_EVENT: &str = "stems-bundle-opened";

/// Files waiting for the page to open them.
#[derive(Default)]
pub struct PendingOpen(Mutex<Vec<String>>);

impl PendingOpen {
    /// Queues the files Smart Beat can open and returns how many were added.
    pub fn push(&self, paths: impl IntoIterator<Item = PathBuf>) -> usize {
        let mut queue = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let before = queue.len();
        for path in paths {
            if !score_file::has_supported_extension(&path) {
                continue;
            }
            let Some(path) = path.to_str().map(str::to_owned) else {
                continue;
            };
            if !queue.contains(&path) {
                queue.push(path);
            }
        }
        queue.len() - before
    }

    /// Empties the queue.
    pub fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

/// `.sbstems` files, kept for the page until it starts listening. From its first
/// `take_pending_stem_bundles` on, a file is sent as an event at once instead, so none is
/// delivered twice.
#[derive(Default)]
pub struct PendingBundles(Mutex<BundleQueue>);

#[derive(Default)]
struct BundleQueue {
    page_listens: bool,
    paths: Vec<String>,
}

impl PendingBundles {
    /// Takes in the `.sbstems` files among `paths`. Returns the ones to send to the page now;
    /// the others were queued (the page has not asked yet).
    pub fn offer(&self, paths: impl IntoIterator<Item = PathBuf>) -> Vec<String> {
        let mut queue = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut now = Vec::new();
        for path in paths {
            let Some(path) = path.to_str().filter(|_| bundle::is_bundle(&path)) else {
                continue;
            };
            if queue.page_listens {
                now.push(path.to_owned());
            } else if !queue.paths.iter().any(|p| p == path) {
                queue.paths.push(path.to_owned());
            }
        }
        now
    }

    /// The waiting files. The page listens from now on.
    pub fn take(&self) -> Vec<String> {
        let mut queue = self.0.lock().unwrap_or_else(|e| e.into_inner());
        queue.page_listens = true;
        std::mem::take(&mut queue.paths)
    }
}

/// The files named in launch arguments (the first one is the program itself).
pub fn paths_from_args<I, S>(args: I) -> Vec<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .skip(1)
        .map(|arg| PathBuf::from(arg.as_ref()))
        .filter(|path| {
            (score_file::has_supported_extension(path) || bundle::is_bundle(path)) && path.is_file()
        })
        .collect()
}

/// The local files among `urls` (macOS hands over `file://` URLs).
pub fn paths_from_urls(urls: &[tauri::Url]) -> Vec<PathBuf> {
    urls.iter()
        .filter_map(|url| url.to_file_path().ok())
        .collect()
}

/// Queues `paths` and tells the page to collect them. `.sbstems` files go to the stems page.
pub fn deliver<R: Runtime>(app: &AppHandle<R>, paths: Vec<PathBuf>) {
    if let Some(bundles) = app.try_state::<PendingBundles>() {
        for path in bundles.offer(paths.iter().cloned()) {
            let _ = app.emit(STEMS_BUNDLE_OPENED_EVENT, BundleOpened { path });
        }
    }
    let Some(pending) = app.try_state::<PendingOpen>() else {
        return;
    };
    if pending.push(paths) > 0 {
        let _ = app.emit(OPEN_EXTERNAL_FILE_EVENT, ());
    }
}

#[derive(Clone, serde::Serialize)]
struct BundleOpened {
    path: String,
}

/// Queues the files the app was started with. The page is not there yet, so nothing is sent.
pub fn queue_at_launch<R: Runtime>(app: &AppHandle<R>, paths: Vec<PathBuf>) {
    app.state::<PendingOpen>().push(paths.iter().cloned());
    app.state::<PendingBundles>().offer(paths);
}

/// Brings the main window to the front, for a file opened while the app was in the background.
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// The files the system asked to open that the page has not collected yet.
#[tauri::command]
pub fn take_pending_open_files(pending: State<'_, PendingOpen>) -> Vec<String> {
    pending.take()
}

/// The `.sbstems` files the system asked to open that the page has not collected yet. Call it
/// after listening for `stems-bundle-opened`: later files come as events.
#[tauri::command]
pub fn take_pending_stem_bundles(pending: State<'_, PendingBundles>) -> Vec<String> {
    pending.take()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queues_only_supported_files_once() {
        let pending = PendingOpen::default();
        let added = pending.push([
            PathBuf::from("/songs/a.gp"),
            PathBuf::from("/songs/b.PDF"),
            PathBuf::from("/songs/a.gp"),
            PathBuf::from("/songs/c.MID"),
        ]);
        assert_eq!(added, 2);
        assert_eq!(pending.take(), ["/songs/a.gp", "/songs/c.MID"]);
        assert!(pending.take().is_empty());
    }

    #[test]
    fn launch_arguments_skip_the_program_flags_and_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let song = dir.path().join("song.gp5");
        std::fs::write(&song, b"x").unwrap();
        let args = [
            "/Applications/Smart Beat".to_string(),
            "--flag".to_string(),
            song.to_string_lossy().into_owned(),
            dir.path().join("gone.gp5").to_string_lossy().into_owned(),
            dir.path()
                .join("notes.txt.bak")
                .to_string_lossy()
                .into_owned(),
        ];
        assert_eq!(paths_from_args(args), [song]);
    }

    #[test]
    fn the_program_path_is_never_treated_as_a_song() {
        let dir = tempfile::tempdir().unwrap();
        let song = dir.path().join("first.gp");
        std::fs::write(&song, b"x").unwrap();
        assert!(paths_from_args([song.to_string_lossy().into_owned()]).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn file_urls_become_paths_and_other_urls_are_dropped() {
        let urls = [
            tauri::Url::parse("file:///songs/My%20Song.gp").unwrap(),
            tauri::Url::parse("https://example.com/a.gp").unwrap(),
        ];
        assert_eq!(paths_from_urls(&urls), [PathBuf::from("/songs/My Song.gp")]);
    }

    #[test]
    fn stems_files_are_queued_until_the_page_asks_and_sent_after_that() {
        let bundles = PendingBundles::default();
        // Scores are not theirs; the extension is matched without case; a file counts once.
        let sent = bundles.offer([
            PathBuf::from("/songs/a.gp"),
            PathBuf::from("/songs/Band.sbstems"),
            PathBuf::from("/songs/Band.sbstems"),
            PathBuf::from("/songs/Other.SBSTEMS"),
        ]);
        assert!(sent.is_empty());
        assert_eq!(
            bundles.take(),
            ["/songs/Band.sbstems", "/songs/Other.SBSTEMS"]
        );
        assert!(bundles.take().is_empty());
        // The page asked: files come straight through and are not queued as well.
        assert_eq!(
            bundles.offer([
                PathBuf::from("/songs/Late.sbstems"),
                PathBuf::from("/x.mid")
            ]),
            ["/songs/Late.sbstems"]
        );
        assert!(bundles.take().is_empty());
    }

    #[test]
    fn scores_do_not_enter_the_stems_queue_and_stems_files_not_the_score_queue() {
        let pending = PendingOpen::default();
        assert_eq!(pending.push([PathBuf::from("/songs/Band.sbstems")]), 0);
        assert!(pending.take().is_empty());
    }

    #[test]
    fn launch_arguments_include_existing_stems_files() {
        let dir = tempfile::tempdir().unwrap();
        let stems = dir.path().join("Band.sbstems");
        std::fs::write(&stems, b"x").unwrap();
        let args = [
            "/Applications/Smart Beat".to_string(),
            stems.to_string_lossy().into_owned(),
            dir.path()
                .join("gone.sbstems")
                .to_string_lossy()
                .into_owned(),
        ];
        assert_eq!(paths_from_args(args), [stems]);
    }
}
