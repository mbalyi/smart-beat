//! IPC commands callable from the webview with `invoke()`. Thin wrappers: the
//! logic lives in the domain modules.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::ipc::Response;
use tauri::{AppHandle, PackageInfo, Runtime, State};

use crate::error::{CommandError, ErrorKind};
use crate::menu::{self, Shortcut};
use crate::menu_state::{self, MenuState, MenuStateStore};
use crate::mixer::{FileKey, MixerSettings, MixerStore};
use crate::recent::RecentStore;
use crate::score_file;
use crate::score_write;

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
pub fn read_score_file(path: PathBuf) -> Result<Response, CommandError> {
    score_file::read(&path).map(Response::new)
}

/// Writes a song or export. The content is the raw request body and the
/// destination is the URL-encoded `path` header, so large files are not
/// serialized as JSON arrays.
#[tauri::command(async)]
pub fn write_score_file(request: tauri::ipc::Request<'_>) -> Result<(), CommandError> {
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
    score_write::write(Path::new(&path), bytes)
}

/// Decodes `encodeURIComponent` output.
fn percent_decode(text: &str) -> Option<String> {
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
