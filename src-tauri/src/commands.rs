//! IPC commands callable from the webview with `invoke()`.

use serde::Serialize;
use tauri::{AppHandle, PackageInfo, Runtime};

use crate::menu::{self, Shortcut};

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
