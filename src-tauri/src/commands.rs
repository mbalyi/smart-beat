//! IPC commands callable from the webview with `invoke()`. Thin wrappers: the
//! logic lives in the domain modules.

use std::path::PathBuf;

use serde::Serialize;
use tauri::ipc::Response;
use tauri::{AppHandle, PackageInfo, Runtime, State};

use crate::error::CommandError;
use crate::menu::{self, Shortcut};
use crate::menu_state::{self, MenuState, MenuStateStore};
use crate::mixer::{FileKey, MixerSettings, MixerStore};
use crate::score_file;

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
    fn menu_shortcuts_are_for_this_platform() {
        assert_eq!(menu_shortcuts(), menu::shortcuts(std::env::consts::OS));
    }
}
