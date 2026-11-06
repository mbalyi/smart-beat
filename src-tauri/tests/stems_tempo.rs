//! `stems_detect_tempo` over Tauri's mock IPC, with the real `setup()` wiring and a store in a
//! temp folder. The song is a mono click track written as a WAV file and separated with the
//! built-in engine, so the command reads real stem files.

use std::path::Path;

use serde_json::{Value, json};
use smart_beat_lib::menu::MAIN_WINDOW;
use smart_beat_lib::stems::StemStore;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};

const RATE: u32 = 44_100;

fn app_with(store: StemStore) -> App<MockRuntime> {
    smart_beat_lib::setup(mock_builder().manage(store))
        .build(mock_context(noop_assets()))
        .expect("failed to build app")
}

fn main_window(app: &App<MockRuntime>) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, MAIN_WINDOW, Default::default())
        .build()
        .expect("failed to create window")
}

fn call(window: &WebviewWindow<MockRuntime>, cmd: &str, args: Value) -> Result<Value, Value> {
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
    .map(|body| match body {
        InvokeResponseBody::Json(json) => serde_json::from_str(&json).unwrap(),
        other => panic!("expected JSON, got {other:?}"),
    })
}

/// A mono 16-bit click track: a short 1.5 kHz burst on every beat.
fn write_clicks(path: &Path, bpm: f64, first: f64, seconds: f64) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut x = vec![0.0f32; (seconds * f64::from(RATE)) as usize];
    let mut t = first;
    while t < seconds - 0.1 {
        let start = (t * f64::from(RATE)) as usize;
        for i in 0..(0.02 * f64::from(RATE)) as usize {
            let s = i as f32 / RATE as f32;
            x[start + i] += (std::f32::consts::TAU * 1500.0 * s).sin() * (-s * 250.0).exp() * 0.8;
        }
        t += 60.0 / bpm;
    }
    let mut writer = hound::WavWriter::create(path, spec).unwrap();
    for v in x {
        writer.write_sample((v * 32_767.0) as i16).unwrap();
    }
    writer.finalize().unwrap();
}

#[test]
fn detects_the_tempo_of_a_separated_song_and_keeps_it_with_the_song() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with(StemStore::new(dir.path().join("stems")));
    let window = main_window(&app);
    let file = dir.path().join("Clicks.wav");
    write_clicks(&file, 126.0, 0.35, 20.0);

    let song = call(
        &window,
        "stems_separate",
        json!({ "request": {
            "path": file.to_string_lossy(),
            "kinds": ["drums"],
            "engine": "fast",
            "strongDrums": false,
        }}),
    )
    .unwrap();
    let id = song["id"].as_str().unwrap().to_owned();
    assert!(song["mono"].as_bool().unwrap());

    let tempo = call(&window, "stems_detect_tempo", json!({ "id": id })).unwrap();
    // Exactly the fields the page codes against.
    let mut keys: Vec<&str> = tempo
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "alternatives",
            "bpm",
            "confidence",
            "firstBeatSec",
            "sections",
            "steady"
        ]
    );
    let bpm = tempo["bpm"].as_f64().unwrap();
    assert!((bpm - 126.0).abs() < 0.6, "bpm {bpm}");
    let first = tempo["firstBeatSec"].as_f64().unwrap();
    assert!((first - 0.35).abs() < 0.04, "first beat {first}");
    assert!(tempo["confidence"].as_f64().unwrap() > 0.7);
    assert_eq!(tempo["steady"], json!(true));
    assert_eq!(tempo["sections"], json!([]));
    let alternatives: Vec<f64> = tempo["alternatives"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    assert!(
        alternatives.iter().any(|a| (a - 63.0).abs() < 1.0),
        "{alternatives:?}"
    );

    // The result is in the song's meta.json, with the algorithm version.
    let meta: Value = serde_json::from_slice(
        &std::fs::read(dir.path().join("stems").join(&id).join("meta.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(meta["tempo"]["tempo"], tempo);
    assert!(meta["tempo"]["version"].as_u64().unwrap() >= 1);

    // And is returned from there: a doctored value comes back unchanged.
    let mut doctored = meta.clone();
    doctored["tempo"]["tempo"]["bpm"] = json!(77.0);
    std::fs::write(
        dir.path().join("stems").join(&id).join("meta.json"),
        serde_json::to_vec(&doctored).unwrap(),
    )
    .unwrap();
    let again = call(&window, "stems_detect_tempo", json!({ "id": id })).unwrap();
    assert_eq!(again["bpm"], json!(77.0));
}

#[test]
fn a_song_that_is_not_there_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with(StemStore::new(dir.path().join("stems")));
    let window = main_window(&app);
    for id in ["0123456789abcdef", "../escape", ""] {
        let err = call(&window, "stems_detect_tempo", json!({ "id": id })).unwrap_err();
        assert!(err["message"].is_string(), "{err}");
    }
}
