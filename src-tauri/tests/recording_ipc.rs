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
    request_as(window, cmd, body, rate, &[])
}

fn request_as(
    window: &WebviewWindow<MockRuntime>,
    cmd: &str,
    body: InvokeBody,
    rate: Option<&str>,
    extra: &[(&str, &str)],
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
    for (name, value) in extra {
        headers.insert(
            tauri::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
            value.parse().unwrap(),
        );
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
    for instrument in ["piano", "guitar", "drums", "something else"] {
        let body = request_as(
            &window,
            "transcribe_recording",
            InvokeBody::Raw(bytes.clone()),
            Some("22050"),
            &[("x-instrument", instrument)],
        )
        .expect("transcription failed");
        assert_eq!(body.deserialize::<Value>().unwrap(), json!({ "notes": [] }));
    }
}

#[test]
fn the_piano_model_must_be_downloaded_before_it_is_used() {
    let app = app();
    let window = main_window(&app);
    let bytes: Vec<u8> = vec![0.0f32; 22_050]
        .iter()
        .flat_map(|s| s.to_le_bytes())
        .collect();
    let refused = request_as(
        &window,
        "transcribe_recording",
        InvokeBody::Raw(bytes),
        Some("22050"),
        &[("x-instrument", "piano"), ("x-engine", "transkun")],
    )
    .unwrap_err();
    assert_eq!(refused["kind"], "audio");
    assert_eq!(refused["message"], "Download the piano model first.");
}

#[test]
fn reports_the_piano_model_status() {
    let app = app();
    let window = main_window(&app);
    let status = request(
        &window,
        "piano_model_status",
        InvokeBody::Json(json!({})),
        None,
    )
    .expect("status failed")
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(status["installed"], false);
    assert_eq!(status["bytes"], 56_799_421);
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

/// A kick (a falling 55 Hz thump) every half second, then a snare-like burst of noise between.
fn drum_take(rate: u32) -> Vec<f32> {
    let mut out = vec![0.0f32; rate as usize * 4];
    let mut noise = 5u32;
    for k in 0..6 {
        let at = (0.5 + 0.5 * f64::from(k)) * f64::from(rate);
        for n in 0..(0.4 * f64::from(rate)) as usize {
            let t = n as f32 / rate as f32;
            let pitch = 55.0 * (1.0 + 0.6 * (-t * 60.0).exp());
            if let Some(slot) = out.get_mut(at as usize + n) {
                *slot += (2.0 * std::f32::consts::PI * pitch * t).sin() * (-t * 14.0).exp() * 0.8;
            }
        }
    }
    let (mut a, mut b, mut c) = (0.0f32, 0.0f32, 0.0f32);
    for n in 0..(0.25 * f64::from(rate)) as usize {
        let at = (3.5 * f64::from(rate)) as usize + n;
        let t = n as f32 / rate as f32;
        noise = noise.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        a += 0.35 * ((noise >> 8) as f32 / (1u32 << 24) as f32 - 0.5 - a);
        b += 0.35 * (a - b);
        c += 0.08 * (b - c);
        out[at] += (b - c) * 6.0 * (-t * 22.0).exp();
    }
    out
}

#[test]
fn drums_come_back_as_general_midi_drum_numbers() {
    let app = app();
    let window = main_window(&app);
    let bytes: Vec<u8> = drum_take(22_050)
        .iter()
        .flat_map(|s| s.to_le_bytes())
        .collect();
    let body = request_as(
        &window,
        "transcribe_recording",
        InvokeBody::Raw(bytes),
        Some("22050"),
        &[("x-instrument", "drums")],
    )
    .expect("transcription failed");
    let notes = body.deserialize::<Value>().unwrap()["notes"]
        .as_array()
        .unwrap()
        .clone();
    let of = |pitch: u64| {
        notes
            .iter()
            .filter(|n| n["pitch"] == pitch)
            .map(|n| n["start"].as_f64().unwrap())
            .collect::<Vec<_>>()
    };
    let kicks = of(36);
    assert_eq!(kicks.len(), 6, "{notes:#?}");
    for (k, start) in kicks.iter().enumerate() {
        assert!((start - (0.5 + 0.5 * k as f64)).abs() < 0.03, "{kicks:?}");
    }
    let snares = of(38);
    assert_eq!(snares.len(), 1, "{notes:#?}");
    assert!((snares[0] - 3.5).abs() < 0.03, "{snares:?}");
    // The same shape as every other take: camelCase, with an end and a velocity.
    assert!(
        notes
            .iter()
            .all(|n| n["end"].is_f64() && n["velocity"].is_u64())
    );
}
