//! The stem separation commands over Tauri's mock IPC, with the real `setup()` wiring and a
//! store in a temp folder. The song is the synthetic band from `separation::synth`, written
//! as a WAV file.

use std::io::Cursor;
use std::path::Path;
use std::sync::mpsc;

use serde_json::{Value, json};
use smart_beat_lib::cloud::keychain::MemoryStore;
use smart_beat_lib::cloud_commands::{CloudState, provider_for};
use smart_beat_lib::cloud_folder::CloudFolderStore;
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

/// The app with its own cloud folder setting (the real one lives in the app data folder).
fn app_with_cloud(store: StemStore, cloud: CloudFolderStore) -> App<MockRuntime> {
    smart_beat_lib::setup(mock_builder().manage(store).manage(cloud))
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
    // Guitar and piano are known stem names (the 6-part engine makes them): a song without them
    // just has nothing to play for them.
    let none = mix(json!({ "guitar": 1.0, "piano": 1.0 }), 1.0).unwrap();
    assert!(read_wav(&none).2.iter().all(|s| *s == 0));
    // A speed or gain out of range, an unknown song or stem name are refused.
    for (gains, speed) in [
        (all_gains(1.0), 0.4),
        (all_gains(1.0), 1.5),
        (all_gains(1.5), 1.0),
        (all_gains(-0.5), 1.0),
        (json!({ "synth": 1.0 }), 1.0),
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

fn bundle_listener(window: &WebviewWindow<MockRuntime>) -> mpsc::Receiver<Value> {
    let (sender, receiver) = mpsc::channel();
    window.listen("stems-bundle-progress", move |event| {
        let _ = sender.send(serde_json::from_str(event.payload()).unwrap());
    });
    receiver
}

fn save_args(id: &Value, dest: &Path, original: bool) -> Value {
    json!({ "request": {
        "id": id,
        "dest": dest.to_string_lossy(),
        "includeOriginal": original,
        "state": { "speed": 0.75, "muted": ["drums"], "gains": { "bass": 0.5 } },
    }})
}

#[test]
fn a_separation_is_saved_to_a_file_and_opened_into_another_cache_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with(StemStore::new(dir.path().join("stems")));
    let window = main_window(&app);
    let file = dir.path().join("Band Song.wav");
    write_band(&file, 5.0);
    let song = json_of(
        &window,
        "stems_separate",
        separate_args(&file, &["drums", "bass", "vocals"]),
    )
    .unwrap();
    let id = song["id"].clone();
    // A fresh song is not pinned, was never opened, and can still offer its source file.
    assert_eq!(song["pinned"], false);
    assert_eq!(song["lastOpened"], Value::Null);
    assert_eq!(song["savedPath"], Value::Null);
    assert_eq!(song["hasOriginal"], true);
    // The page never sees where the file came from.
    assert!(!song.to_string().contains("Band Song.wav"));

    let progress = bundle_listener(&window);
    let dest = dir.path().join("saved").join("Band Song.sbstems");
    std::fs::create_dir(dest.parent().unwrap()).unwrap();
    let saved = json_of(&window, "stems_save_bundle", save_args(&id, &dest, true)).expect("save");
    assert_eq!(saved["path"], dest.to_string_lossy().as_ref());
    assert_eq!(saved["originalIncluded"], true);
    assert_eq!(
        saved["bytes"].as_u64().unwrap(),
        std::fs::metadata(&dest).unwrap().len()
    );
    let events: Vec<Value> = progress.try_iter().collect();
    assert!(!events.is_empty());
    assert!(events.iter().all(|e| e["stage"] == "writing"));
    assert_eq!(events.last().unwrap()["fraction"], 1.0);
    assert!(
        events
            .iter()
            .all(|e| (0.0..=1.0).contains(&e["fraction"].as_f64().unwrap()))
    );
    // No temp file stays next to it.
    assert_eq!(
        std::fs::read_dir(dest.parent().unwrap()).unwrap().count(),
        1
    );

    // The cached song is pinned and knows its file.
    let list = json_of(&window, "stems_list", json!({})).unwrap();
    assert_eq!(list[0]["pinned"], true);
    assert_eq!(list[0]["savedPath"], dest.to_string_lossy().as_ref());
    assert_eq!(list[0]["hasOriginal"], true);
    // Touch and pin.
    json_of(&window, "stems_touch", json!({ "id": id })).unwrap();
    let list = json_of(&window, "stems_list", json!({})).unwrap();
    assert!(list[0]["lastOpened"].as_u64().unwrap() > 0);
    json_of(&window, "stems_pin", json!({ "id": id, "pinned": false })).unwrap();
    assert_eq!(
        json_of(&window, "stems_list", json!({})).unwrap()[0]["pinned"],
        false
    );
    json_of(&window, "stems_pin", json!({ "id": id, "pinned": true })).unwrap();
    assert!(json_of(&window, "stems_touch", json!({ "id": "0123456789abcdef" })).is_err());
    assert!(
        json_of(
            &window,
            "stems_pin",
            json!({ "id": "../x", "pinned": true })
        )
        .is_err()
    );

    // Another computer: an empty cache and only the file.
    let other_dir = tempfile::tempdir().unwrap();
    let other = app_with(StemStore::new(other_dir.path().join("stems")));
    let other_window = main_window(&other);
    let progress = bundle_listener(&other_window);
    let opened = json_of(
        &other_window,
        "stems_open_bundle",
        json!({ "path": dest.to_string_lossy() }),
    )
    .expect("open");
    let events: Vec<Value> = progress.try_iter().collect();
    assert!(events.iter().all(|e| e["stage"] == "reading"));
    assert_eq!(events.last().unwrap()["fraction"], 1.0);
    for key in [
        "id",
        "name",
        "durationSeconds",
        "sampleRate",
        "engine",
        "strongDrums",
        "stems",
        "mono",
        "skipped",
        "pannedShare",
        "bytes",
        "createdAtMs",
    ] {
        assert_eq!(opened[key], song[key], "{key}");
    }
    assert_eq!(opened["pinned"], true);
    assert_eq!(opened["savedPath"], dest.to_string_lossy().as_ref());
    assert_eq!(opened["hasOriginal"], true);
    assert!(opened["lastOpened"].as_u64().unwrap() > 0);
    assert_eq!(
        json_of(&other_window, "stems_list", json!({})).unwrap(),
        json!([opened.clone()])
    );
    // Every stem is byte for byte the one that was saved.
    for kind in ["drums", "bass", "vocals", "other"] {
        let args = json!({ "id": id, "kind": kind });
        assert_eq!(
            raw_of(&window, "stems_read", args.clone()).unwrap(),
            raw_of(&other_window, "stems_read", args).unwrap(),
            "{kind}"
        );
    }
    // The mixer state comes back, and opening it again is just a touch.
    let bundle_state = json_of(
        &other_window,
        "stems_bundle_state",
        json!({ "path": dest.to_string_lossy() }),
    )
    .unwrap();
    assert_eq!(
        bundle_state,
        json!({ "speed": 0.75, "muted": ["drums"], "gains": { "bass": 0.5 } })
    );
    let again = json_of(
        &other_window,
        "stems_open_bundle",
        json!({ "path": dest.to_string_lossy() }),
    )
    .unwrap();
    assert_eq!(again["stems"], opened["stems"]);
    assert_eq!(
        json_of(&other_window, "stems_cache_info", json!({})).unwrap()["count"],
        1
    );
    // A cached-away song comes back from its file, and mix rendering works on it.
    json_of(&other_window, "stems_delete", json!({ "id": id })).unwrap();
    json_of(
        &other_window,
        "stems_open_bundle",
        json!({ "path": dest.to_string_lossy() }),
    )
    .unwrap();
    let wav = raw_of(
        &other_window,
        "stems_render_mix",
        json!({ "id": id, "request": { "gains": all_gains(1.0), "speed": 1.0 } }),
    )
    .unwrap();
    assert_eq!(
        read_wav(&wav).1,
        read_wav(&raw_of(&window, "stems_read", json!({ "id": id, "kind": "bass" })).unwrap()).1
    );
}

#[test]
fn a_saved_song_is_not_evicted_but_an_unsaved_one_is() {
    let dir = tempfile::tempdir().unwrap();
    // Room for about one song of two stems.
    let app = app_with(StemStore::new(dir.path().join("stems")).with_limit(1_800_000));
    let window = main_window(&app);
    let file = dir.path().join("a.wav");
    write_band(&file, 3.0);
    let first = json_of(&window, "stems_separate", separate_args(&file, &["drums"])).unwrap();
    let dest = dir.path().join("first.sbstems");
    json_of(
        &window,
        "stems_save_bundle",
        json!({ "request": { "id": first["id"], "dest": dest.to_string_lossy(), "includeOriginal": false } }),
    )
    .unwrap();
    let second = json_of(&window, "stems_separate", separate_args(&file, &["bass"])).unwrap();
    let third = json_of(&window, "stems_separate", separate_args(&file, &["vocals"])).unwrap();
    let list = json_of(&window, "stems_list", json!({})).unwrap();
    let ids: Vec<&Value> = list.as_array().unwrap().iter().map(|s| &s["id"]).collect();
    assert!(ids.contains(&&first["id"]), "the saved song was evicted");
    assert!(ids.contains(&&third["id"]));
    assert!(!ids.contains(&&second["id"]), "the unsaved one should go");
}

#[test]
fn saving_and_opening_report_clear_errors() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with(StemStore::new(dir.path().join("stems")));
    let window = main_window(&app);
    let file = dir.path().join("a.wav");
    write_band(&file, 2.0);
    let song = json_of(&window, "stems_separate", separate_args(&file, &["drums"])).unwrap();
    let dest = dir.path().join("ok");
    // No original asked for: none is included; the extension is added.
    let saved = json_of(
        &window,
        "stems_save_bundle",
        save_args(&song["id"], &dest, false),
    )
    .unwrap();
    assert_eq!(saved["originalIncluded"], false);
    assert!(saved["path"].as_str().unwrap().ends_with("ok.sbstems"));

    // Save: an unknown song, a bad id, a folder that is not there.
    for (args, word) in [
        (
            save_args(&json!("0123456789abcdef"), &dest, false),
            "not saved",
        ),
        (save_args(&json!("../etc"), &dest, false), "not saved"),
        (
            save_args(
                &song["id"],
                &dir.path().join("no/such/dir/a.sbstems"),
                false,
            ),
            "does not exist",
        ),
    ] {
        let err = json_of(&window, "stems_save_bundle", args).expect_err("must fail");
        assert!(err["message"].as_str().unwrap().contains(word), "{err}");
    }

    // Open: a missing file, a file that is not ours, and one that is damaged or too new.
    let missing = dir.path().join("missing.sbstems");
    let err = json_of(
        &window,
        "stems_open_bundle",
        json!({ "path": missing.to_string_lossy() }),
    )
    .expect_err("missing");
    assert_eq!(err["kind"], "not-found");
    let junk = dir.path().join("junk.sbstems");
    std::fs::write(&junk, b"definitely not a zip").unwrap();
    let err = json_of(
        &window,
        "stems_open_bundle",
        json!({ "path": junk.to_string_lossy() }),
    )
    .expect_err("junk");
    assert!(
        err["message"]
            .as_str()
            .unwrap()
            .contains("not a Smart Beat stems file")
    );
    assert!(
        json_of(
            &window,
            "stems_bundle_state",
            json!({ "path": junk.to_string_lossy() })
        )
        .is_err()
    );

    let fresh = app_with(StemStore::new(dir.path().join("fresh")));
    let fresh_window = main_window(&fresh);
    let bytes = std::fs::read(saved["path"].as_str().unwrap()).unwrap();
    // One flipped byte somewhere in the middle of the file.
    let mut damaged = bytes.clone();
    let middle = damaged.len() / 2;
    damaged[middle] ^= 0xff;
    let bad = dir.path().join("bad.sbstems");
    std::fs::write(&bad, damaged).unwrap();
    let err = json_of(
        &fresh_window,
        "stems_open_bundle",
        json!({ "path": bad.to_string_lossy() }),
    )
    .expect_err("damaged");
    assert!(!err["message"].as_str().unwrap().is_empty());
    assert_eq!(
        json_of(&fresh_window, "stems_list", json!({})).unwrap(),
        json!([])
    );
    // The good file still opens in the fresh cache.
    json_of(
        &fresh_window,
        "stems_open_bundle",
        json!({ "path": saved["path"] }),
    )
    .unwrap();
    // Stopping with nothing running is harmless.
    json_of(&fresh_window, "stems_cancel", json!({})).unwrap();
}

#[test]
fn a_stems_file_opened_by_the_system_is_queued_at_launch_and_sent_as_an_event_after() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with(StemStore::new(dir.path().join("stems")));
    let window = main_window(&app);
    let (sender, events) = mpsc::channel();
    window.listen("stems-bundle-opened", move |event| {
        let _ = sender.send(serde_json::from_str::<Value>(event.payload()).unwrap());
    });
    let (score_sender, score_events) = mpsc::channel();
    window.listen("open-external-file", move |_| {
        let _ = score_sender.send(());
    });
    let launch = dir.path().join("Launch.sbstems");
    let score = dir.path().join("Song.gp5");
    let handle = app.handle();
    // At launch the page is not listening: the file waits, no event is sent.
    smart_beat_lib::open_file::queue_at_launch(handle, vec![launch.clone(), score.clone()]);
    assert!(events.try_recv().is_err());
    assert_eq!(
        json_of(&window, "take_pending_open_files", json!({})).unwrap(),
        json!([score.to_string_lossy()])
    );
    assert_eq!(
        json_of(&window, "take_pending_stem_bundles", json!({})).unwrap(),
        json!([launch.to_string_lossy()])
    );
    assert_eq!(
        json_of(&window, "take_pending_stem_bundles", json!({})).unwrap(),
        json!([])
    );
    // Later files arrive as events with the path; scores still use the old event.
    let later = dir.path().join("Later.sbstems");
    smart_beat_lib::open_file::deliver(handle, vec![later.clone()]);
    let event = events
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    assert_eq!(event, json!({ "path": later.to_string_lossy() }));
    assert!(score_events.try_recv().is_err());
    smart_beat_lib::open_file::deliver(handle, vec![score.clone()]);
    score_events
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    assert!(events.try_recv().is_err());
    assert_eq!(
        json_of(&window, "take_pending_stem_bundles", json!({})).unwrap(),
        json!([])
    );
}

#[test]
fn a_separation_saved_into_the_cloud_folder_is_listed_and_opens_from_a_fresh_cache() {
    let dir = tempfile::tempdir().unwrap();
    let drive = dir.path().join("Drive");
    std::fs::create_dir(&drive).unwrap();
    let cloud = CloudFolderStore::new(dir.path().join("data"));
    let app = app_with_cloud(StemStore::new(dir.path().join("stems")), cloud.clone());
    let window = main_window(&app);

    // Nothing linked yet: an empty list, and no place to save.
    assert_eq!(
        json_of(&window, "list_cloud_stems", json!({})).unwrap(),
        json!([])
    );
    let err = json_of(
        &window,
        "stems_cloud_save_path",
        json!({ "name": "Band Song" }),
    )
    .expect_err("no folder");
    assert_eq!(err["kind"], "not-found");
    assert_eq!(err["message"], "Link a cloud folder in Settings first.");

    cloud.set(Some(&drive.to_string_lossy())).unwrap();
    let audio = dir.path().join("Band Song.wav");
    write_band(&audio, 5.0);
    let song = json_of(
        &window,
        "stems_separate",
        separate_args(&audio, &["drums", "bass", "vocals"]),
    )
    .unwrap();
    let id = song["id"].clone();

    // The Save dialog: an estimate, then the path in the folder.
    let estimate = json_of(
        &window,
        "stems_estimate_bundle",
        json!({ "id": id, "includeOriginal": true }),
    )
    .unwrap();
    let without = json_of(
        &window,
        "stems_estimate_bundle",
        json!({ "id": id, "includeOriginal": false }),
    )
    .unwrap();
    assert_eq!(
        without["bytes"].as_u64().unwrap(),
        song["bytes"].as_u64().unwrap() / 2
    );
    assert!(estimate["bytes"].as_u64().unwrap() > without["bytes"].as_u64().unwrap());
    assert!(
        json_of(
            &window,
            "stems_estimate_bundle",
            json!({ "id": "0123456789abcdef", "includeOriginal": false })
        )
        .is_err()
    );
    let path = json_of(
        &window,
        "stems_cloud_save_path",
        json!({ "name": "Band: Song?" }),
    )
    .unwrap();
    assert_eq!(
        path,
        drive.join("Band_ Song_.sbstems").to_string_lossy().as_ref()
    );
    let path = Path::new(path.as_str().unwrap());
    assert!(!path.exists());

    let saved = json_of(&window, "stems_save_bundle", save_args(&id, path, true)).expect("save");
    assert_eq!(saved["path"], path.to_string_lossy().as_ref());
    // The estimate is in the neighbourhood of the real size.
    let real = saved["bytes"].as_f64().unwrap();
    let guess = estimate["bytes"].as_f64().unwrap();
    assert!(
        guess > real / 3.0 && guess < real * 3.0,
        "{guess} vs {real}"
    );

    // The folder lists it (and nothing else, no temp file); the name is taken from now on.
    let listed = json_of(&window, "list_cloud_stems", json!({})).unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["name"], "Band_ Song_.sbstems");
    assert_eq!(listed[0]["path"], path.to_string_lossy().as_ref());
    assert_eq!(listed[0]["size"], saved["bytes"]);
    assert_eq!(listed[0]["placeholder"], false);
    assert!(listed[0]["modified_ms"].as_u64().unwrap() > 0);
    assert_eq!(listed[0].as_object().unwrap().len(), 5);
    assert_eq!(
        json_of(
            &window,
            "stems_cloud_save_path",
            json!({ "name": "Band: Song?" })
        )
        .unwrap(),
        drive
            .join("Band_ Song_ (2).sbstems")
            .to_string_lossy()
            .as_ref()
    );
    // Tabs and stems do not mix in the lists.
    assert_eq!(
        json_of(&window, "list_cloud_scores", json!({})).unwrap(),
        json!([])
    );

    // Another computer: a fresh cache and the same synced folder.
    let other_dir = tempfile::tempdir().unwrap();
    let other_cloud = CloudFolderStore::new(other_dir.path().join("data"));
    other_cloud.set(Some(&drive.to_string_lossy())).unwrap();
    let other = app_with_cloud(StemStore::new(other_dir.path().join("stems")), other_cloud);
    let other_window = main_window(&other);
    let there = json_of(&other_window, "list_cloud_stems", json!({})).unwrap();
    let opened = json_of(
        &other_window,
        "stems_open_bundle",
        json!({ "path": there[0]["path"] }),
    )
    .expect("open");
    assert_eq!(opened["id"], id);
    assert_eq!(opened["savedPath"], path.to_string_lossy().as_ref());
    for kind in ["drums", "bass", "vocals"] {
        let args = json!({ "id": id, "kind": kind });
        assert_eq!(
            raw_of(&window, "stems_read", args.clone()).unwrap(),
            raw_of(&other_window, "stems_read", args).unwrap(),
            "{kind}"
        );
    }

    // The drive goes away: the same errors as for tabs.
    drop(other_window);
    std::fs::remove_dir_all(&drive).unwrap();
    for cmd in ["list_cloud_stems", "list_cloud_scores"] {
        let err = json_of(&window, cmd, json!({})).expect_err("drive gone");
        assert_eq!(err["kind"], "not-found", "{cmd}");
        assert_eq!(
            err["message"],
            "The cloud folder could not be found. Is the drive offline?"
        );
    }
    let err = json_of(&window, "stems_cloud_save_path", json!({ "name": "x" })).expect_err("gone");
    assert_eq!(err["kind"], "not-found");
}

#[test]
fn an_online_only_stems_file_is_waited_for_before_it_opens() {
    let dir = tempfile::tempdir().unwrap();
    let drive = dir.path().join("Drive");
    std::fs::create_dir(&drive).unwrap();
    let app = app_with(StemStore::new(dir.path().join("stems")));
    let window = main_window(&app);
    let audio = dir.path().join("a.wav");
    write_band(&audio, 2.0);
    let song = json_of(&window, "stems_separate", separate_args(&audio, &["drums"])).unwrap();
    let made = dir.path().join("made.sbstems");
    json_of(
        &window,
        "stems_save_bundle",
        save_args(&song["id"], &made, false),
    )
    .unwrap();

    // iCloud shows an evicted file as `.name.icloud`; the sync client brings the file a moment
    // later (here a thread does, since `brctl` has no iCloud to ask).
    let target = drive.join("Away.sbstems");
    std::fs::write(drive.join(".Away.sbstems.icloud"), b"plist").unwrap();
    let other_dir = tempfile::tempdir().unwrap();
    let other = app_with(StemStore::new(other_dir.path().join("stems")));
    let other_window = main_window(&other);
    let (sender, waiting) = mpsc::channel();
    other_window.listen("cloud-download-waiting", move |event| {
        let _ = sender.send(event.payload().to_owned());
    });
    let arrive = {
        let (made, target) = (made.clone(), target.clone());
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(700));
            std::fs::copy(made, target).unwrap();
        })
    };
    let opened = json_of(
        &other_window,
        "stems_open_bundle",
        json!({ "path": target.to_string_lossy() }),
    )
    .expect("open once downloaded");
    arrive.join().unwrap();
    assert_eq!(opened["id"], song["id"]);
    let payloads: Vec<String> = waiting.try_iter().collect();
    assert_eq!(payloads.len(), 1);
    assert_eq!(
        serde_json::from_str::<String>(&payloads[0]).unwrap(),
        target.to_string_lossy()
    );
}

/// The cloud commands are registered and read their arguments in the shape the page sends. They
/// stop before any account is asked (no keychain, no network): an unknown song, and an item that
/// is not a cloud file.
#[test]
fn the_cloud_commands_are_registered_and_check_their_arguments_first() {
    let dir = tempfile::tempdir().unwrap();
    // No account is signed in (an empty store, not the real keychain) and nothing is reached.
    let cloud = CloudState::with_parts(
        Box::new(MemoryStore::default()),
        dir.path().join("pending"),
        provider_for,
    );
    let app = smart_beat_lib::setup(
        mock_builder()
            .manage(StemStore::new(dir.path().join("stems")))
            .manage(cloud),
    )
    .build(mock_context(noop_assets()))
    .expect("failed to build app");
    let window = main_window(&app);

    let err = json_of(
        &window,
        "stems_cloud_save",
        json!({ "request": {
            "id": "0123456789abcdef",
            "provider": "drive",
            "includeOriginal": false,
            "state": { "speed": 1 },
        }}),
    )
    .expect_err("an unknown song");
    assert_eq!(err["kind"], "not-found", "{err}");
    assert!(
        err["message"].as_str().unwrap().contains("not saved"),
        "{err}"
    );

    let err = json_of(
        &window,
        "stems_cloud_open",
        json!({ "request": { "item": "/Users/me/a.sbstems" } }),
    )
    .expect_err("not a cloud file");
    assert_eq!(err["kind"], "not-found", "{err}");

    // A provider the app does not know is refused when the arguments are read.
    let err = json_of(
        &window,
        "stems_cloud_save",
        json!({ "request": { "id": "x", "provider": "box", "includeOriginal": false }}),
    )
    .expect_err("an unknown provider");
    assert!(
        err.to_string().contains("provider") || err.to_string().contains("variant"),
        "{err}"
    );
}
