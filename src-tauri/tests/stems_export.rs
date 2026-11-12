//! Exporting the stems as audio files, and loading a stem as a lane's audio file, over Tauri's
//! mock IPC with the real `setup()` wiring (issue #223). The song is the synthetic band from
//! `separation::synth`, separated by the built-in engine into a store in a temp folder.

use std::io::Cursor;
use std::path::Path;
use std::sync::mpsc;

use serde_json::{Value, json};
use smart_beat_lib::audio::AudioState;
use smart_beat_lib::menu::MAIN_WINDOW;
use smart_beat_lib::separation::synth;
use smart_beat_lib::stems::StemStore;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{App, Listener, WebviewWindow, WebviewWindowBuilder};

fn app_with(store: StemStore) -> App<MockRuntime> {
    let library = store.root().parent().unwrap().join("library");
    smart_beat_lib::setup(
        mock_builder()
            .manage(store)
            .manage(AudioState::new(library)),
    )
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

/// (rate, frames, interleaved samples) of a WAV file.
fn read_wav(path: &Path) -> (u32, usize, Vec<i16>) {
    let bytes = std::fs::read(path).unwrap();
    let mut reader = hound::WavReader::new(Cursor::new(bytes)).expect("a valid WAV file");
    let spec = reader.spec();
    assert_eq!((spec.channels, spec.bits_per_sample), (2, 16));
    let samples: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
    (spec.sample_rate, samples.len() / 2, samples)
}

fn export_listener(window: &WebviewWindow<MockRuntime>) -> mpsc::Receiver<Value> {
    let (sender, receiver) = mpsc::channel();
    window.listen("stems-export-progress", move |event| {
        let _ = sender.send(serde_json::from_str(event.payload()).unwrap());
    });
    receiver
}

/// Separates a 5 s band into drums, bass, vocals, panned and other. Returns the song.
fn separated(dir: &Path, window: &WebviewWindow<MockRuntime>, name: &str) -> (Value, usize) {
    let file = dir.join(format!("{name}.wav"));
    let frames = write_band(&file, 5.0);
    let song = json_of(
        window,
        "stems_separate",
        json!({ "request": {
            "path": file.to_string_lossy(),
            "kinds": ["drums", "bass", "vocals", "panned"],
            "engine": "fast",
            "strongDrums": false,
        }}),
    )
    .expect("separation failed");
    (song, frames)
}

fn kinds_of(song: &Value) -> Vec<String> {
    song["stems"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["kind"].as_str().unwrap().to_owned())
        .collect()
}

fn cached_stem(dir: &Path, id: &str, kind: &str) -> std::path::PathBuf {
    dir.join("stems").join(id).join(format!("{kind}.wav"))
}

#[test]
fn a_mixed_export_is_one_file_with_the_length_and_rate_of_the_song() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with(StemStore::new(dir.path().join("stems")));
    let window = main_window(&app);
    let (song, frames) = separated(dir.path(), &window, "Band Song");
    let id = song["id"].clone();
    let progress = export_listener(&window);

    let out = dir.path().join("out");
    std::fs::create_dir(&out).unwrap();
    let dest = out.join("Band Song mix.wav");
    let result = json_of(
        &window,
        "stems_export_mixed",
        json!({ "request": {
            "id": id,
            "kinds": ["bass", "drums"],
            "format": "wav",
            "dest": dest.to_string_lossy(),
        }}),
    )
    .expect("export failed");
    assert_eq!(result["paths"], json!([dest.to_string_lossy()]));
    assert_eq!(result["folder"], Value::Null);
    let (rate, got_frames, samples) = read_wav(&dest);
    assert_eq!((rate as u64, got_frames), (44_100, frames));
    // Drums + bass, added: the same sum as the two cached files.
    let id = id.as_str().unwrap();
    let (_, _, drums) = read_wav(&cached_stem(dir.path(), id, "drums"));
    let (_, _, bass) = read_wav(&cached_stem(dir.path(), id, "bass"));
    for i in (0..samples.len()).step_by(997) {
        let want = (i32::from(drums[i]) + i32::from(bass[i])).clamp(-32768, 32767);
        assert!((i32::from(samples[i]) - want).abs() <= 1, "sample {i}");
    }

    let events: Vec<Value> = progress.try_iter().collect();
    assert!(!events.is_empty());
    assert!(
        events
            .iter()
            .all(|e| ["mixing", "writing"].contains(&e["stage"].as_str().unwrap()))
    );
    assert!(
        events
            .iter()
            .all(|e| (0.0..=1.0).contains(&e["fraction"].as_f64().unwrap()))
    );
    assert_eq!(events.last().unwrap()["fraction"], 1.0);
}

#[test]
fn a_batch_export_is_one_file_per_stem_named_after_the_stem_and_the_song() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with(StemStore::new(dir.path().join("stems")));
    let window = main_window(&app);
    let (song, frames) = separated(dir.path(), &window, "Band Song");
    let id = song["id"].as_str().unwrap().to_owned();
    let all = kinds_of(&song);
    assert!(all.len() >= 4, "{all:?}");

    let out = dir.path().join("out");
    std::fs::create_dir(&out).unwrap();
    // A subset: two stems, FLAC.
    let result = json_of(
        &window,
        "stems_export_batch",
        json!({ "request": {
            "id": id,
            "kinds": ["vocals", "drums"],
            "format": "flac",
            "dir": out.to_string_lossy(),
        }}),
    )
    .expect("export failed");
    let folder = out.join("Band Song stems");
    assert_eq!(result["folder"], json!(folder.to_string_lossy()));
    let mut names: Vec<String> = std::fs::read_dir(&folder)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(
        names,
        vec!["Drums - Band Song.flac", "Vocals - Band Song.flac"]
    );

    // Every stem as WAV: the files are the cache's own, so length and rate are the song's.
    let result = json_of(
        &window,
        "stems_export_batch",
        json!({ "request": {
            "id": id, "kinds": all, "format": "wav", "dir": out.to_string_lossy(),
        }}),
    )
    .expect("export failed");
    let folder = std::path::PathBuf::from(result["folder"].as_str().unwrap());
    assert!(folder.ends_with("Band Song stems (2)"), "{folder:?}");
    for kind in kinds_of(&song) {
        let label = match kind.as_str() {
            "panned" => "Guitars and keys".to_owned(),
            other => format!("{}{}", other[..1].to_uppercase(), &other[1..]),
        };
        let (rate, got_frames, _) = read_wav(&folder.join(format!("{label} - Band Song.wav")));
        assert_eq!((rate, got_frames), (44_100, frames), "{kind}");
    }
}

#[test]
fn exporting_with_nothing_chosen_or_a_missing_song_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with(StemStore::new(dir.path().join("stems")));
    let window = main_window(&app);
    let (song, _) = separated(dir.path(), &window, "Band Song");
    let out = dir.path().join("out");
    std::fs::create_dir(&out).unwrap();

    let none = json_of(
        &window,
        "stems_export_mixed",
        json!({ "request": {
            "id": song["id"], "kinds": [], "format": "wav",
            "dest": out.join("x.wav").to_string_lossy(),
        }}),
    )
    .expect_err("must fail");
    assert!(none.to_string().contains("at least one stem"), "{none}");
    assert!(!out.join("x.wav").exists());

    let gone = json_of(
        &window,
        "stems_export_batch",
        json!({ "request": {
            "id": "ffffffffffffffff", "kinds": ["drums"], "format": "wav",
            "dir": out.to_string_lossy(),
        }}),
    )
    .expect_err("must fail");
    assert!(
        gone.to_string().contains("not in the stem library"),
        "{gone}"
    );
    assert_eq!(std::fs::read_dir(&out).unwrap().count(), 0);
}

#[test]
fn a_stem_becomes_a_lane_audio_file_of_the_same_length_and_rate() {
    let dir = tempfile::tempdir().unwrap();
    let app = app_with(StemStore::new(dir.path().join("stems")));
    let window = main_window(&app);
    let (song, _) = separated(dir.path(), &window, "Band Song");
    let id = song["id"].clone();

    let info = json_of(
        &window,
        "stems_audio_source",
        json!({ "id": id, "kind": "drums" }),
    )
    .expect("loading a stem failed");
    assert_eq!(info["name"], "Drums - Band Song.wav");
    assert_eq!(info["ext"], "wav");
    assert_eq!(info["sampleRate"], 44_100);
    assert!((info["durationMs"].as_f64().unwrap() - 5_000.0).abs() < 10.0);
    assert_eq!(info["id"].as_str().unwrap().len(), 64);
    // Loading it again gives the same content id (one source, however often it is added).
    let again = json_of(
        &window,
        "stems_audio_source",
        json!({ "id": id, "kind": "drums" }),
    )
    .unwrap();
    assert_eq!(again["id"], info["id"]);

    let missing = json_of(
        &window,
        "stems_audio_source",
        json!({ "id": id, "kind": "piano" }),
    )
    .expect_err("this song has no piano");
    assert!(missing.to_string().contains("no piano stem"), "{missing}");
}
