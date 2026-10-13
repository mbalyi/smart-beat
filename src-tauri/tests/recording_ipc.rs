//! The Record to tab commands over Tauri's mock IPC, with the real `setup()` wiring.

use serde_json::{Value, json};
use smart_beat_lib::menu::MAIN_WINDOW;
use std::sync::mpsc;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{App, Listener, WebviewWindow, WebviewWindowBuilder};

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

fn request(
    window: &WebviewWindow<MockRuntime>,
    cmd: &str,
    body: InvokeBody,
    rate: Option<&str>,
) -> Result<InvokeResponseBody, Value> {
    request_as(window, cmd, body, rate, None)
}

fn request_as(
    window: &WebviewWindow<MockRuntime>,
    cmd: &str,
    body: InvokeBody,
    rate: Option<&str>,
    instrument: Option<&str>,
) -> Result<InvokeResponseBody, Value> {
    let url = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    let mut headers = tauri::http::HeaderMap::new();
    if let Some(rate) = rate {
        headers.insert("x-sample-rate", rate.parse().unwrap());
    }
    if let Some(instrument) = instrument {
        headers.insert("x-instrument", instrument.parse().unwrap());
    }
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: url.parse().unwrap(),
            body,
            headers,
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

/// `transcribe_recording` with little-endian f32 samples and a sample rate header.
fn transcribe(
    window: &WebviewWindow<MockRuntime>,
    rate: Option<&str>,
    samples: &[f32],
) -> Result<InvokeResponseBody, Value> {
    let bytes = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
    request(window, "transcribe_recording", InvokeBody::Raw(bytes), rate)
}

#[test]
fn returns_notes_and_reports_progress() {
    let app = app();
    let window = main_window(&app);
    let (sender, receiver) = mpsc::channel();
    window.listen("recording-transcription-progress", move |event| {
        let _ = sender.send(event.payload().to_owned());
    });
    let body =
        transcribe(&window, Some("22050"), &vec![0.0; 22_050 * 3]).expect("transcription failed");
    assert_eq!(body.deserialize::<Value>().unwrap(), json!({ "notes": [] }));
    let last = receiver.try_iter().last().expect("no progress event");
    let fraction = serde_json::from_str::<Value>(&last).unwrap()["fraction"].clone();
    assert_eq!(fraction, 1.0);
}

#[test]
fn accepts_an_instrument_header() {
    let app = app();
    let window = main_window(&app);
    let bytes: Vec<u8> = vec![0.0f32; 22_050 * 3]
        .iter()
        .flat_map(|s| s.to_le_bytes())
        .collect();
    for instrument in ["piano", "guitar", "something else"] {
        let body = request_as(
            &window,
            "transcribe_recording",
            InvokeBody::Raw(bytes.clone()),
            Some("22050"),
            Some(instrument),
        )
        .expect("transcription failed");
        assert_eq!(body.deserialize::<Value>().unwrap(), json!({ "notes": [] }));
    }
}

#[test]
fn reports_bad_takes_as_audio_errors() {
    let app = app();
    let window = main_window(&app);
    let empty = transcribe(&window, Some("48000"), &[]).unwrap_err();
    assert_eq!(empty["kind"], "audio");
    assert_eq!(empty["message"], "The recording is empty.");
    let nan = transcribe(&window, Some("48000"), &[0.0, f32::NAN]).unwrap_err();
    assert_eq!(nan["kind"], "audio");
    let missing = transcribe(&window, None, &[0.0; 4]).unwrap_err();
    assert_eq!(missing["message"], "Missing x-sample-rate.");
    assert_eq!(
        transcribe(&window, Some("fast"), &[0.0; 4]).unwrap_err()["kind"],
        "audio"
    );
    let long = transcribe(&window, Some("8000"), &vec![0.0; 8_000 * 600 + 1]).unwrap_err();
    assert!(long["message"].as_str().unwrap().contains("10 minutes"));
    let json_body = request(
        &window,
        "transcribe_recording",
        InvokeBody::Json(json!({})),
        Some("22050"),
    )
    .unwrap_err();
    assert_eq!(json_body["kind"], "audio");
}

#[test]
fn cancel_without_a_run_does_nothing() {
    let app = app();
    let window = main_window(&app);
    let body = request(
        &window,
        "cancel_recording_transcription",
        InvokeBody::Json(json!({})),
        None,
    )
    .unwrap();
    assert_eq!(body.deserialize::<Value>().unwrap(), Value::Null);
}
