//! Integration tests: the real `setup()` wiring on Tauri's mock runtime.

use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{Value, json};
use smart_beat_lib::menu::{self, MAIN_WINDOW, MENU_EVENT, MenuAction};
use smart_beat_lib::menu_state::MenuStateStore;
use smart_beat_lib::mixer::MixerStore;
use smart_beat_lib::recent::RecentStore;
use smart_beat_lib::zoom::ZoomState;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::menu::{MenuEvent, MenuId};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{App, Listener, Manager, WebviewWindow, WebviewWindowBuilder};

mod common;

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

    click(MenuAction::Settings.id());
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        "\"settings\""
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
    let text = dir.path().join("notes.pdf");
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

    // Text tab (.txt) is a song file now, but a binary file named like it is not.
    let binary = dir.path().join("tab.txt");
    std::fs::write(&binary, b"abc\x00\x01").unwrap();
    assert_eq!(error_kind(&binary), "not-a-score");
}

#[test]
fn read_score_file_opens_text_tab_and_alphatex_over_ipc() {
    let app = app();
    let window = main_window(&app);
    let dir = tempfile::tempdir().unwrap();
    for (name, content) in [
        ("tab.txt", "e|--0--|\nB|--1--|"),
        ("song.atex", "\\track \"g\" :4 0.6"),
    ] {
        let path = dir.path().join(name);
        std::fs::write(&path, content).unwrap();
        let body = invoke_with(&window, "read_score_file", json!({ "path": path }))
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let InvokeResponseBody::Raw(bytes) = body else {
            panic!("expected a raw response for {name}");
        };
        assert_eq!(bytes, content.as_bytes());
    }
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
        ("view.toggle-mixer", "\"toggle-mixer\""),
        ("view.toggle-practice-view", "\"toggle-practice-view\""),
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

/// A menu state with a song open in edit mode, and `extra` fields on top.
fn edit_state(extra: Value) -> Value {
    let mut state = json!({
        "songOpen": true, "undo": null, "redo": null, "canRemoveTrack": false,
        "editMode": true, "fretboard": false, "loop": false, "metronome": false,
        "countIn": false,
    });
    state
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    json!({ "state": state })
}

#[test]
fn bar_note_and_tool_menu_items_reach_the_webview() {
    let app = app();
    let _window = main_window(&app);
    let (tx, rx) = mpsc::channel();
    app.listen_any(MENU_EVENT, move |event| {
        tx.send(event.payload().to_string()).unwrap();
    });

    for (id, payload) in [
        ("bar.settings", "\"bar-settings\""),
        ("bar.toggle-repeat-start", "\"toggle-repeat-start\""),
        ("bar.toggle-repeat-end", "\"toggle-repeat-end\""),
        ("note.bend", "\"bend\""),
        ("note.toggle-palm-mute", "\"toggle-palm-mute\""),
        ("note.toggle-hammer-pull", "\"toggle-hammer-pull\""),
        ("note.text", "\"text\""),
        ("note.chord", "\"chord\""),
        ("track.lyrics", "\"lyrics\""),
        ("view.scale-tool", "\"scale-tool\""),
    ] {
        menu::handle_event(
            app.handle(),
            MenuEvent {
                id: MenuId::new(id),
            },
        );
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), payload);
    }
}

#[test]
fn menu_state_with_the_edit_cursor_details_is_stored() {
    let app = app();
    let window = main_window(&app);

    invoke_with(
        &window,
        "update_menu_state",
        edit_state(json!({
            "repeatStart": true,
            "repeatEnd": false,
            "hasNote": true,
            "noteEffects": { "palmMute": true, "vibrato": true, "staccato": false },
        })),
    )
    .expect("update_menu_state failed");

    let state = app.state::<MenuStateStore>().get();
    assert!(state.repeat_start && !state.repeat_end && state.has_note);
    assert!(state.note_effects.palm_mute && state.note_effects.vibrato);
    assert!(!state.note_effects.staccato);

    // Wrong types are rejected, and the stored state stays as it was.
    let error = invoke_with(
        &window,
        "update_menu_state",
        edit_state(json!({ "noteEffects": { "palmMute": "yes" } })),
    );
    assert!(error.is_err());
    assert!(app.state::<MenuStateStore>().get().note_effects.palm_mute);
}

#[test]
fn menu_shortcuts_include_bar_and_note_items() {
    let app = app();
    let window = main_window(&app);

    let shortcuts = invoke(&window, "menu_shortcuts").expect("menu_shortcuts failed");
    let menus: Vec<_> = shortcuts
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["action"].as_str().unwrap().to_string(),
                s["menu"].as_str().unwrap().to_string(),
            )
        })
        .collect();

    for (action, menu) in [("bar-settings", "Bar"), ("text", "Note"), ("chord", "Note")] {
        assert!(
            menus.iter().any(|(a, m)| a == action && m == menu),
            "{action} missing"
        );
    }
    // Note effects keep their plain keys in the score: no menu shortcut.
    assert!(!menus.iter().any(|(a, _)| a == "toggle-palm-mute"));
}

/// An app whose recent files list lives in `dir`.
fn app_with_recent_dir(dir: &Path) -> App<MockRuntime> {
    smart_beat_lib::setup(mock_builder().manage(RecentStore::new(dir)))
        .build(mock_context(noop_assets()))
        .expect("failed to build app")
}

fn paths(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect()
}

#[test]
fn recent_files_round_trip_over_ipc() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with_recent_dir(dir.path());
    let window = main_window(&app);

    assert_eq!(invoke(&window, "load_recent_files").unwrap(), json!([]));
    invoke_with(&window, "add_recent_file", json!({ "path": "/a.gp5" })).unwrap();
    let list = invoke_with(&window, "add_recent_file", json!({ "path": "/b.gp5" }))
        .unwrap()
        .deserialize::<Value>()
        .unwrap();
    assert_eq!(paths(&list), ["/b.gp5", "/a.gp5"]);
    assert_eq!(
        paths(&invoke(&window, "load_recent_files").unwrap()),
        ["/b.gp5", "/a.gp5"]
    );

    let list = invoke_with(&window, "remove_recent_file", json!({ "path": "/b.gp5" }))
        .unwrap()
        .deserialize::<Value>()
        .unwrap();
    assert_eq!(paths(&list), ["/a.gp5"]);
    assert_eq!(invoke(&window, "clear_recent_files").unwrap(), json!([]));
    assert_eq!(invoke(&window, "load_recent_files").unwrap(), json!([]));
}

#[test]
fn an_empty_recent_path_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with_recent_dir(dir.path());
    let window = main_window(&app);
    let error = invoke_with(&window, "add_recent_file", json!({ "path": "" })).unwrap_err();
    assert_eq!(error["kind"], "not-found");
}

fn write_request(
    window: &WebviewWindow<MockRuntime>,
    path: &str,
    bytes: Vec<u8>,
) -> Result<InvokeResponseBody, Value> {
    raw_request(window, "write_score_file", path, bytes)
}

/// Calls a command that takes a raw body and a URL-encoded `path` header.
fn raw_request(
    window: &WebviewWindow<MockRuntime>,
    cmd: &str,
    path: &str,
    bytes: Vec<u8>,
) -> Result<InvokeResponseBody, Value> {
    let url = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    let mut headers = tauri::http::HeaderMap::new();
    headers.insert("path", path.parse().unwrap());
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: url.parse().unwrap(),
            body: InvokeBody::Raw(bytes),
            headers,
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

fn encode(path: &Path) -> String {
    path.to_string_lossy()
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

#[test]
fn write_score_file_saves_raw_bytes_atomically() {
    let app = app();
    let window = main_window(&app);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("my song é.gp5");

    write_request(&window, &encode(&path), gp5_bytes()).expect("write failed");
    assert_eq!(std::fs::read(&path).unwrap(), gp5_bytes());
    write_request(&window, &encode(&path), b"second".to_vec()).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"second");
}

#[test]
fn write_score_file_reports_structured_errors() {
    let app = app();
    let window = main_window(&app);
    let dir = tempfile::tempdir().unwrap();

    let bad_type = write_request(&window, &encode(&dir.path().join("a.sh")), vec![1]).unwrap_err();
    assert_eq!(bad_type["kind"], "unsupported-type");
    let missing =
        write_request(&window, &encode(&dir.path().join("x/a.gp5")), vec![1]).unwrap_err();
    assert_eq!(missing["kind"], "not-found");
    let json_body = invoke_with(&window, "write_score_file", json!({})).unwrap_err();
    assert_eq!(json_body["kind"], "io");
}

/// A short 16-bit stereo WAV file with some sound in it.
fn wav_bytes() -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 44_100,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::new(std::io::Cursor::new(&mut bytes), spec).unwrap();
        for frame in 0..22_050 {
            let value = (f64::from(frame) * 0.06).sin() * 12_000.0;
            writer.write_sample(value as i16).unwrap();
            writer.write_sample(value as i16).unwrap();
        }
        writer.finalize().unwrap();
    }
    bytes
}

#[test]
fn export_m4a_writes_an_aac_file_where_the_system_has_an_encoder() {
    let app = app();
    let window = main_window(&app);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("my mix é.m4a");

    let result = raw_request(&window, "export_m4a", &encode(&path), wav_bytes());

    if cfg!(target_os = "macos") {
        result.expect("export failed");
        assert_eq!(&std::fs::read(&path).unwrap()[4..8], b"ftyp");
    } else {
        // No system encoder wired in yet: a clear error, and no file.
        assert_eq!(result.unwrap_err()["kind"], "audio");
        assert!(!path.exists());
    }
}

#[test]
fn export_m4a_reports_structured_errors() {
    let app = app();
    let window = main_window(&app);
    let dir = tempfile::tempdir().unwrap();

    let bad_type = raw_request(
        &window,
        "export_m4a",
        &encode(&dir.path().join("mix.wav")),
        wav_bytes(),
    )
    .unwrap_err();
    assert_eq!(bad_type["kind"], "unsupported-type");
    let no_path = invoke_with(&window, "export_m4a", json!({})).unwrap_err();
    assert_eq!(no_path["kind"], "io");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

/// An app whose sound library lives in `dir`.
fn app_with_audio(dir: &Path) -> App<MockRuntime> {
    smart_beat_lib::setup(
        mock_builder().manage(smart_beat_lib::audio::AudioState::new(dir.join("library"))),
    )
    .build(mock_context(noop_assets()))
    .expect("failed to build app")
}

/// A minimal `.gp` (ZIP) file as alphaTab would write it.
fn gp_zip(path: &Path) {
    use std::io::Write;
    let file = std::fs::File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file(
        "Content/score.gpif",
        zip::write::SimpleFileOptions::default(),
    )
    .unwrap();
    zip.write_all(b"<GPIF/>").unwrap();
    zip.finish().unwrap();
}

fn wav_file(path: &Path, seconds: f32) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 22_050,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).unwrap();
    for i in 0..(22_050.0 * seconds) as usize {
        let s = (i as f32 * 0.1).sin() * 12_000.0;
        writer.write_sample(s as i16).unwrap();
    }
    writer.finalize().unwrap();
}

fn project_settings() -> Value {
    json!({
        "version": 2,
        "master": 0.8,
        "masterPan": 0.25,
        "tracks": [{ "volume": 0.5, "pan": 0.0, "mute": false, "solo": false }],
        "eq": [{ "lowDb": 3.0, "midDb": 0.0, "midHz": 800.0, "highDb": -2.0 }],
        "automation": [{ "enabled": true, "volume": [{ "bar": 0.0, "value": 1.0 }], "pan": [], "mute": [] }],
        "focus": 0,
        "drumLines": [{ "track": 0, "bar": 1, "voice": 0, "beat": 0, "note": 2, "line": 5 }],
        "audioTrack": {
            "name": "take.wav", "embedded": true, "enabled": true, "volume": 0.7, "pan": 0.0,
            "mute": false, "solo": false, "semitones": 2, "cents": 0, "filter": "off",
            "sync": [{ "bar": 0, "ms": 250.0 }]
        }
    })
}

#[test]
fn project_settings_and_the_recording_travel_inside_gp_files() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with_audio(dir.path());
    let window = main_window(&app);
    let song = dir.path().join("song.gp");
    gp_zip(&song);
    let wav = dir.path().join("take.wav");
    wav_file(&wav, 1.0);

    let read = |path: &Path| {
        invoke_with(&window, "read_project_settings", json!({ "path": path }))
            .unwrap()
            .deserialize::<Value>()
            .unwrap()
    };
    assert_eq!(read(&song), Value::Null);

    // Embedding needs the recording to be loaded.
    let error = invoke_with(
        &window,
        "write_project_settings",
        json!({ "path": song, "settings": project_settings(), "embedAudio": true }),
    )
    .unwrap_err();
    assert_eq!(error["kind"], "audio");

    let info = invoke_with(
        &window,
        "audio_load_backing",
        json!({ "source": { "type": "file", "path": wav } }),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(info["name"], "take.wav");
    assert!((info["durationMs"].as_f64().unwrap() - 1000.0).abs() < 1.0);
    assert_eq!(info["peaks"].as_array().unwrap().len(), 100);

    invoke_with(
        &window,
        "write_project_settings",
        json!({ "path": song, "settings": project_settings(), "embedAudio": true }),
    )
    .unwrap();
    let back = read(&song);
    assert_eq!(back["masterPan"], 0.25);
    assert_eq!(back["audioTrack"]["semitones"], 2);
    assert_eq!(back["eq"][0]["lowDb"], 3.0);
    // Drum notes placed on a chosen line of the drum tab (#53).
    assert_eq!(back["drumLines"][0]["line"], 5);
    assert_eq!(back["drumLines"][0]["note"], 2);

    // The embedded recording opens from the song file.
    std::fs::remove_file(&wav).unwrap();
    let info = invoke_with(
        &window,
        "audio_load_backing",
        json!({ "source": { "type": "embedded", "scorePath": song, "name": "take.wav" } }),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(info["name"], "take.wav");

    // Out-of-range settings are refused and leave the file alone.
    let mut bad_line = project_settings();
    bad_line["drumLines"][0]["line"] = json!(9);
    let error = invoke_with(
        &window,
        "write_project_settings",
        json!({ "path": song, "settings": bad_line, "embedAudio": false }),
    )
    .unwrap_err();
    assert_eq!(error["kind"], "invalid-settings");

    let mut bad = project_settings();
    bad["masterPan"] = json!(5.0);
    let error = invoke_with(
        &window,
        "write_project_settings",
        json!({ "path": song, "settings": bad, "embedAudio": false }),
    )
    .unwrap_err();
    assert_eq!(error["kind"], "invalid-settings");
    assert_eq!(read(&song)["masterPan"], 0.25);
}

#[test]
fn audio_track_commands_check_their_input() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with_audio(dir.path());
    let window = main_window(&app);
    let backing = json!({ "params": { "volume": 0.5 }, "sync": [] });
    assert_eq!(
        invoke_with(&window, "audio_set_backing", backing.clone()).unwrap_err()["kind"],
        "audio",
        "nothing is loaded yet"
    );
    let text = dir.path().join("notes.txt");
    std::fs::write(&text, "x").unwrap();
    let error = invoke_with(
        &window,
        "audio_load_backing",
        json!({ "source": { "type": "file", "path": text } }),
    )
    .unwrap_err();
    assert_eq!(error["kind"], "unsupported-type");
    let fake = dir.path().join("fake.mp3");
    std::fs::write(&fake, "not audio").unwrap();
    let error = invoke_with(
        &window,
        "audio_load_backing",
        json!({ "source": { "type": "file", "path": fake } }),
    )
    .unwrap_err();
    assert_eq!(error["kind"], "audio");

    let wav = dir.path().join("a.wav");
    wav_file(&wav, 0.5);
    invoke_with(
        &window,
        "audio_load_backing",
        json!({ "source": { "type": "file", "path": wav } }),
    )
    .unwrap();
    invoke_with(
        &window,
        "audio_set_backing",
        json!({ "params": { "volume": 0.5, "semitones": -3, "filter": "centreCut" },
                "sync": [{ "tick": 0, "ms": 100.0 }, { "tick": 3840, "ms": 2100.0 }] }),
    )
    .unwrap();
    let error = invoke_with(
        &window,
        "audio_set_backing",
        json!({ "params": { "cents": 900 }, "sync": [] }),
    )
    .unwrap_err();
    assert_eq!(error["kind"], "audio");
    invoke(&window, "audio_clear_backing").unwrap();
    assert!(invoke_with(&window, "audio_set_backing", backing).is_err());
}

#[test]
fn sounds_automation_eq_and_drum_mixes_are_validated() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with_audio(dir.path());
    let window = main_window(&app);
    let delay = json!({ "enabled": true, "type": "delay", "timeMs": 200.0 });
    let problems = invoke_with(
        &window,
        "audio_set_sounds",
        json!({ "track": 0, "sounds": [[], [delay]], "switches": [[1920, 1]] }),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(problems, json!([[], []]));
    assert!(
        invoke_with(
            &window,
            "audio_set_sounds",
            json!({ "track": 0, "sounds": [[]], "switches": [[0, 3]] }),
        )
        .is_err(),
        "switch to a missing sound"
    );
    invoke_with(
        &window,
        "audio_set_chain",
        json!({ "track": 0, "slots": [delay], "sound": 1 }),
    )
    .unwrap();
    assert!(
        invoke_with(
            &window,
            "audio_set_chain",
            json!({ "track": 0, "slots": [], "sound": 99 })
        )
        .is_err()
    );

    invoke_with(
        &window,
        "audio_set_automation",
        json!({ "track": 1, "automation": { "enabled": true, "volume": [[0, 0.5]], "pan": [[0, -1.0]], "mute": [] } }),
    )
    .unwrap();
    assert!(
        invoke_with(
            &window,
            "audio_set_automation",
            json!({ "track": 1, "automation": { "enabled": true, "volume": [[0, 3.0]] } }),
        )
        .is_err()
    );
    invoke_with(
        &window,
        "audio_set_track_eq",
        json!({ "track": 0, "eq": { "lowDb": -6.0 } }),
    )
    .unwrap();
    assert!(
        invoke_with(
            &window,
            "audio_set_track_eq",
            json!({ "track": 0, "eq": { "highDb": 99.0 } })
        )
        .is_err()
    );
    let element =
        json!({ "keys": [38], "mix": { "volume": 0.5, "pan": 0.2, "mute": false, "solo": false } });
    invoke_with(
        &window,
        "audio_set_drum_mix",
        json!({ "track": 1, "drums": { "stereo": true, "elements": [element] } }),
    )
    .unwrap();
    invoke_with(
        &window,
        "audio_set_drum_mix",
        json!({ "track": 1, "drums": null }),
    )
    .unwrap();
    let too_many: Vec<Value> = (0..30).map(|_| element.clone()).collect();
    assert!(
        invoke_with(
            &window,
            "audio_set_drum_mix",
            json!({ "track": 1, "drums": { "stereo": true, "elements": too_many } }),
        )
        .is_err()
    );
    assert!(
        invoke_with(
            &window,
            "audio_set_track_eq",
            json!({ "track": 9999, "eq": {} })
        )
        .is_err()
    );
}

/// Drum kit commands (#40): import a tiny synthetic SFZ kit, list it, pick it
/// for a track (before the engine runs it is remembered), remove it.
#[test]
fn drum_kit_commands_import_list_assign_and_remove() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with_audio(dir.path());
    let window = main_window(&app);
    let list = || {
        invoke_with(&window, "kits_list", json!({}))
            .unwrap()
            .deserialize::<Value>()
            .unwrap()
    };
    assert_eq!(list(), json!([]));

    let kit_dir = dir.path().join("Free Kit");
    std::fs::create_dir_all(&kit_dir).unwrap();
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 44_100,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut wav = hound::WavWriter::create(kit_dir.join("kick.wav"), spec).unwrap();
    for i in 0..4_410 {
        wav.write_sample(((i as f32 * 0.01).sin() * 20_000.0) as i16)
            .unwrap();
    }
    wav.finalize().unwrap();
    std::fs::write(kit_dir.join("kit.sfz"), "<region> sample=kick.wav key=36").unwrap();

    // No licence file: the user must confirm.
    let error = invoke_with(
        &window,
        "kits_import",
        json!({ "path": kit_dir.join("kit.sfz") }),
    )
    .unwrap_err();
    assert_eq!(error["kind"], "audio");
    assert!(error["message"].as_str().unwrap().contains("confirm"));

    let info = invoke_with(
        &window,
        "kits_import",
        json!({
            "path": kit_dir.join("kit.sfz"),
            "options": { "licence": "cc-by", "attribution": "Test drummer", "name": "Free Kit" }
        }),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(info["name"], "Free Kit");
    assert_eq!(info["licence"]["kind"], "cc-by");
    assert_eq!(info["licence"]["attribution"], "Test drummer");
    assert_eq!(info["pieces"][0]["element"], "kick");
    assert_eq!(list().as_array().unwrap().len(), 1);
    let id = info["id"].as_str().unwrap().to_string();

    invoke_with(
        &window,
        "audio_set_track_kit",
        json!({ "track": 2, "kit": id }),
    )
    .unwrap();
    invoke_with(
        &window,
        "audio_set_track_kit",
        json!({ "track": 2, "kit": null }),
    )
    .unwrap();
    let error = invoke_with(
        &window,
        "audio_set_track_kit",
        json!({ "track": 2, "kit": "nope" }),
    )
    .unwrap_err();
    assert_eq!(error["kind"], "audio");
    let error = invoke_with(
        &window,
        "audio_set_track_kit",
        json!({ "track": 100_000, "kit": null }),
    )
    .unwrap_err();
    assert_eq!(error["kind"], "audio");

    invoke_with(&window, "kits_remove", json!({ "id": id })).unwrap();
    assert_eq!(list(), json!([]));
    assert!(invoke_with(&window, "kits_remove", json!({ "id": "gone" })).is_err());
    // The kits live next to the sound library in the app data folder.
    assert!(dir.path().join("kits/kits.json").exists());
}

/// Sound library commands (#41): import a tiny synthetic amp capture and
/// cabinet, list, tag, rename and remove them, and get a clear error (never
/// a crash) for bad files.
#[test]
fn sound_library_commands_import_tag_rename_and_remove() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with_audio(dir.path());
    let window = main_window(&app);
    let list = || {
        invoke_with(&window, "library_list", json!({}))
            .unwrap()
            .deserialize::<Value>()
            .unwrap()
    };
    let user_items = || -> Vec<Value> {
        list()
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["builtin"] == false)
            .cloned()
            .collect()
    };
    assert!(user_items().is_empty());
    assert!(
        list()
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["builtin"] == true),
        "generated cabinets are always there"
    );

    let amp = dir.path().join("my-amp.nam");
    std::fs::write(
        &amp,
        common::tiny_nam(Some(44_100.0), Some(-22.0), "Test Amp"),
    )
    .unwrap();
    let cab = dir.path().join("my-cab.wav");
    std::fs::write(&cab, common::tiny_ir(48_000, 2_048)).unwrap();

    let amp_item = invoke_with(
        &window,
        "library_import",
        json!({ "path": amp, "kind": "amp" }),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(amp_item["name"], "Test Amp");
    assert_eq!(amp_item["kind"], "amp");
    assert_eq!(amp_item["sampleRate"], 44_100);
    let cab_item = invoke_with(
        &window,
        "library_import",
        json!({ "path": cab, "kind": "cab" }),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(cab_item["name"], "my-cab");
    assert_eq!(cab_item["note"], "");
    assert_eq!(user_items().len(), 2);

    // Tags and rename.
    let id = cab_item["id"].as_str().unwrap();
    let renamed = invoke_with(
        &window,
        "library_update",
        json!({ "id": id, "name": "Mesa 4x12", "tags": ["metal", "djent", " "] }),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(renamed["name"], "Mesa 4x12");
    assert_eq!(renamed["tags"], json!(["metal", "djent"]));
    let error = invoke_with(
        &window,
        "library_update",
        json!({ "id": id, "name": "  ", "tags": [] }),
    )
    .unwrap_err();
    assert_eq!(error["kind"], "audio");

    // Bad files: a clear message, nothing added, the app keeps running.
    let broken = dir.path().join("broken.nam");
    std::fs::write(&broken, b"{ \"architecture\": \"Nope\" ").unwrap();
    let error = invoke_with(
        &window,
        "library_import",
        json!({ "path": broken, "kind": "amp" }),
    )
    .unwrap_err();
    assert_eq!(error["kind"], "audio");
    assert!(
        error["message"]
            .as_str()
            .unwrap()
            .contains("Neural Amp Modeler")
    );
    let wrong = invoke_with(
        &window,
        "library_import",
        json!({ "path": cab, "kind": "amp" }),
    )
    .unwrap_err();
    assert_eq!(wrong["kind"], "audio");
    let missing = invoke_with(
        &window,
        "library_import",
        json!({ "path": dir.path().join("nothing.wav"), "kind": "cab" }),
    )
    .unwrap_err();
    assert!(
        missing["message"]
            .as_str()
            .unwrap()
            .contains("cannot be read")
    );
    assert_eq!(user_items().len(), 2);

    // The library survives a restart (a new app on the same folder).
    drop(window);
    drop(app);
    let app = app_with_audio(dir.path());
    let window = main_window(&app);
    let again = invoke_with(&window, "library_list", json!({}))
        .unwrap()
        .deserialize::<Value>()
        .unwrap();
    assert_eq!(
        again
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["builtin"] == false)
            .count(),
        2
    );

    // Removing deletes the stored copy too.
    let stored = dir
        .path()
        .join("library")
        .join(renamed["file"].as_str().unwrap());
    assert!(stored.is_file());
    invoke_with(&window, "library_remove", json!({ "id": id })).unwrap();
    assert!(!stored.exists());
    assert!(invoke_with(&window, "library_remove", json!({ "id": id })).is_err());
}

/// An app whose usage counters live in `dir` and could send to a (here unreachable) server.
fn app_with_telemetry(dir: &Path, endpoint: Option<&str>) -> App<MockRuntime> {
    use smart_beat_lib::telemetry::Telemetry;
    use std::sync::Arc;
    smart_beat_lib::setup(mock_builder().manage(Arc::new(Telemetry::new(dir, endpoint, "9.9.9"))))
        .build(mock_context(noop_assets()))
        .expect("failed to build app")
}

#[test]
fn usage_counters_are_recorded_and_can_be_switched_off_over_ipc() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with_telemetry(dir.path(), Some("http://127.0.0.1:1/v1/batch"));
    let window = main_window(&app);

    let settings = invoke(&window, "get_usage_settings").unwrap();
    assert_eq!(
        settings,
        json!({ "enabled": true, "available": true, "noticeSeen": false })
    );

    invoke_with(&window, "track_event", json!({ "event": "loop_on" })).unwrap();
    invoke_with(
        &window,
        "track_event",
        json!({ "event": "export", "format": "pdf" }),
    )
    .unwrap();
    invoke_with(
        &window,
        "track_event",
        json!({ "event": "pedal_add", "format": "amp_sim" }),
    )
    .unwrap();
    invoke_with(
        &window,
        "track_event",
        json!({ "event": "plugin_add", "format": "clap" }),
    )
    .unwrap();
    assert!(
        invoke_with(
            &window,
            "track_event",
            json!({ "event": "pedal_add", "format": "clap" })
        )
        .is_err()
    );
    let stored = std::fs::read_to_string(dir.path().join("usage.json")).unwrap();
    assert!(stored.contains("loop_on|"), "{stored}");
    assert!(stored.contains("export|pdf"), "{stored}");
    assert!(stored.contains("pedal_add|amp_sim"), "{stored}");
    assert!(stored.contains("plugin_add|clap"), "{stored}");
    // Nothing identifying is stored: only days and counts.
    let parsed: Value = serde_json::from_str(&stored).unwrap();
    assert_eq!(
        parsed.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["days"]
    );

    let off = invoke_with(
        &window,
        "set_usage_settings",
        json!({ "enabled": false, "noticeSeen": true }),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(
        off,
        json!({ "enabled": false, "available": true, "noticeSeen": true })
    );
    assert!(!dir.path().join("usage.json").exists());
    invoke_with(&window, "track_event", json!({ "event": "play" })).unwrap();
    assert!(!dir.path().join("usage.json").exists());
}

#[test]
fn unknown_usage_events_and_formats_are_refused_over_ipc() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with_telemetry(dir.path(), Some("http://127.0.0.1:1/v1/batch"));
    let window = main_window(&app);

    assert!(invoke_with(&window, "track_event", json!({ "event": "my_song" })).is_err());
    assert!(
        invoke_with(
            &window,
            "track_event",
            json!({ "event": "open_file", "format": "/Users/me/song.gp5" })
        )
        .is_err()
    );
    assert!(!dir.path().join("usage.json").exists());
}

#[test]
fn builds_without_an_endpoint_count_and_send_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with_telemetry(dir.path(), None);
    let window = main_window(&app);

    let settings = invoke(&window, "get_usage_settings").unwrap();
    assert_eq!(settings["available"], false);
    invoke_with(&window, "track_event", json!({ "event": "loop_on" })).unwrap();
    assert!(!dir.path().join("usage.json").exists());
}

#[test]
fn plugin_enable_and_per_block_commands_are_wired_over_ipc() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with_audio(dir.path());
    let window = main_window(&app);
    assert_eq!(invoke(&window, "plugins_enabled").unwrap(), false);
    invoke_with(&window, "plugins_set_enabled", json!({"enabled": true})).unwrap();
    assert_eq!(invoke(&window, "plugins_enabled").unwrap(), true);
    let slot = json!({"type":"plugin","enabled":true,"format":"clap",
        "path":"/nonexistent/synthetic.clap","name":"Synthetic", "state":""});
    let problems = invoke_with(
        &window,
        "audio_set_chain",
        json!({"track": 1, "sound": 2, "slots": [slot]}),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert!(
        problems[0]["message"]
            .as_str()
            .unwrap()
            .contains("not installed")
    );
    let info = invoke_with(&window, "audio_plugin_info", json!({"track":1,"sound":2}))
        .unwrap()
        .deserialize::<Value>()
        .unwrap();
    assert_eq!(info[0]["index"], 0);
    assert_eq!(info[0]["name"], "Synthetic");
    assert_eq!(info[0]["alive"], false);
    let error = invoke_with(
        &window,
        "plugin_save_state",
        json!({"track":1,"sound":2,"index":0}),
    )
    .unwrap_err();
    assert_eq!(error["kind"], "audio");
    invoke_with(&window, "plugins_set_enabled", json!({"enabled": false})).unwrap();
    assert_eq!(invoke(&window, "plugins_enabled").unwrap(), false);
}

#[test]
fn monitor_track_commands_check_their_input() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with_audio(dir.path());
    let window = main_window(&app);
    let params = json!({ "enabled": true, "volume": 0.8, "pan": 0.0, "mute": false,
                         "solo": false, "eq": { "lowDb": 0.0, "midDb": 0.0, "midHz": 1000.0, "highDb": 0.0 } });
    // Without a running engine the settings are kept and nothing opens yet.
    let status = invoke_with(
        &window,
        "audio_set_monitor",
        json!({ "monitor": { "params": params, "device": "Scarlett 2i2 USB", "channel": 0 } }),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(status["open"], false);
    assert_eq!(status["error"], Value::Null);
    let loud =
        json!({ "monitor": { "params": { "volume": 2.0 }, "device": null, "channel": null } });
    assert_eq!(
        invoke_with(&window, "audio_set_monitor", loud).unwrap_err()["kind"],
        "audio"
    );
    let long = "x".repeat(300);
    let named = json!({ "monitor": { "params": params, "device": long, "channel": null } });
    assert!(invoke_with(&window, "audio_set_monitor", named).is_err());
    assert!(
        invoke_with(
            &window,
            "audio_input_channels",
            json!({ "device": "x".repeat(300) })
        )
        .is_err()
    );

    let delay = json!({ "enabled": true, "type": "delay", "timeMs": 200.0 });
    let problems = invoke_with(
        &window,
        "audio_set_monitor_chain",
        json!({ "slots": [delay] }),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(problems, json!([]));
    let too_many = json!({ "slots": vec![delay; 7] });
    assert!(invoke_with(&window, "audio_set_monitor_chain", too_many).is_err());

    let removed = invoke_with(&window, "audio_set_monitor", json!({ "monitor": null }))
        .unwrap()
        .deserialize::<Value>()
        .unwrap();
    assert_eq!(removed, Value::Null);
    // The engine's status has no monitor track then.
    let state = invoke(&window, "audio_state").unwrap();
    assert!(state.get("monitor").is_none_or(Value::is_null));
}

#[test]
fn monitor_plugins_have_their_own_ipc_destination() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with_audio(dir.path());
    let window = main_window(&app);
    let slot = json!({"type":"plugin","enabled":true,"format":"clap",
        "path":"/nonexistent/monitor.clap","name":"Monitor amp", "state":""});
    invoke_with(&window, "audio_set_monitor_chain", json!({"slots": [slot]})).unwrap();
    let info = invoke_with(
        &window,
        "audio_plugin_info",
        json!({"track":"monitor","sound":0}),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(info[0]["name"], "Monitor amp");
    let master = invoke_with(
        &window,
        "audio_plugin_info",
        json!({"track":null,"sound":0}),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(master, json!([]));
    for cmd in ["plugin_open_editor", "plugin_save_state"] {
        let error =
            invoke_with(&window, cmd, json!({"track":"monitor","sound":0,"index":0})).unwrap_err();
        assert!(
            error["message"]
                .as_str()
                .unwrap()
                .contains("enable this plugin block"),
            "{error}"
        );
    }
    invoke_with(
        &window,
        "plugin_close_editor",
        json!({"track":"monitor","sound":0,"index":0}),
    )
    .unwrap();
    assert!(invoke_with(&window, "audio_plugin_info", json!({"track":"unknown"})).is_err());
    invoke_with(&window, "audio_set_monitor", json!({"monitor":null})).unwrap();
    let info = invoke_with(
        &window,
        "audio_plugin_info",
        json!({"track":"monitor","sound":0}),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(info, json!([]));
}
