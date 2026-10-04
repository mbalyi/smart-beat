//! Smart Beat desktop core: native window, menu bar, file access and IPC commands.

pub mod audio;
mod commands;
pub mod error;
pub mod menu;
pub mod menu_state;
pub mod mixer;
pub mod project;
pub mod recent;
pub mod score_file;
pub mod score_write;
pub mod startup;
pub mod zoom;

pub use commands::AppInfo;
use tauri::{Builder, Manager, Runtime};

/// Folder (inside the app data folder) that holds per-song mixer settings.
const MIXER_DIR: &str = "mixer";
/// Folder (inside the app data folder) of the user's sound library.
const LIBRARY_DIR: &str = "library";

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
            if app.try_state::<audio::AudioState>().is_none() {
                let dir = app.path().app_data_dir()?.join(LIBRARY_DIR);
                app.manage(audio::AudioState::new(dir));
            }
            recent::ensure_store(app.handle())?;
            startup::show_later(app.handle());
            Ok(())
        })
        .on_page_load(startup::on_page_load)
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::menu_shortcuts,
            commands::read_score_file,
            commands::write_score_file,
            commands::load_mixer_settings,
            commands::save_mixer_settings,
            commands::read_project_settings,
            commands::write_project_settings,
            commands::load_recent_files,
            commands::add_recent_file,
            commands::remove_recent_file,
            commands::clear_recent_files,
            commands::update_menu_state,
            audio::audio_load_soundfont,
            audio::audio_start,
            audio::audio_stop,
            audio::audio_load_song,
            audio::audio_transport,
            audio::audio_set_mix,
            audio::audio_set_chain,
            audio::audio_set_sounds,
            audio::audio_set_automation,
            audio::audio_set_track_eq,
            audio::audio_set_drum_mix,
            audio::audio_load_backing,
            audio::audio_set_backing,
            audio::audio_clear_backing,
            audio::audio_state,
            audio::audio_render,
            audio::library_list,
            audio::library_import,
            audio::library_update,
            audio::library_remove,
            audio::kits_list,
            audio::kits_import,
            audio::kits_remove,
            audio::audio_set_track_kit,
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
