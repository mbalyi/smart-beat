//! Smart Beat desktop core: native window, menu bar and IPC commands.

mod commands;
pub mod menu;
pub mod zoom;

pub use commands::AppInfo;
use tauri::{Builder, Runtime};

/// Registers state, commands and menu handling on `builder`.
///
/// Shared by [`run`] and the integration tests, which pass Tauri's mock runtime.
pub fn setup<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder
        .manage(zoom::ZoomState::default())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::menu_shortcuts
        ])
        .on_menu_event(menu::handle_event)
}

/// Starts the desktop application.
pub fn run() {
    setup(Builder::default())
        .menu(menu::build)
        .run(tauri::generate_context!())
        .expect("error while running Smart Beat");
}
