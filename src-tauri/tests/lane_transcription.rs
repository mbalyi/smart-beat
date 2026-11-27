//! "Sheet from an audio lane" (#235) over Tauri's mock IPC with the real `setup()` wiring: a lane,
//! a clip or a range of it is rendered in Rust and transcribed, and the notes come back in
//! seconds on the audio timeline.

use serde_json::{Value, json};
use smart_beat_lib::audio::AudioState;
use smart_beat_lib::audio::backing::BackingParams;
use smart_beat_lib::audio_lanes::{
    AudioClip, AudioLane, AudioLanes, AudioSource, AudioTake, ClipFade,
};
use smart_beat_lib::menu::MAIN_WINDOW;
use smart_beat_lib::transcription::Running;
use std::f64::consts::PI;
use std::sync::mpsc;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{App, Listener, WebviewWindow, WebviewWindowBuilder};

const RATE: u32 = 44_100;

struct Fixture {
    /// Kept alive: the window belongs to it.
    _app: App<MockRuntime>,
    window: WebviewWindow<MockRuntime>,
    /// The id of the loaded tone file.
    source: String,
    _dir: tempfile::TempDir,
}

fn request(
    window: &WebviewWindow<MockRuntime>,
    cmd: &str,
    body: InvokeBody,
    headers: &[(&str, &str)],
) -> Result<InvokeResponseBody, Value> {
    let url = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    let mut map = tauri::http::HeaderMap::new();
    for (name, value) in headers {
        map.insert(
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
            headers: map,
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

fn call(window: &WebviewWindow<MockRuntime>, cmd: &str, args: Value) -> Result<Value, Value> {
    request(window, cmd, InvokeBody::Json(args), &[]).map(|body| body.deserialize().unwrap())
}

fn hz(midi: u8) -> f64 {
    440.0 * 2f64.powf((f64::from(midi) - 69.0) / 12.0)
}

/// A plucked string tone (a few fading harmonics, a soft attack).
fn pluck(frequency: f64, seconds: f64) -> Vec<f32> {
    (0..(seconds * f64::from(RATE)) as usize)
        .map(|n| {
            let t = n as f64 / f64::from(RATE);
            let tone: f64 = (1..=6)
                .map(|k| {
                    let k = f64::from(k);
                    (2.0 * PI * frequency * k * t).sin() * (-t * (1.5 + 0.9 * k)).exp()
                        / k.powf(1.1)
                })
                .sum();
            (tone * 0.4 * (1.0 - (-t * 400.0).exp())) as f32
        })
        .collect()
}

/// A4 (MIDI 69) plucked at 0.5 s and E4 (64) at 2.5 s, 4.5 s long, as a mono 16-bit WAV.
fn tone_wav() -> Vec<u8> {
    let mut audio = vec![0.0f32; RATE as usize * 9 / 2];
    for (start, pitch) in [(0.5, 69u8), (2.5, 64)] {
        let from = (start * f64::from(RATE)) as usize;
        for (slot, sample) in audio[from..].iter_mut().zip(pluck(hz(pitch), 1.6)) {
            *slot += sample;
        }
    }
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec).unwrap();
        for sample in audio {
            writer.write_sample((sample * 20_000.0) as i16).unwrap();
        }
        writer.finalize().unwrap();
    }
    cursor.into_inner()
}

fn clip(id: &str, source: &str, start_ms: f64, length_ms: f64) -> AudioClip {
    AudioClip {
        id: id.into(),
        takes: vec![AudioTake {
            name: "take".into(),
            source_id: source.into(),
            offset_ms: 0.0,
        }],
        take: 0,
        start_ms,
        length_ms,
        gain_db: 0.0,
        mute: false,
        locked: false,
        reversed: false,
        semitones: 0,
        cents: 0,
        playrate: 1.0,
        preserve_pitch: true,
        fade_in: ClipFade::default(),
        fade_out: ClipFade::default(),
        envelope: vec![],
        stretch: vec![],
        group_id: None,
        midi: None,
    }
}

fn lane(id: &str, clips: Vec<AudioClip>) -> AudioLane {
    AudioLane {
        id: id.into(),
        name: id.into(),
        color: None,
        params: BackingParams::default(),
        follow_transposition: true,
        effects: vec![],
        auto_bypass: false,
        automation: vec![],
        sends: vec![],
        parent: None,
        folder: false,
        collapsed: false,
        group: 0,
        height: None,
        clips,
        shown_in_score: false,
        kind: None,
        instrument: None,
    }
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let app = smart_beat_lib::setup(mock_builder())
            // The page-facing state `setup()` adds only once the app runs.
            .manage(AudioState::new(dir.path().join("library")))
            .manage(Running::default())
            .build(mock_context(noop_assets()))
            .expect("failed to build app");
        let window = WebviewWindowBuilder::new(&app, MAIN_WINDOW, Default::default())
            .build()
            .expect("failed to create window");
        let loaded = request(
            &window,
            "audio_add_take",
            InvokeBody::Raw(tone_wav()),
            &[("x-name", "tone.wav")],
        )
        .expect("the tone loads")
        .deserialize::<Value>()
        .unwrap();
        let source = loaded["id"].as_str().unwrap().to_owned();
        Self {
            _app: app,
            window,
            source,
            _dir: dir,
        }
    }

    /// Hands these lanes to the audio state, as the page does.
    fn set_lanes(&self, lanes: Vec<AudioLane>) {
        let audio = AudioLanes {
            lanes,
            sources: vec![AudioSource {
                id: self.source.clone(),
                name: "tone.wav".into(),
                ext: "wav".into(),
                path: None,
                embedded: true,
                legacy_entry: None,
            }],
            ..Default::default()
        };
        call(
            &self.window,
            "audio_set_lanes",
            json!({ "lanes": { "audio": audio, "sync": [], "transpose": 0 } }),
        )
        .expect("the lanes are accepted");
    }

    fn transcribe(&self, args: Value) -> Result<Value, Value> {
        transcribe_on(&self.window, args)
    }
}

/// `transcribe_lane` with the operation id `run-1` and the guitar, unless `args` say otherwise.
fn transcribe_on(window: &WebviewWindow<MockRuntime>, args: Value) -> Result<Value, Value> {
    let mut full = json!({ "operationId": "run-1", "instrument": "guitar" });
    full.as_object_mut()
        .unwrap()
        .extend(args.as_object().unwrap().clone());
    call(window, "transcribe_lane", full)
}

/// The start of the first note of `pitch`, in seconds.
fn start_of(result: &Value, pitch: u64) -> Option<f64> {
    result["notes"]
        .as_array()?
        .iter()
        .filter(|n| n["pitch"] == pitch)
        .map(|n| n["start"].as_f64().unwrap())
        .min_by(f64::total_cmp)
}

fn near(actual: Option<f64>, expected: f64, result: &Value) {
    let actual = actual.unwrap_or_else(|| panic!("no note near {expected} s in {result:#?}"));
    assert!(
        (actual - expected).abs() < 0.08,
        "{actual} is not near {expected} s in {result:#?}"
    );
}

#[test]
fn a_lane_gives_the_notes_at_timeline_seconds() {
    let f = Fixture::new();
    f.set_lanes(vec![lane(
        "guitar",
        vec![clip("c1", &f.source, 10_000.0, 4_500.0)],
    )]);
    let (sender, receiver) = mpsc::channel();
    f.window
        .listen("lane-transcription-progress", move |event| {
            let _ = sender.send(event.payload().to_owned());
        });
    let result = f.transcribe(json!({ "laneId": "guitar" })).unwrap();
    assert_eq!(result["startMs"], 10_000.0);
    assert_eq!(result["endMs"], 14_500.0);
    assert_eq!(result["clipIds"], json!(["c1"]));
    // A4 is 69, plucked half a second into the clip, which starts at 10 s.
    near(start_of(&result, 69), 10.5, &result);
    near(start_of(&result, 64), 12.5, &result);
    let notes = result["notes"].as_array().unwrap();
    assert!(
        notes.iter().all(
            |n| n["end"].as_f64().unwrap() >= n["start"].as_f64().unwrap()
                && n["velocity"].is_number()
        ),
        "{result:#?}"
    );
    let events: Vec<Value> = receiver
        .try_iter()
        .map(|payload| serde_json::from_str(&payload).unwrap())
        .collect();
    assert!(events.iter().all(|e| e["operationId"] == "run-1"));
    let fractions: Vec<f64> = events
        .iter()
        .map(|e| e["fraction"].as_f64().unwrap())
        .collect();
    assert!(fractions.windows(2).all(|w| w[0] <= w[1]), "{fractions:?}");
    assert_eq!(fractions.last(), Some(&1.0));
}

#[test]
fn a_clip_gives_the_same_notes_and_bass_uses_the_guitar_settings() {
    let f = Fixture::new();
    f.set_lanes(vec![lane(
        "bass",
        vec![
            clip("other", &f.source, 0.0, 1_000.0),
            clip("c1", &f.source, 10_000.0, 4_500.0),
        ],
    )]);
    let result = f
        .transcribe(json!({ "laneId": "bass", "clipId": "c1", "instrument": "bass" }))
        .unwrap();
    assert_eq!(result["clipIds"], json!(["c1"]));
    assert_eq!(result["startMs"], 10_000.0);
    near(start_of(&result, 69), 10.5, &result);
}

#[test]
fn a_range_gives_only_the_notes_inside_it() {
    let f = Fixture::new();
    f.set_lanes(vec![lane(
        "guitar",
        vec![clip("c1", &f.source, 10_000.0, 4_500.0)],
    )]);
    let result = f
        .transcribe(json!({ "laneId": "guitar", "startMs": 12_000.0, "endMs": 14_000.0 }))
        .unwrap();
    assert_eq!(result["startMs"], 12_000.0);
    assert_eq!(result["endMs"], 14_000.0);
    near(start_of(&result, 64), 12.5, &result);
    assert_eq!(start_of(&result, 69), None, "{result:#?}");
}

#[test]
fn silence_and_muted_clips_are_clear_messages() {
    let f = Fixture::new();
    let mut muted = clip("m1", &f.source, 0.0, 1_000.0);
    muted.mute = true;
    let mut folder = lane("folder", vec![]);
    folder.folder = true;
    f.set_lanes(vec![
        lane("empty", vec![]),
        lane("muted", vec![muted]),
        lane("tone", vec![clip("c1", &f.source, 1_000.0, 2_000.0)]),
        folder,
    ]);
    let refused = |args: Value| {
        let error = f.transcribe(args).unwrap_err();
        assert!(["audio", "not-found"].contains(&error["kind"].as_str().unwrap()));
        error["message"].as_str().unwrap().to_owned()
    };
    assert_eq!(
        refused(json!({ "laneId": "empty" })),
        "This lane has no audio."
    );
    assert_eq!(
        refused(json!({ "laneId": "muted" })),
        "All the clips of this lane are muted. Unmute one to transcribe it."
    );
    assert_eq!(
        refused(json!({ "laneId": "muted", "clipId": "m1" })),
        "That clip is muted. Unmute it to transcribe it."
    );
    assert_eq!(
        refused(json!({ "laneId": "tone", "startMs": 20_000.0, "endMs": 30_000.0 })),
        "There is no audio in that range."
    );
    assert_eq!(
        refused(json!({ "laneId": "tone", "clipId": "nope" })),
        "That clip is not in the lane any more."
    );
    assert!(refused(json!({ "laneId": "folder" })).contains("folder"));
    assert_eq!(
        refused(json!({ "laneId": "tone", "instrument": "kazoo" })),
        "Choose guitar, bass, piano or drums."
    );
    let missing = f.transcribe(json!({ "laneId": "nope" })).unwrap_err();
    assert_eq!(missing["kind"], "not-found");
    assert_eq!(missing["message"], "That audio lane is not in the song.");
}

#[test]
fn a_song_without_lanes_says_so() {
    let f = Fixture::new();
    let error = f.transcribe(json!({ "laneId": "any" })).unwrap_err();
    assert_eq!(error["kind"], "not-found");
    assert_eq!(error["message"], "This song has no audio lanes.");
}

#[test]
fn more_than_ten_minutes_are_refused_before_any_work() {
    let f = Fixture::new();
    f.set_lanes(vec![lane(
        "long",
        vec![clip("c1", &f.source, 0.0, 600_001.0)],
    )]);
    let error = f.transcribe(json!({ "laneId": "long" })).unwrap_err();
    assert_eq!(error["kind"], "audio");
    assert!(error["message"].as_str().unwrap().contains("10 minutes"));
    // A range of the same lane inside the limit is fine.
    let ok = f
        .transcribe(json!({ "laneId": "long", "startMs": 0.0, "endMs": 4_000.0 }))
        .unwrap();
    near(start_of(&ok, 69), 0.5, &ok);
}

#[test]
fn the_ai_engine_needs_its_model_like_record_to_tab() {
    let f = Fixture::new();
    f.set_lanes(vec![lane(
        "tone",
        vec![clip("c1", &f.source, 0.0, 2_000.0)],
    )]);
    let error = f
        .transcribe(json!({ "laneId": "tone", "engine": "muscriptor", "modelSize": "small" }))
        .unwrap_err();
    assert_eq!(error["kind"], "audio");
    assert!(error["message"].as_str().unwrap().contains("MuScriptor"));
    let error = f
        .transcribe(json!({ "laneId": "tone", "instrument": "piano", "engine": "transkun" }))
        .unwrap_err();
    assert_eq!(error["message"], "Download the piano model first.");
}

#[test]
fn a_stop_before_the_start_wins() {
    let f = Fixture::new();
    f.set_lanes(vec![lane(
        "tone",
        vec![clip("c1", &f.source, 0.0, 2_000.0)],
    )]);
    call(
        &f.window,
        "cancel_transcription",
        json!({ "operationId": "run-1" }),
    )
    .unwrap();
    let error = f.transcribe(json!({ "laneId": "tone" })).unwrap_err();
    assert_eq!(error["message"], "Transcription stopped.");
    // The stop was used up: the same id runs afterwards.
    assert!(f.transcribe(json!({ "laneId": "tone" })).is_ok());
}

#[test]
fn a_stop_during_the_run_ends_it() {
    let f = Fixture::new();
    // The file ends after 4.5 s; the long clip keeps the render busy for a while.
    f.set_lanes(vec![lane(
        "long",
        vec![clip("c1", &f.source, 0.0, 500_000.0)],
    )]);
    let (sender, receiver) = mpsc::channel();
    f.window
        .listen("lane-transcription-progress", move |event| {
            let _ = sender.send(event.payload().to_owned());
        });
    let window = f.window.clone();
    let result = std::thread::scope(|scope| {
        let run = scope.spawn(|| transcribe_on(&window, json!({ "laneId": "long" })));
        receiver
            .recv_timeout(std::time::Duration::from_secs(120))
            .expect("the run reports progress");
        call(
            &f.window,
            "cancel_transcription",
            json!({ "operationId": "run-1" }),
        )
        .unwrap();
        run.join().unwrap()
    });
    let error = result.unwrap_err();
    assert_eq!(error["kind"], "audio");
    assert_eq!(error["message"], "Transcription stopped.");
    f.set_lanes(vec![lane(
        "tone",
        vec![clip("c1", &f.source, 0.0, 2_000.0)],
    )]);
    assert!(
        f.transcribe(json!({ "laneId": "tone", "operationId": "run-2" }))
            .is_ok(),
        "the stopped run is gone"
    );
}
