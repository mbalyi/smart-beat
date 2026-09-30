//! Integration tests: the real `setup()` wiring on Tauri's mock runtime.

use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{Value, json};
use smart_beat_lib::menu::{self, MAIN_WINDOW, MENU_EVENT, MenuAction};
use smart_beat_lib::menu_state::MenuStateStore;
use smart_beat_lib::mixer::MixerStore;
use smart_beat_lib::zoom::ZoomState;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::menu::{MenuEvent, MenuId};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{App, Listener, Manager, WebviewWindow, WebviewWindowBuilder};

const FILE_KEY: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

fn app() -> App<MockRuntime> {
    smart_beat_lib::setup(mock_builder())
        .build(mock_context(noop_assets()))
        .expect("failed to build app")
}

/// An app whose mixer settings live in `dir` instead of the app data folder.
fn app_with_mixer_dir(dir: &Path) -> App<MockRuntime> {
    smart_beat_lib::setup(mock_builder().manage(MixerStore::new(dir)))
        .build(mock_context(noop_assets()))
        .expect("failed to build app")
}

fn main_window(app: &App<MockRuntime>) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, MAIN_WINDOW, Default::default())
        .build()
        .expect("failed to create window")
}

fn invoke(window: &WebviewWindow<MockRuntime>, cmd: &str) -> Result<Value, Value> {
    invoke_with(window, cmd, json!({})).map(|body| body.deserialize::<Value>().unwrap())
}

fn invoke_with(
    window: &WebviewWindow<MockRuntime>,
    cmd: &str,
    args: Value,
) -> Result<InvokeResponseBody, Value> {
    let url = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: url.parse().unwrap(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

/// Header of a Guitar Pro 5 file: length byte + version text, padded to 31 bytes.
fn gp5_bytes() -> Vec<u8> {
    let version = b"FICHIER GUITAR PRO v5.00";
    let mut bytes = vec![version.len() as u8];
    bytes.extend_from_slice(version);
    bytes.resize(31, 0);
    bytes
}

#[test]
fn app_info_is_returned_over_ipc() {
    let app = app();
    let window = main_window(&app);

    let info = invoke(&window, "app_info").expect("app_info failed");

    assert_eq!(info["name"], "test"); // name from mock_context()
    assert_eq!(info["version"], "0.1.0");
    assert_eq!(info["tauriVersion"], tauri::VERSION);
    assert_eq!(info["os"], std::env::consts::OS);
    assert_eq!(info["arch"], std::env::consts::ARCH);
}

#[test]
fn menu_shortcuts_are_returned_over_ipc() {
    let app = app();
    let window = main_window(&app);

    let shortcuts = invoke(&window, "menu_shortcuts").expect("menu_shortcuts failed");
    let shortcuts = shortcuts.as_array().expect("expected an array");

    let open = shortcuts
        .iter()
        .find(|s| s["action"] == "open")
        .expect("Open… shortcut missing");
    assert_eq!(open["menu"], "File");
    assert_eq!(open["label"], "Open…");
    assert!(open["keys"].as_array().unwrap().contains(&Value::from("O")));
    assert!(open["spoken"].as_str().unwrap().ends_with("+O"));
}

#[test]
fn unknown_commands_are_rejected() {
    let app = app();
    let window = main_window(&app);

    assert!(invoke(&window, "does_not_exist").is_err());
}

#[test]
fn ui_menu_actions_are_forwarded_to_the_webview() {
    let app = app();
    let _window = main_window(&app);
    let (tx, rx) = mpsc::channel();
    app.listen_any(MENU_EVENT, move |event| {
        tx.send(event.payload().to_string()).unwrap();
    });

    for action in MenuAction::ALL.into_iter().filter(|a| !a.is_native()) {
        menu::dispatch(app.handle(), action).expect("dispatch failed");
        let payload = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("no menu event emitted");
        assert_eq!(payload, serde_json::to_string(&action).unwrap());
    }
}

#[test]
fn native_menu_actions_are_not_forwarded() {
    let app = app();
    let _window = main_window(&app);
    let (tx, rx) = mpsc::channel();
    app.listen_any(MENU_EVENT, move |event| {
        tx.send(event.payload().to_string()).unwrap();
    });

    menu::dispatch(app.handle(), MenuAction::ZoomIn).expect("dispatch failed");

    assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
}

#[test]
fn zoom_actions_update_the_zoom_level() {
    let app = app();
    let _window = main_window(&app);
    let zoom = || app.state::<ZoomState>().level();

    menu::dispatch(app.handle(), MenuAction::ZoomIn).unwrap();
    menu::dispatch(app.handle(), MenuAction::ZoomIn).unwrap();
    assert_eq!(zoom(), 1.25);

    menu::dispatch(app.handle(), MenuAction::ZoomOut).unwrap();
    assert_eq!(zoom(), 1.1);

    menu::dispatch(app.handle(), MenuAction::ZoomReset).unwrap();
    assert_eq!(zoom(), 1.0);
}

#[test]
fn menu_events_are_routed_by_item_id() {
    let app = app();
    let _window = main_window(&app);
    let (tx, rx) = mpsc::channel();
    app.listen_any(MENU_EVENT, move |event| {
        tx.send(event.payload().to_string()).unwrap();
    });
    let click = |id: &str| {
        menu::handle_event(
            app.handle(),
            MenuEvent {
                id: MenuId::new(id),
            },
        )
    };

    // Predefined items (e.g. Copy) have ids we don't own: nothing is emitted.
    click("edit.copy");
    assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());

    click(MenuAction::About.id());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        "\"about\""
    );
}

#[test]
fn read_score_file_returns_the_file_as_raw_bytes() {
    let app = app();
    let window = main_window(&app);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("song.gp5");
    std::fs::write(&path, gp5_bytes()).unwrap();

    let body = invoke_with(&window, "read_score_file", json!({ "path": path }))
        .expect("read_score_file failed");

    // Raw bytes reach the webview as an ArrayBuffer, not a JSON number array.
    let InvokeResponseBody::Raw(bytes) = body else {
        panic!("expected a raw response, got {body:?}");
    };
    assert_eq!(bytes, gp5_bytes());
}

#[test]
fn read_score_file_reports_structured_errors() {
    let app = app();
    let window = main_window(&app);
    let dir = tempfile::tempdir().unwrap();
    let text = dir.path().join("notes.txt");
    std::fs::write(&text, "hello").unwrap();
    let fake = dir.path().join("fake.gp5");
    std::fs::write(&fake, "hello").unwrap();

    let error_kind = |path: &Path| {
        invoke_with(&window, "read_score_file", json!({ "path": path })).unwrap_err()["kind"]
            .clone()
    };

    assert_eq!(error_kind(&dir.path().join("missing.gp")), "not-found");
    assert_eq!(error_kind(&text), "unsupported-type");
    assert_eq!(error_kind(&fake), "not-a-score");
}

#[test]
fn mixer_settings_round_trip_over_ipc() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with_mixer_dir(dir.path());
    let window = main_window(&app);
    let settings = json!({
        "version": 1,
        "master": 0.5,
        "tracks": [{ "volume": 0.25, "pan": -1.0, "mute": true, "solo": false }],
    });

    let load = || {
        invoke_with(
            &window,
            "load_mixer_settings",
            json!({ "fileKey": FILE_KEY }),
        )
        .expect("load_mixer_settings failed")
        .deserialize::<Value>()
        .unwrap()
    };

    assert_eq!(load(), Value::Null);
    invoke_with(
        &window,
        "save_mixer_settings",
        json!({ "fileKey": FILE_KEY, "settings": settings }),
    )
    .expect("save_mixer_settings failed");
    assert_eq!(load(), settings);
    assert!(dir.path().join(format!("{FILE_KEY}.json")).is_file());
}

#[test]
fn mixer_commands_validate_their_input() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with_mixer_dir(dir.path());
    let window = main_window(&app);

    let error = invoke_with(
        &window,
        "load_mixer_settings",
        json!({ "fileKey": "../../etc/passwd" }),
    )
    .unwrap_err();
    assert_eq!(error["kind"], "invalid-key");

    let error = invoke_with(
        &window,
        "save_mixer_settings",
        json!({
            "fileKey": FILE_KEY,
            "settings": { "version": 1, "master": 3.0, "tracks": [] },
        }),
    )
    .unwrap_err();
    assert_eq!(error["kind"], "invalid-settings");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn menu_state_updates_are_stored() {
    let app = app();
    let window = main_window(&app);

    invoke_with(
        &window,
        "update_menu_state",
        json!({
            "state": {
                "songOpen": true,
                "undo": "Add Note",
                "redo": null,
                "canRemoveTrack": true,
                "editMode": true,
                "fretboard": false,
                "loop": true,
                "metronome": false,
                "countIn": false,
            }
        }),
    )
    .expect("update_menu_state failed");

    let state = app.state::<MenuStateStore>().get();
    assert!(state.song_open && state.edit_mode && state.looping);
    assert_eq!(state.undo.as_deref(), Some("Add Note"));
}

#[test]
fn menu_state_updates_are_validated() {
    let app = app();
    let window = main_window(&app);
    let state = |undo: &str| {
        json!({
            "state": {
                "songOpen": true, "undo": undo, "redo": null, "canRemoveTrack": false,
                "editMode": false, "fretboard": false, "loop": false, "metronome": false,
                "countIn": false,
            }
        })
    };

    let error = invoke_with(&window, "update_menu_state", state("Add\nNote")).unwrap_err();
    assert_eq!(error["kind"], "invalid-menu-state");
    let error = invoke_with(&window, "update_menu_state", state(&"x".repeat(61))).unwrap_err();
    assert_eq!(error["kind"], "invalid-menu-state");
    // Missing fields are a malformed request, not a crash.
    assert!(invoke_with(&window, "update_menu_state", json!({ "state": {} })).is_err());
    assert!(!app.state::<MenuStateStore>().get().song_open);
}

#[test]
fn editing_and_practice_menu_items_reach_the_webview() {
    let app = app();
    let _window = main_window(&app);
    let (tx, rx) = mpsc::channel();
    app.listen_any(MENU_EVENT, move |event| {
        tx.send(event.payload().to_string()).unwrap();
    });
    let click = |id: &str| {
        menu::handle_event(
            app.handle(),
            MenuEvent {
                id: MenuId::new(id),
            },
        )
    };

    for (id, payload) in [
        ("file.new", "\"new-song\""),
        ("edit.undo", "\"undo\""),
        ("edit.redo", "\"redo\""),
        ("edit.toggle-edit-mode", "\"toggle-edit-mode\""),
        ("view.toggle-fretboard", "\"toggle-fretboard\""),
        ("track.add", "\"add-track\""),
        ("track.remove", "\"remove-track\""),
        ("playback.toggle-loop", "\"toggle-loop\""),
        ("playback.speed-trainer", "\"speed-trainer\""),
        ("playback.toggle-count-in", "\"toggle-count-in\""),
    ] {
        click(id);
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), payload);
    }
}

#[test]
fn menu_shortcuts_include_editing_and_practice() {
    let app = app();
    let window = main_window(&app);

    let shortcuts = invoke(&window, "menu_shortcuts").expect("menu_shortcuts failed");
    let actions: Vec<_> = shortcuts
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["action"].as_str().unwrap().to_string())
        .collect();

    for action in [
        "new-song",
        "undo",
        "redo",
        "toggle-edit-mode",
        "toggle-loop",
        "add-track",
    ] {
        assert!(actions.iter().any(|a| a == action), "{action} missing");
    }
}

/// Delivers the Ready event (which runs the setup hook) and returns where the
/// app stores mixer settings. The mock runtime cannot exit, so `run_return` is
/// not an option; `run_iteration` is deprecated only because calling it in a
/// loop busy-waits, and a single call does not.
#[allow(deprecated)]
fn mixer_dir_after_setup(mut app: App<MockRuntime>) -> std::path::PathBuf {
    app.run_iteration(|_, _| {});
    app.state::<MixerStore>().dir().to_path_buf()
}

#[test]
fn mixer_settings_are_stored_in_the_app_data_folder_by_default() {
    let app = app();
    let expected = app.path().app_data_dir().unwrap().join("mixer");

    assert_eq!(mixer_dir_after_setup(app), expected);
}

#[test]
fn a_mixer_store_managed_by_the_caller_is_kept() {
    let dir = tempfile::tempdir().unwrap();

    assert_eq!(
        mixer_dir_after_setup(app_with_mixer_dir(dir.path())),
        dir.path()
    );
}
