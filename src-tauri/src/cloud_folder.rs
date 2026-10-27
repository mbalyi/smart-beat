//! The linked cloud folder (#187): a local folder that a cloud drive's desktop client keeps in
//! sync (Google Drive for desktop, OneDrive, Dropbox, iCloud Drive, Nextcloud, ...).
//!
//! Smart Beat only sees a folder. It offers the tabs in it, saves into it, waits for
//! online-only placeholders to download, and notices when a file changed on disk (maybe by the
//! sync client) since it was opened. The folder is remembered per machine in the app data folder.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{CommandError, ErrorKind};
use crate::score_file::{self, MAX_SIZE};

/// File name of the setting inside the app data folder.
pub const FILE_NAME: &str = "cloud-folder.json";

/// How long Open waits for an online-only file to download.
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);

/// A tab in the cloud folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CloudScore {
    pub name: String,
    pub path: String,
    pub size: u64,
    /// Milliseconds since the Unix epoch, 0 when unknown.
    pub modified_ms: u64,
    /// Online-only: the content is not on this machine yet.
    pub placeholder: bool,
}

/// A usual cloud folder found on this machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CloudFolderCandidate {
    pub provider: String,
    pub path: String,
}

/// What a file looked like when Smart Beat opened or saved it. A save over a file whose stamp
/// differs asks the user first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileStamp {
    pub modified_ms: u64,
    pub hash: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Stored {
    folder: Option<String>,
}

/// Reads and writes the cloud folder setting. Stored as Tauri state.
#[derive(Debug, Clone)]
pub struct CloudFolderStore {
    path: PathBuf,
}

impl CloudFolderStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            path: dir.into().join(FILE_NAME),
        }
    }

    /// The linked folder, if one is set. A damaged file reads as unset.
    pub fn load(&self) -> Option<String> {
        let json = fs::read_to_string(&self.path).ok()?;
        serde_json::from_str::<Stored>(&json)
            .ok()?
            .folder
            .filter(|folder| !folder.is_empty())
    }

    /// Links `folder` (it must exist) or unlinks with `None`.
    pub fn set(&self, folder: Option<&str>) -> Result<Option<String>, CommandError> {
        if let Some(folder) = folder
            && !Path::new(folder).is_dir()
        {
            return Err(CommandError::new(
                ErrorKind::NotFound,
                "That folder does not exist.",
            ));
        }
        let dir = self.path.parent().unwrap_or(Path::new("."));
        let io_error = |e: &io::Error| {
            CommandError::new(
                ErrorKind::Io,
                format!("The cloud folder could not be saved: {e}"),
            )
        };
        fs::create_dir_all(dir).map_err(|e| io_error(&e))?;
        let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|e| io_error(&e))?;
        let stored = Stored {
            folder: folder.map(str::to_owned),
        };
        serde_json::to_writer_pretty(&mut file, &stored)
            .map_err(io::Error::from)
            .and_then(|()| file.flush())
            .map_err(|e| io_error(&e))?;
        file.persist(&self.path).map_err(|e| io_error(&e.error))?;
        Ok(folder.map(str::to_owned))
    }
}

/// Usual cloud folders under `home` that exist, for the shortcut buttons in Settings.
pub fn detect_folders(home: &Path) -> Vec<CloudFolderCandidate> {
    let mut found = Vec::new();
    let mut add = |provider: &str, path: PathBuf| {
        if path.is_dir() {
            found.push(CloudFolderCandidate {
                provider: provider.to_owned(),
                path: path.to_string_lossy().into_owned(),
            });
        }
    };
    add(
        "iCloud Drive",
        home.join("Library/Mobile Documents/com~apple~CloudDocs"),
    );
    add("Dropbox", home.join("Dropbox"));
    add("OneDrive", home.join("OneDrive"));
    add("Google Drive", home.join("Google Drive"));
    add("Google Drive", home.join("My Drive"));
    add("Nextcloud", home.join("Nextcloud"));
    add("Box", home.join("Box"));
    add("pCloud", home.join("pCloudDrive"));
    add("MEGA", home.join("MEGA"));
    add("Proton Drive", home.join("Proton Drive"));
    if let Ok(entries) = fs::read_dir(home.join("Library/CloudStorage")) {
        let mut names: Vec<_> = entries.flatten().map(|e| e.path()).collect();
        names.sort();
        for path in names {
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let provider = if name.starts_with("GoogleDrive") {
                "Google Drive"
            } else if name.starts_with("OneDrive") {
                "OneDrive"
            } else if name.starts_with("Dropbox") {
                "Dropbox"
            } else if name.starts_with("ProtonDrive") {
                "Proton Drive"
            } else if name.starts_with("Box") {
                "Box"
            } else {
                continue;
            };
            add(provider, path);
        }
    }
    found.dedup();
    found
}

/// The tabs directly inside `folder`, newest first. Evicted iCloud files (`.name.icloud`) are
/// listed under their real name as placeholders.
pub fn list_scores(folder: &Path) -> Result<Vec<CloudScore>, CommandError> {
    let entries = fs::read_dir(folder).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => CommandError::new(
            ErrorKind::NotFound,
            "The cloud folder could not be found. Is the drive offline?",
        ),
        _ => CommandError::new(
            ErrorKind::Io,
            format!("The cloud folder could not be read: {e}"),
        ),
    })?;
    let mut scores = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let (name, placeholder) = match icloud_placeholder_name(&file_name) {
            Some(real) => (real, true),
            None => (file_name, false),
        };
        let real_path = folder.join(&name);
        if !score_file::has_supported_extension(&real_path) || name.starts_with('.') {
            continue;
        }
        scores.push(CloudScore {
            size: metadata.len(),
            modified_ms: modified_ms(&metadata),
            placeholder,
            path: real_path.to_string_lossy().into_owned(),
            name,
        });
        let _ = path;
    }
    scores.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then(a.name.cmp(&b.name)));
    Ok(scores)
}

/// `.Song.gp.icloud` is how iCloud Drive shows an evicted `Song.gp`.
fn icloud_placeholder_name(file_name: &str) -> Option<String> {
    let inner = file_name.strip_prefix('.')?.strip_suffix(".icloud")?;
    (!inner.is_empty()).then(|| inner.to_owned())
}

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Waits until `path` is on this machine, asking the sync client to download it when the file is
/// an evicted iCloud placeholder. Other providers (OneDrive, Dropbox, Drive) download on first
/// read, which the read itself waits for. `on_wait` is called once when waiting starts.
pub fn wait_for_download(
    path: &Path,
    timeout: Duration,
    request_download: impl Fn(&Path),
    on_wait: impl FnOnce(),
) -> Result<(), CommandError> {
    if path.is_file() {
        return Ok(());
    }
    let placeholder = path
        .parent()
        .zip(path.file_name())
        .map(|(dir, name)| dir.join(format!(".{}.icloud", name.to_string_lossy())));
    let Some(placeholder) = placeholder.filter(|p| p.is_file()) else {
        return Err(CommandError::new(
            ErrorKind::NotFound,
            format!("“{}” could not be found.", file_label(path)),
        ));
    };
    on_wait();
    request_download(&placeholder);
    let start = Instant::now();
    while start.elapsed() < timeout {
        if path.is_file() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(CommandError::new(
        ErrorKind::DownloadTimeout,
        format!(
            "“{}” is still downloading from the cloud. Check your connection and try again.",
            file_label(path)
        ),
    ))
}

/// Asks macOS to download an evicted iCloud file.
pub fn request_icloud_download(placeholder: &Path) {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("brctl")
            .arg("download")
            .arg(placeholder)
            .status();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = placeholder;
}

fn file_label(path: &Path) -> String {
    path.file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned()
}

/// The stamp of the file at `path`, `None` when it does not exist.
pub fn stamp(path: &Path) -> Result<Option<FileStamp>, CommandError> {
    let metadata = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(CommandError::new(
                ErrorKind::Io,
                format!("“{}” could not be read: {e}", file_label(path)),
            ));
        }
    };
    if metadata.len() > MAX_SIZE {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|e| {
        CommandError::new(
            ErrorKind::Io,
            format!("“{}” could not be read: {e}", file_label(path)),
        )
    })?;
    Ok(Some(FileStamp {
        modified_ms: modified_ms(&metadata),
        hash: hash_hex(&bytes),
    }))
}

/// Lower-case SHA-256 hex digest of `bytes`.
pub fn hash_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut out, b| {
            let _ = write!(out, "{b:02x}");
            out
        })
}

/// Whether the file on disk differs from what Smart Beat last saw. Same content with a new
/// modified time (a sync client touching the file) is not a conflict.
pub fn changed_since(path: &Path, expected: &FileStamp) -> Result<bool, CommandError> {
    match stamp(path)? {
        None => Ok(false),
        Some(now) => Ok(now.hash != expected.hash),
    }
}

/// Seconds since the Unix epoch.
pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembers_and_clears_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let store = CloudFolderStore::new(dir.path().join("data"));
        assert_eq!(store.load(), None);
        let target = tempfile::tempdir().unwrap();
        let path = target.path().to_string_lossy().into_owned();
        assert_eq!(
            store.set(Some(&path)).unwrap().as_deref(),
            Some(path.as_str())
        );
        assert_eq!(store.load().as_deref(), Some(path.as_str()));
        store.set(None).unwrap();
        assert_eq!(store.load(), None);
    }

    #[test]
    fn refuses_a_folder_that_does_not_exist() {
        let dir = tempfile::tempdir().unwrap();
        let store = CloudFolderStore::new(dir.path());
        let error = store.set(Some("/definitely/not/here")).unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);
        assert_eq!(store.load(), None);
    }

    #[test]
    fn a_damaged_setting_reads_as_unset() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE_NAME), "{nope").unwrap();
        assert_eq!(CloudFolderStore::new(dir.path()).load(), None);
    }

    #[test]
    fn lists_tabs_newest_first_and_skips_other_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.gp"), b"x").unwrap();
        fs::write(dir.path().join("notes.docx"), b"x").unwrap();
        fs::write(dir.path().join(".hidden.gp"), b"x").unwrap();
        fs::create_dir(dir.path().join("sub.gp")).unwrap();
        let scores = list_scores(dir.path()).unwrap();
        assert_eq!(scores.len(), 1);
        assert_eq!(scores[0].name, "a.gp");
        assert!(!scores[0].placeholder);
    }

    #[test]
    fn lists_evicted_icloud_files_as_placeholders() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".Song.gp5.icloud"), b"plist").unwrap();
        let scores = list_scores(dir.path()).unwrap();
        assert_eq!(scores.len(), 1);
        assert_eq!(scores[0].name, "Song.gp5");
        assert!(scores[0].placeholder);
        assert!(scores[0].path.ends_with("Song.gp5"));
    }

    #[test]
    fn a_missing_folder_is_reported() {
        let error = list_scores(Path::new("/definitely/not/here")).unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);
    }

    #[test]
    fn detects_usual_provider_folders() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir(home.path().join("Dropbox")).unwrap();
        fs::create_dir_all(home.path().join("Library/CloudStorage/GoogleDrive-a@b.c")).unwrap();
        fs::create_dir_all(
            home.path()
                .join("Library/CloudStorage/ProtonDrive-a@proton.me-folder"),
        )
        .unwrap();
        fs::create_dir(home.path().join("Proton Drive")).unwrap();
        let found = detect_folders(home.path());
        let providers: Vec<_> = found.iter().map(|c| c.provider.as_str()).collect();
        assert_eq!(
            providers,
            ["Dropbox", "Proton Drive", "Google Drive", "Proton Drive"]
        );
    }

    #[test]
    fn stamps_tell_changed_content_from_a_touched_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.gp");
        assert_eq!(stamp(&path).unwrap(), None);
        fs::write(&path, b"one").unwrap();
        let opened = stamp(&path).unwrap().unwrap();
        assert!(!changed_since(&path, &opened).unwrap());
        // Rewriting the same bytes (a sync client touching the file) is not a change.
        fs::write(&path, b"one").unwrap();
        assert!(!changed_since(&path, &opened).unwrap());
        fs::write(&path, b"two").unwrap();
        assert!(changed_since(&path, &opened).unwrap());
    }

    #[test]
    fn waiting_returns_at_once_for_a_local_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.gp");
        fs::write(&path, b"x").unwrap();
        wait_for_download(
            &path,
            Duration::from_millis(10),
            |_| {},
            || panic!("no wait"),
        )
        .unwrap();
    }

    #[test]
    fn waiting_picks_up_a_file_once_it_downloads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.gp");
        fs::write(dir.path().join(".a.gp.icloud"), b"plist").unwrap();
        let target = path.clone();
        let waited = std::cell::Cell::new(false);
        wait_for_download(
            &path,
            Duration::from_secs(5),
            |_| {
                let target = target.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(100));
                    fs::write(target, b"x").unwrap();
                });
            },
            || waited.set(true),
        )
        .unwrap();
        assert!(waited.get());
    }

    #[test]
    fn a_download_that_never_finishes_times_out() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".a.gp.icloud"), b"plist").unwrap();
        let error = wait_for_download(
            &dir.path().join("a.gp"),
            Duration::from_millis(300),
            |_| {},
            || {},
        )
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::DownloadTimeout);
    }

    #[test]
    fn a_missing_file_without_a_placeholder_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let error =
            wait_for_download(&dir.path().join("a.gp"), Duration::ZERO, |_| {}, || {}).unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);
    }
}
