//! The stem separation commands over Tauri's mock IPC, with the real `setup()` wiring and a
//! store in a temp folder. The song is the synthetic band from `separation::synth`, written
//! as a WAV file.

use std::io::Cursor;
use std::path::Path;
use std::sync::mpsc;

use serde_json::{Value, json};
use smart_beat_lib::menu::MAIN_WINDOW;
use smart_beat_lib::separation::synth;
use smart_beat_lib::stems::{StemStore, StemsRun};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{App, Listener, Manager, WebviewWindow, WebviewWindowBuilder};

const STOPPED: &str = "Stem separation stopped.";

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

fn invoke(
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

fn json_of(window: &WebviewWindow<MockRuntime>, cmd: &str, args: Value) -> Result<Value, Value> {
    invoke(window, cmd, args).map(|b| b.deserialize::<Value>().unwrap())
}

fn raw_of(window: &WebviewWindow<MockRuntime>, cmd: &str, args: Value) -> Result<Vec<u8>, Value> {
    invoke(window, cmd, args).map(|body| match body {
        InvokeResponseBody::Raw(bytes) => bytes,
        other => panic!("expected raw bytes, got {other:?}"),
    })
}

/// The synthetic band as a 16-bit stereo WAV file.
fn write_band(path: &Path, seconds: f32) -> usize {
    let band = synth::band(seconds);
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: synth::RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).unwrap();
    for (l, r) in band.mix.left.iter().zip(&band.mix.right) {
        for s in [l, r] {
            writer.write_sample((s * 0.8 * 32_767.0) as i16).unwrap();
        }
    }
    writer.finalize().unwrap();
    band.mix.left.len()
}

/// (rate, frames, interleaved samples) of a WAV file in memory.
fn read_wav(bytes: &[u8]) -> (u32, usize, Vec<i16>) {
    let mut reader = hound::WavReader::new(Cursor::new(bytes)).expect("a valid WAV file");
    let spec = reader.spec();
    assert_eq!((spec.channels, spec.bits_per_sample), (2, 16));
    let samples: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
    (spec.sample_rate, samples.len() / 2, samples)
}

fn separate_args(path: &Path, kinds: &[&str]) -> Value {
    json!({ "request": {
        "path": path.to_string_lossy(),
        "kinds": kinds,
        "engine": "fast",
        "strongDrums": false,
    }})
}

fn all_gains(value: f64) -> Value {
    json!({ "drums": value, "bass": value, "vocals": value, "panned": value, "other": value })
}

fn progress_listener(window: &WebviewWindow<MockRuntime>) -> mpsc::Receiver<Value> {
    let (sender, receiver) = mpsc::channel();
    window.listen("stems-progress", move |event| {
        let _ = sender.send(serde_json::from_str(event.payload()).unwrap());
    });
    receiver
}

#[test]
fn separates_lists_caches_reads_renders_and_deletes() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with(StemStore::new(dir.path().join("stems")));
    let window = main_window(&app);
    let file = dir.path().join("Band Song.wav");
    let frames = write_band(&file, 6.0);
    let progress = progress_listener(&window);

    assert_eq!(
        json_of(&window, "stems_list", json!({})).unwrap(),
        json!([])
    );

    // The first call separates and reports progress.
    let args = separate_args(&file, &["drums", "bass", "vocals"]);
    let song = json_of(&window, "stems_separate", args.clone()).expect("separation failed");
    let events: Vec<Value> = progress.try_iter().collect();
    let stages: Vec<&str> = events
        .iter()
        .map(|e| e["stage"].as_str().unwrap())
        .collect();
    for stage in ["reading", "separating", "saving", "done"] {
        assert!(stages.contains(&stage), "no {stage} event in {stages:?}");
    }
    assert_eq!(events.last().unwrap()["stage"], "done");
    assert!(
        events
            .iter()
            .all(|e| (0.0..=1.0).contains(&e["fraction"].as_f64().unwrap()))
    );

    let id = song["id"].as_str().unwrap().to_owned();
    assert_eq!(id.len(), 16);
    assert!(id.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(song["name"], "Band Song");
    assert_eq!(song["sampleRate"], 44_100);
    assert_eq!(song["engine"], "fast");
    assert_eq!(song["strongDrums"], false);
    assert_eq!(song["mono"], false);
    assert_eq!(song["skipped"], json!([]));
    assert!((song["durationSeconds"].as_f64().unwrap() - 6.0).abs() < 0.01);
    let kinds: Vec<&str> = song["stems"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["drums", "bass", "vocals", "other"]);
    let wav_bytes = 44 + frames as u64 * 4;
    assert!(
        song["stems"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["bytes"] == wav_bytes)
    );
    assert_eq!(song["bytes"], 4 * wav_bytes);
    assert!(song["createdAtMs"].as_u64().unwrap() > 0);

    // It is in the list and the cache numbers.
    let list = json_of(&window, "stems_list", json!({})).unwrap();
    assert_eq!(list, json!([song.clone()]));
    let info = json_of(&window, "stems_cache_info", json!({})).unwrap();
    assert_eq!(info["count"], 1);
    assert_eq!(info["bytes"], song["bytes"]);
    assert_eq!(info["limitBytes"], 2u64 * 1024 * 1024 * 1024);

    // The second call is a cache hit: the same song, no separating.
    let _ = progress.try_iter().count();
    let again = json_of(&window, "stems_separate", args).unwrap();
    assert_eq!(again, song);
    let stages: Vec<String> = progress
        .try_iter()
        .map(|e| e["stage"].as_str().unwrap().to_owned())
        .collect();
    assert!(!stages.contains(&"separating".to_owned()), "{stages:?}");
    assert_eq!(stages.last().map(String::as_str), Some("done"));

    // A stem is the raw WAV file.
    let bass = raw_of(&window, "stems_read", json!({ "id": id, "kind": "bass" })).unwrap();
    assert_eq!(bass.len() as u64, wav_bytes);
    let (rate, bass_frames, bass_samples) = read_wav(&bass);
    assert_eq!((rate, bass_frames), (44_100, frames));
    assert!(
        bass_samples.iter().any(|s| s.abs() > 100),
        "the bass stem is silent"
    );
    // A stem that was not made is an error, and so is an unknown one.
    assert!(raw_of(&window, "stems_read", json!({ "id": id, "kind": "panned" })).is_err());
    assert!(raw_of(&window, "stems_read", json!({ "id": id, "kind": "guitar" })).is_err());
    assert!(
        raw_of(
            &window,
            "stems_read",
            json!({ "id": "../../etc", "kind": "bass" })
        )
        .is_err()
    );

    // The mix at full speed with only the bass on is the bass stem: a zero gain is silent.
    let mix = |gains: Value, speed: f64| {
        raw_of(
            &window,
            "stems_render_mix",
            json!({ "id": id, "request": { "gains": gains, "speed": speed } }),
        )
    };
    let only_bass = mix(
        json!({ "bass": 1.0, "drums": 0.0, "vocals": 0.0, "other": 0.0 }),
        1.0,
    )
    .expect("render failed");
    let (rate, n, samples) = read_wav(&only_bass);
    assert_eq!((rate, n), (44_100, frames));
    let worst = samples
        .iter()
        .zip(&bass_samples)
        .map(|(a, b)| (i32::from(*a) - i32::from(*b)).abs())
        .max()
        .unwrap();
    assert!(worst <= 1, "the mix differs from the bass stem by {worst}");
    // Half the gain is half the level.
    let half = mix(json!({ "bass": 0.5 }), 1.0).unwrap();
    let (_, _, half_samples) = read_wav(&half);
    for (h, b) in half_samples.iter().zip(&bass_samples) {
        assert!((i32::from(*h) - i32::from(*b) / 2).abs() <= 1);
    }
    // Everything on is the song.
    let full = mix(all_gains(1.0), 1.0).unwrap();
    let (_, _, full_samples) = read_wav(&full);
    let source = hound::WavReader::open(&file)
        .unwrap()
        .samples::<i16>()
        .map(|s| s.unwrap())
        .collect::<Vec<_>>();
    let worst = full_samples
        .iter()
        .zip(&source)
        .map(|(a, b)| (i32::from(*a) - i32::from(*b)).abs())
        .max()
        .unwrap();
    assert!(worst < 400, "the stems do not add up to the song ({worst})");
    // Nothing on is silence, at both speeds.
    for speed in [1.0, 0.5] {
        let silent = mix(all_gains(0.0), speed).unwrap();
        assert!(read_wav(&silent).2.iter().all(|s| *s == 0), "speed {speed}");
    }
    // Half speed is twice as long (pitch is covered by the unit test).
    let slow = mix(json!({ "bass": 1.0, "drums": 1.0 }), 0.5).unwrap();
    let (rate, slow_frames, slow_samples) = read_wav(&slow);
    assert_eq!(rate, 44_100);
    let ratio = slow_frames as f64 / frames as f64;
    assert!((ratio - 2.0).abs() < 0.01, "length ratio {ratio}");
    assert!(slow_samples.iter().any(|s| s.abs() > 100));
    // A speed or gain out of range, an unknown song or stem name are refused.
    for (gains, speed) in [
        (all_gains(1.0), 0.4),
        (all_gains(1.0), 1.5),
        (all_gains(1.5), 1.0),
        (all_gains(-0.5), 1.0),
        (json!({ "guitar": 1.0 }), 1.0),
    ] {
        assert!(mix(gains.clone(), speed).is_err(), "{gains} at {speed}");
    }
    assert!(
        raw_of(
            &window,
            "stems_render_mix",
            json!({ "id": "0123456789abcdef", "request": { "gains": {}, "speed": 1.0 } })
        )
        .is_err()
    );

    // Delete removes the song; deleting it again, or a bad id, is handled.
    json_of(&window, "stems_delete", json!({ "id": id })).unwrap();
    assert_eq!(
        json_of(&window, "stems_list", json!({})).unwrap(),
        json!([])
    );
    assert!(!dir.path().join("stems").join(&id).exists());
    json_of(&window, "stems_delete", json!({ "id": id })).unwrap();
    assert!(json_of(&window, "stems_delete", json!({ "id": "../stems" })).is_err());
    assert!(dir.path().join("stems").exists());
}

#[test]
fn clear_removes_every_song_and_reports_the_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with(StemStore::new(dir.path().join("stems")));
    let window = main_window(&app);
    let file = dir.path().join("a.wav");
    write_band(&file, 3.0);
    let a = json_of(&window, "stems_separate", separate_args(&file, &["drums"])).unwrap();
    let b = json_of(&window, "stems_separate", separate_args(&file, &["bass"])).unwrap();
    assert_ne!(a["id"], b["id"]);
    assert_eq!(
        json_of(&window, "stems_cache_info", json!({})).unwrap()["count"],
        2
    );
    let freed = json_of(&window, "stems_clear", json!({}))
        .unwrap()
        .as_u64()
        .unwrap();
    assert!(freed >= a["bytes"].as_u64().unwrap() + b["bytes"].as_u64().unwrap());
    assert_eq!(
        json_of(&window, "stems_list", json!({})).unwrap(),
        json!([])
    );
    assert_eq!(
        json_of(&window, "stems_cache_info", json!({})).unwrap()["bytes"],
        0
    );
    assert_eq!(json_of(&window, "stems_clear", json!({})).unwrap(), 0);
}

#[test]
fn a_song_over_the_limit_makes_the_oldest_one_go() {
    let dir = tempfile::tempdir().unwrap();
    // One 3 s song is about 3 x 0.53 MB for drums + other; room for one and a half.
    let app = app_with(StemStore::new(dir.path().join("stems")).with_limit(1_800_000));
    let window = main_window(&app);
    let file = dir.path().join("a.wav");
    write_band(&file, 3.0);
    let first = json_of(&window, "stems_separate", separate_args(&file, &["drums"])).unwrap();
    assert!(first["bytes"].as_u64().unwrap() < 1_800_000);
    let second = json_of(&window, "stems_separate", separate_args(&file, &["bass"])).unwrap();
    let list = json_of(&window, "stems_list", json!({})).unwrap();
    let ids: Vec<&Value> = list.as_array().unwrap().iter().map(|s| &s["id"]).collect();
    assert_eq!(
        ids,
        [&second["id"]],
        "the first song should have been evicted"
    );
    let info = json_of(&window, "stems_cache_info", json!({})).unwrap();
    assert_eq!(
        (&info["count"], &info["limitBytes"]),
        (&json!(1), &json!(1_800_000))
    );
    assert!(
        !dir.path()
            .join("stems")
            .join(first["id"].as_str().unwrap())
            .exists()
    );
}

#[test]
fn cancelling_stops_the_job_and_leaves_no_stems() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with(StemStore::new(dir.path().join("stems")));
    let window = main_window(&app);
    let file = dir.path().join("a.wav");
    write_band(&file, 12.0);
    // Cancel as soon as the file is decoded, before the first segment.
    let handle = app.handle().clone();
    window.listen("stems-progress", move |event| {
        let payload: Value = serde_json::from_str(event.payload()).unwrap();
        if payload["stage"] == "reading" && payload["fraction"] == 1.0 {
            handle.state::<StemsRun>().cancel();
        }
    });
    let err = json_of(
        &window,
        "stems_separate",
        separate_args(&file, &["drums", "bass"]),
    )
    .expect_err("the job should have been stopped");
    assert_eq!(err["message"], STOPPED);
    assert_eq!(
        json_of(&window, "stems_list", json!({})).unwrap(),
        json!([])
    );
    let leftovers = std::fs::read_dir(dir.path().join("stems")).map_or(0, |d| d.count());
    assert_eq!(leftovers, 0, "the half-written song must be removed");
    // The command exists and is harmless with nothing running.
    json_of(&window, "stems_cancel", json!({})).unwrap();
}

#[test]
fn the_neural_engine_is_refused_while_the_model_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with(StemStore::new(dir.path().join("stems")));
    let window = main_window(&app);
    let file = dir.path().join("a.wav");
    write_band(&file, 2.0);
    let args = json!({ "request": {
        "path": file.to_string_lossy(),
        "kinds": ["drums", "bass", "vocals"],
        "engine": "neural",
        "strongDrums": false,
    }});
    let err = json_of(&window, "stems_separate", args).expect_err("must be refused");
    assert_eq!(err["message"], "The neural model is not downloaded.");
    assert_eq!(
        json_of(&window, "stems_list", json!({})).unwrap(),
        json!([])
    );
}

#[test]
fn bad_requests_are_refused_without_touching_the_cache() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with(StemStore::new(dir.path().join("stems")));
    let window = main_window(&app);
    let notes = dir.path().join("notes.txt");
    std::fs::write(&notes, "not audio").unwrap();
    let fake = dir.path().join("fake.mp3");
    std::fs::write(&fake, "not audio either").unwrap();
    let wav = dir.path().join("a.wav");
    write_band(&wav, 1.0);
    for args in [
        separate_args(&notes, &["drums"]),
        separate_args(&fake, &["drums"]),
        separate_args(&dir.path().join("missing.wav"), &["drums"]),
        // Nothing to separate.
        separate_args(&wav, &[]),
        separate_args(&wav, &["other"]),
        // An unknown stem name never reaches the file system.
        separate_args(&wav, &["../../x"]),
    ] {
        assert!(
            json_of(&window, "stems_separate", args.clone()).is_err(),
            "{args}"
        );
    }
    assert_eq!(
        json_of(&window, "stems_list", json!({})).unwrap(),
        json!([])
    );
}
