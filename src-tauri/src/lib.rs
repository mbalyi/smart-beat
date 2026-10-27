//! Smart Beat desktop core: native window, menu bar, file access and IPC commands.

pub mod audio;
pub mod cloud;
pub mod cloud_commands;
pub mod cloud_folder;
mod commands;
#[cfg(test)]
mod dotenv;
pub mod error;
pub mod features;
pub mod m4a;
pub mod menu;
pub mod menu_state;
pub mod mixer;
pub mod open_file;
pub mod pdf;
pub mod project;
pub mod recent;
pub mod recording;
pub mod score_file;
pub mod score_write;
pub mod startup;
pub mod telemetry;
pub mod transcription;
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
        .manage(transcription::Dropped::default())
        .manage(open_file::PendingOpen::default())
        .manage(recording::muscriptor_model::DownloadRun::default())
        .manage(recording::RecordingRun::default())
        .setup(|app| {
            if app.try_state::<mixer::MixerStore>().is_none() {
                let dir = app.path().app_data_dir()?.join(MIXER_DIR);
                app.manage(mixer::MixerStore::new(dir));
            }
            if app.try_state::<audio::AudioState>().is_none() {
                let dir = app.path().app_data_dir()?.join(LIBRARY_DIR);
                app.manage(audio::AudioState::new(dir));
            }
            if app.try_state::<transcription::Running>().is_none() {
                app.manage(transcription::Running::default());
            }
            recent::ensure_store(app.handle())?;
            if app.try_state::<cloud_commands::CloudState>().is_none() {
                app.manage(cloud_commands::CloudState::new(
                    app.path().app_data_dir()?.join("pending"),
                ));
            }
            if app.try_state::<cloud_folder::CloudFolderStore>().is_none() {
                app.manage(cloud_folder::CloudFolderStore::new(
                    app.path().app_data_dir()?,
                ));
            }
            if app
                .try_state::<std::sync::Arc<telemetry::Telemetry>>()
                .is_none()
            {
                let dir = app.path().app_data_dir()?;
                let version = app.package_info().version.to_string();
                app.manage(std::sync::Arc::new(telemetry::Telemetry::new(
                    dir,
                    telemetry::ENDPOINT,
                    &version,
                )));
            }
            // Counters of an earlier session go out now, not when the page first tracks.
            if let Some(t) = app.try_state::<std::sync::Arc<telemetry::Telemetry>>() {
                t.flush_at_launch();
            }
            startup::show_later(app.handle());
            Ok(())
        })
        .on_page_load(startup::on_page_load)
        .on_window_event(|window, event| {
            // Import from Audio reads only files the user dropped (src/transcription.rs).
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                window.state::<transcription::Dropped>().record(paths);
            }
            // The last window is gone (the process may stay alive on macOS): send the counters.
            if matches!(event, tauri::WindowEvent::Destroyed)
                && window.app_handle().webview_windows().is_empty()
            {
                flush_on_quit(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::menu_shortcuts,
            commands::read_score_file,
            open_file::take_pending_open_files,
            commands::score_file_stamp,
            commands::write_score_file,
            commands::get_cloud_folder,
            commands::set_cloud_folder,
            commands::detect_cloud_folders,
            commands::list_cloud_scores,
            cloud_commands::cloud_accounts,
            cloud_commands::cloud_connect,
            cloud_commands::cloud_cancel_connect,
            cloud_commands::cloud_disconnect,
            cloud_commands::cloud_list,
            cloud_commands::cloud_read,
            cloud_commands::cloud_item_name,
            cloud_commands::cloud_save,
            cloud_commands::cloud_create,
            cloud_commands::cloud_pending,
            cloud_commands::cloud_flush,
            cloud_commands::cloud_discard_pending,
            commands::export_m4a,
            commands::export_pdf,
            commands::load_mixer_settings,
            commands::save_mixer_settings,
            commands::read_project_settings,
            commands::write_project_settings,
            commands::load_recent_files,
            commands::add_recent_file,
            commands::remove_recent_file,
            commands::clear_recent_files,
            transcription::read_transcription_audio,
            transcription::transcribe_audio,
            transcription::cancel_transcription,
            recording::transcribe_recording,
            recording::muscriptor_model::muscriptor_status,
            recording::muscriptor_model::accept_muscriptor_terms,
            recording::muscriptor_model::download_muscriptor_model,
            recording::muscriptor_model::cancel_muscriptor_download,
            recording::muscriptor_model::delete_muscriptor_model,
            recording::cancel_recording_transcription,
            recording::piano_model::piano_model_status,
            recording::piano_model::download_piano_model,
            commands::update_menu_state,
            commands::track_event,
            commands::get_usage_settings,
            commands::set_usage_settings,
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
            audio::audio_set_monitor,
            audio::audio_set_monitor_chain,
            audio::audio_input_channels,
            audio::audio_state,
            audio::audio_render,
            audio::library_list,
            audio::library_import,
            audio::library_update,
            audio::library_remove,
            audio::soundfonts_list,
            audio::soundfonts_catalogue,
            audio::soundfonts_import,
            audio::soundfonts_remove,
            audio::soundfonts_download,
            audio::soundfonts_cancel_download,
            audio::soundfonts_activate,
            audio::soundfonts_read,
            audio::kits_list,
            audio::kits_import,
            audio::kits_remove,
            audio::audio_set_track_kit,
            audio::plugins_scan,
            audio::plugins_set_enabled,
            audio::plugins_enabled,
            audio::plugin_open_editor,
            audio::plugin_close_editor,
            audio::plugin_save_state,
            audio::audio_plugin_info,
        ])
        .on_menu_event(menu::handle_event)
}

/// Starts the desktop application.
pub fn run() {
    let builder = Builder::default();
    // First, so a second launch hands its file to this instance before anything else starts.
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        open_file::deliver(app, open_file::paths_from_args(args));
        open_file::show_main_window(app);
    }));
    let app = setup(builder)
        // Not in `setup`: the updater needs its public key and endpoint from tauri.conf.json,
        // which the integration tests' mock context does not have.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .menu(menu::build)
        .build(tauri::generate_context!())
        .expect("error while building Smart Beat");
    // Windows and Linux start Smart Beat with the file as an argument.
    app.state::<open_file::PendingOpen>()
        .push(open_file::paths_from_args(std::env::args()));
    app.run(|app, event| {
        // macOS: Finder double-click or "Open With", also while the app is already running.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &event {
            open_file::deliver(app, open_file::paths_from_urls(urls));
            open_file::show_main_window(app);
        }
        if matches!(event, tauri::RunEvent::Exit) {
            // Stop what the AI engine is doing first: a running transcription holds the model,
            // and unloading it would wait for the end of the song. A download keeps its part.
            if let Some(running) = app.try_state::<transcription::Running>() {
                running.cancel_all();
            }
            app.state::<recording::RecordingRun>().cancel();
            app.state::<recording::muscriptor_model::DownloadRun>()
                .stop();
            // ggml's Metal backend asserts at process exit while a model is still loaded.
            recording::muscriptor::unload();
            flush_on_quit(app);
        }
    });
}

/// Sends the unsent usage counters once, ignoring the hourly pause. At most the upload timeout.
fn flush_on_quit<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(t) = app.try_state::<std::sync::Arc<telemetry::Telemetry>>() {
        t.flush_final();
    }
}
