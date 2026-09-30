//! Smart Beat desktop core: native window, menu bar, file access and IPC commands.

mod commands;
pub mod error;
pub mod menu;
pub mod menu_state;
pub mod mixer;
pub mod score_file;
pub mod zoom;

pub use commands::AppInfo;
use tauri::{Builder, Manager, Runtime};

/// Folder (inside the app data folder) that holds per-song mixer settings.
const MIXER_DIR: &str = "mixer";

/// Registers plugins, state, commands and menu handling on `builder`.
///
/// Shared by [`run`] and the integration tests, which pass Tauri's mock runtime.
/// Tests can manage their own [`mixer::MixerStore`] (e.g. in a temp folder)
/// before calling this; otherwise it is stored in the app data folder.
pub fn setup<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(zoom::ZoomState::default())
        .manage(menu_state::MenuStateStore::default())
        .setup(|app| {
            if app.try_state::<mixer::MixerStore>().is_none() {
                let dir = app.path().app_data_dir()?.join(MIXER_DIR);
                app.manage(mixer::MixerStore::new(dir));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::menu_shortcuts,
            commands::read_score_file,
            commands::load_mixer_settings,
            commands::save_mixer_settings,
            commands::update_menu_state,
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
