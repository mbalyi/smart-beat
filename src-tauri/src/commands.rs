//! IPC commands callable from the webview with `invoke()`. Thin wrappers: the
//! logic lives in the domain modules.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, PackageInfo, Runtime, State};

use crate::audio::AudioState;
use crate::cloud_folder::{self, CloudFolderCandidate, CloudFolderStore, CloudScore, FileStamp};
use crate::error::{CommandError, ErrorKind};
use crate::m4a;
use crate::menu::{self, Shortcut};
use crate::menu_state::{self, MenuState, MenuStateStore};
use crate::mixer::{FileKey, MixerSettings, MixerStore};
use crate::pdf;
use crate::project;
use crate::recent::RecentStore;
use crate::score_file;
use crate::score_write;
use crate::telemetry::{Event, Telemetry, UsageSettings};

/// Build and platform details shown in the About dialog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub tauri_version: String,
    /// `std::env::consts::OS`: `macos`, `windows` or `linux`.
    pub os: String,
    /// `std::env::consts::ARCH`: `aarch64`, `x86_64`, ...
    pub arch: String,
}

impl AppInfo {
    pub fn from_package(package: &PackageInfo) -> Self {
        Self {
            name: package.name.clone(),
            version: package.version.to_string(),
            tauri_version: tauri::VERSION.to_string(),
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
        }
    }
}

#[tauri::command]
pub fn app_info<R: Runtime>(app: AppHandle<R>) -> AppInfo {
    AppInfo::from_package(app.package_info())
}

/// Menu shortcuts for the current platform, for the Keyboard Shortcuts dialog.
#[tauri::command]
pub fn menu_shortcuts() -> Vec<Shortcut> {
    menu::shortcuts(std::env::consts::OS)
}

/// Reads a Guitar Pro file picked or dropped by the user. The bytes are sent
/// as a raw `ArrayBuffer` rather than a JSON array of numbers.
#[tauri::command(async)]
pub fn read_score_file<R: Runtime>(
    app: AppHandle<R>,
    path: PathBuf,
) -> Result<Response, CommandError> {
    // An online-only cloud file (iCloud evicted, #187) is downloaded first.
    cloud_folder::wait_for_download(
        &path,
        cloud_folder::DOWNLOAD_TIMEOUT,
        cloud_folder::request_icloud_download,
        || {
            let _ = app.emit(
                "cloud-download-waiting",
                path.to_string_lossy().into_owned(),
            );
        },
    )
    .or_else(|error| {
        // A plain missing file keeps the reader's own message.
        if error.kind == ErrorKind::NotFound {
            Ok(())
        } else {
            Err(error)
        }
    })?;
    score_file::read(&path).map(Response::new)
}

/// What the file at `path` looks like now, to detect later changes. `null` if it is missing.
#[tauri::command(async)]
pub fn score_file_stamp(path: PathBuf) -> Result<Option<FileStamp>, CommandError> {
    cloud_folder::stamp(&path)
}

/// Writes a song or export. The content is the raw request body and the
/// destination is the URL-encoded `path` header, so large files are not
/// serialized as JSON arrays.
#[tauri::command(async)]
pub fn write_score_file(request: tauri::ipc::Request<'_>) -> Result<(), CommandError> {
    let (path, bytes) = destination_and_body(&request)?;
    // Saving over a file that changed since it was opened asks first (#187): the UI sends the
    // hash it saw and gets a `conflict` error back.
    if let Some(expected) = request
        .headers()
        .get("expected-hash")
        .and_then(|v| v.to_str().ok())
    {
        let expected = FileStamp {
            modified_ms: 0,
            hash: expected.to_owned(),
        };
        if cloud_folder::changed_since(Path::new(&path), &expected)? {
            return Err(CommandError::new(
                ErrorKind::Conflict,
                "This file changed since you opened it.",
            ));
        }
    }
    score_write::write(Path::new(&path), bytes)
}

/// The linked cloud folder, if any.
#[tauri::command(async)]
pub fn get_cloud_folder(store: State<'_, CloudFolderStore>) -> Option<String> {
    store.load()
}

/// Links a folder (or unlinks with `null`) and returns the new setting.
#[tauri::command(async)]
pub fn set_cloud_folder(
    store: State<'_, CloudFolderStore>,
    folder: Option<String>,
) -> Result<Option<String>, CommandError> {
    store.set(folder.as_deref())
}

/// Usual cloud drive folders on this machine, for the shortcuts in Settings.
#[tauri::command(async)]
pub fn detect_cloud_folders<R: Runtime>(app: AppHandle<R>) -> Vec<CloudFolderCandidate> {
    use tauri::Manager;
    app.path()
        .home_dir()
        .map(|home| cloud_folder::detect_folders(&home))
        .unwrap_or_default()
}

/// The tabs in the linked cloud folder.
#[tauri::command(async)]
pub fn list_cloud_scores(
    store: State<'_, CloudFolderStore>,
) -> Result<Vec<CloudScore>, CommandError> {
    let Some(folder) = store.load() else {
        return Ok(Vec::new());
    };
    cloud_folder::list_scores(Path::new(&folder))
}

/// Exports audio as AAC: the request body is the rendered 16-bit WAV file and
/// the `path` header the `.m4a` file to write, as for [`write_score_file`].
/// The system's own encoder does the work (macOS only for now).
#[tauri::command(async)]
pub fn export_m4a(request: tauri::ipc::Request<'_>) -> Result<(), CommandError> {
    let (path, bytes) = destination_and_body(&request)?;
    m4a::encode(bytes, Path::new(&path))
}

/// Exports the window's print copy of the score as PDF to `path` (macOS; #83). The UI puts
/// the copy in place first (see `src/lib/print.ts`).
#[tauri::command(async)]
pub fn export_pdf<R: Runtime>(
    webview: tauri::Webview<R>,
    path: String,
    page: pdf::PdfPage,
) -> Result<(), CommandError> {
    pdf::export(&webview, Path::new(&path), page)
}

/// The URL-decoded `path` header and the raw body of a file-writing request.
fn destination_and_body<'a>(
    request: &'a tauri::ipc::Request<'_>,
) -> Result<(String, &'a [u8]), CommandError> {
    let invalid = |message: &str| CommandError::new(ErrorKind::Io, message);
    let header = request
        .headers()
        .get("path")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| invalid("The destination path is missing."))?;
    let path = percent_decode(header).ok_or_else(|| invalid("The destination path is invalid."))?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(invalid("The file content is missing."));
    };
    Ok((path, bytes))
}

/// Decodes `encodeURIComponent` output.
pub(crate) fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Saved mixer settings for a song (`fileKey`: SHA-256 of its content), if any.
#[tauri::command(async)]
pub fn load_mixer_settings(
    store: State<'_, MixerStore>,
    file_key: String,
) -> Result<Option<MixerSettings>, CommandError> {
    store.load(&FileKey::parse(&file_key)?)
}

#[tauri::command(async)]
pub fn save_mixer_settings(
    store: State<'_, MixerStore>,
    file_key: String,
    settings: MixerSettings,
) -> Result<(), CommandError> {
    store.save(&FileKey::parse(&file_key)?, &settings)
}

/// Mixer settings stored inside a `.gp` file (`null` for other files or none).
#[tauri::command(async)]
pub fn read_project_settings(path: PathBuf) -> Result<Option<MixerSettings>, CommandError> {
    project::read_settings(&path)
}

/// Stores mixer settings inside a `.gp` file that was just saved. With
/// `embed_audio`, the loaded audio track's recording goes in too.
#[tauri::command(async)]
pub fn write_project_settings(
    audio: State<'_, AudioState>,
    path: PathBuf,
    settings: MixerSettings,
    embed_audio: bool,
) -> Result<(), CommandError> {
    let recording = if embed_audio {
        let wanted = settings.audio_track.as_ref().map(|t| t.name.clone());
        match (audio.backing_bytes(), wanted) {
            (Some((name, bytes)), Some(wanted)) if name == wanted => Some((name, bytes)),
            _ => {
                return Err(CommandError::new(
                    ErrorKind::Audio,
                    "The audio track is not loaded, so it cannot be embedded.",
                ));
            }
        }
    } else {
        None
    };
    project::write_settings(
        &path,
        &settings,
        recording
            .as_ref()
            .map(|(name, bytes)| (name.as_str(), bytes.as_slice())),
    )
}

/// The recently opened songs, most recent first (at most 10).
#[tauri::command(async)]
pub fn load_recent_files(store: State<'_, RecentStore>) -> Vec<String> {
    store.load()
}

/// Remembers `path` as the most recently opened song and updates File › Open Recent.
#[tauri::command(async)]
pub fn add_recent_file<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, RecentStore>,
    path: String,
) -> Result<Vec<String>, CommandError> {
    let paths = store.add(&path)?;
    menu::refresh_recent_menu(&app, &paths);
    Ok(paths)
}

/// Forgets a song that can no longer be opened.
#[tauri::command(async)]
pub fn remove_recent_file<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, RecentStore>,
    path: String,
) -> Result<Vec<String>, CommandError> {
    let paths = store.remove(&path)?;
    menu::refresh_recent_menu(&app, &paths);
    Ok(paths)
}

/// Clears the recent files list.
#[tauri::command(async)]
pub fn clear_recent_files<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, RecentStore>,
) -> Result<Vec<String>, CommandError> {
    let paths = store.clear()?;
    menu::refresh_recent_menu(&app, &paths);
    Ok(paths)
}

/// Counts one use of a feature (docs/analytics.md). Never fails the UI: errors are swallowed
/// except an unknown file format, which is a bug in the caller.
#[tauri::command(async)]
pub fn track_event(
    telemetry: State<'_, std::sync::Arc<Telemetry>>,
    event: Event,
    format: Option<String>,
) -> Result<(), CommandError> {
    telemetry.record(event, format.as_deref())?;
    telemetry.flush_in_background();
    Ok(())
}

/// Whether anonymous usage counters are on, available in this build, and explained to the user.
#[tauri::command]
pub fn get_usage_settings(telemetry: State<'_, std::sync::Arc<Telemetry>>) -> UsageSettings {
    telemetry.settings()
}

/// Switches the usage counters on or off and/or marks the one-time notice as shown.
#[tauri::command(async)]
pub fn set_usage_settings(
    telemetry: State<'_, std::sync::Arc<Telemetry>>,
    enabled: Option<bool>,
    notice_seen: Option<bool>,
) -> Result<UsageSettings, CommandError> {
    telemetry.update_settings(enabled, notice_seen)
}

/// Updates the menu bar to match the UI (undo labels, check marks, enabled items).
#[tauri::command]
pub fn update_menu_state<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, MenuStateStore>,
    state: MenuState,
) -> Result<(), CommandError> {
    state.validate()?;
    if let Err(error) = menu_state::apply(&app, &state) {
        // The menu is a convenience: never fail the UI over it.
        eprintln!("could not update the menu: {error}");
    }
    store.set(state);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package() -> PackageInfo {
        PackageInfo {
            name: "Smart Beat".into(),
            version: "1.2.3".parse().unwrap(),
            authors: "",
            description: "",
            crate_name: "smart-beat",
        }
    }

    #[test]
    fn app_info_reflects_package_and_platform() {
        let info = AppInfo::from_package(&package());
        assert_eq!(info.name, "Smart Beat");
        assert_eq!(info.version, "1.2.3");
        assert_eq!(info.tauri_version, tauri::VERSION);
        assert_eq!(info.os, std::env::consts::OS);
        assert_eq!(info.arch, std::env::consts::ARCH);
    }

    #[test]
    fn app_info_serializes_camel_case() {
        let json = serde_json::to_value(AppInfo::from_package(&package())).unwrap();
        assert!(json.get("tauriVersion").is_some());
        assert!(json.get("tauri_version").is_none());
    }

    #[test]
    fn decodes_uri_components() {
        assert_eq!(
            percent_decode("%2FUsers%2Fm%20b%2Fsong%20%C3%A9.gp5").as_deref(),
            Some("/Users/m b/song é.gp5")
        );
        assert_eq!(percent_decode("plain.gp5").as_deref(), Some("plain.gp5"));
        assert_eq!(percent_decode("bad%zz"), None);
        assert_eq!(percent_decode("cut%2"), None);
        assert_eq!(percent_decode("%FF"), None);
    }

    #[test]
    fn menu_shortcuts_are_for_this_platform() {
        assert_eq!(menu_shortcuts(), menu::shortcuts(std::env::consts::OS));
    }
}
