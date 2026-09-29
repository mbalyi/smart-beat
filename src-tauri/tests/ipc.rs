//! Integration tests: the real `setup()` wiring on Tauri's mock runtime.

use std::sync::mpsc;
use std::time::Duration;

use serde_json::Value;
use smart_beat_lib::menu::{self, MAIN_WINDOW, MENU_EVENT, MenuAction};
use smart_beat_lib::zoom::ZoomState;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::menu::{MenuEvent, MenuId};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{App, Listener, Manager, WebviewWindow, WebviewWindowBuilder};

fn app() -> App<MockRuntime> {
    smart_beat_lib::setup(mock_builder())
        .build(mock_context(noop_assets()))
        .expect("failed to build app")
}

fn main_window(app: &App<MockRuntime>) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, MAIN_WINDOW, Default::default())
        .build()
        .expect("failed to create window")
}

fn invoke(window: &WebviewWindow<MockRuntime>, cmd: &str) -> Result<Value, Value> {
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
            body: InvokeBody::default(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize::<Value>().unwrap())
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
