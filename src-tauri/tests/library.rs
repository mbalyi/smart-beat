//! The sound library end to end (#41): a tiny synthetic amp capture and
//! cabinet impulse response go through the library, into effect chains and
//! through a whole song with the real Sonivox SoundFont. Plus the promise
//! that imported sounds never leave the machine.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use smart_beat_lib::audio::chain::{Chain, EffectConfig, EffectSlot, MAX_TRACK_EFFECTS};
use smart_beat_lib::audio::engine::{BLOCK, Engine};
use smart_beat_lib::audio::library::{AssetKind, Library};
use smart_beat_lib::audio::parse_sound_font;
use smart_beat_lib::audio::song::{Song, SongData};

mod common;

fn sonivox() -> Arc<rustysynth::SoundFont> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf3");
    let bytes = std::fs::read(path).expect("run `pnpm install` first");
    Arc::new(parse_sound_font(&bytes).expect("SF3 converts"))
}

fn rms(s: &[f32]) -> f32 {
    (s.iter().map(|x| x * x).sum::<f32>() / s.len().max(1) as f32).sqrt()
}

fn guitar_song() -> Song {
    let q = 960;
    let mut events = vec![[0, 0xC0, 30, 0]];
    for beat in 0..4u32 {
        let t = beat * q;
        for key in [40, 47] {
            events.push([t, 0x90, key, 100]);
            events.push([t + q - 10, 0x80, key, 0]);
        }
    }
    Song::from_data(&SongData {
        division: q,
        events,
        tempos: vec![(0, 120.0)],
        metronome: vec![],
        tracks: vec![vec![0]],
        end_tick: 4 * q,
    })
    .unwrap()
}

fn import(library: &Library, dir: &Path, name: &str, bytes: &[u8], kind: AssetKind) -> String {
    let path = dir.join(name);
    std::fs::write(&path, bytes).unwrap();
    library.import(&path, kind).unwrap().id
}

/// Plays a song through `Amp -> Cab` built from imported files, at a given
/// engine rate and capture rate, and returns the left channel.
fn play_through(engine_rate: u32, capture_rate: f64) -> Vec<f32> {
    let dir = tempfile::tempdir().unwrap();
    let library = Arc::new(Library::new(dir.path().join("library")));
    let amp = import(
        &library,
        dir.path(),
        "amp.nam",
        common::tiny_nam(Some(capture_rate), Some(-24.0), "Tiny").as_bytes(),
        AssetKind::Amp,
    );
    let cab = import(
        &library,
        dir.path(),
        "cab.wav",
        &common::tiny_ir(44_100, 4_096),
        AssetKind::Cab,
    );
    let slots = [
        EffectSlot {
            enabled: true,
            effect: EffectConfig::Amp {
                model: amp,
                input_db: -6.0,
                output_db: -18.0,
                match_loudness: true,
            },
        },
        EffectSlot {
            enabled: true,
            effect: EffectConfig::Cab { ir: cab },
        },
    ];
    let assets = library.assets(engine_rate);
    let chain = Chain::build(
        &slots,
        MAX_TRACK_EFFECTS,
        engine_rate as f32,
        BLOCK,
        &assets,
    );
    assert!(chain.problems.is_empty(), "{:?}", chain.problems);
    let mut engine = Engine::new(sonivox(), engine_rate as f32);
    engine.load(Arc::new(guitar_song())).unwrap();
    engine.set_track_chain(0, chain);
    engine.play();
    let frames = engine_rate as usize * 2;
    let (mut l, mut r) = (vec![0.0; frames], vec![0.0; frames]);
    engine.render(&mut l, &mut r);
    l
}

#[test]
fn a_song_plays_through_an_imported_amp_and_cabinet() {
    let out = play_through(48_000, 48_000.0);
    assert!(out.iter().all(|s| s.is_finite() && s.abs() <= 1.0));
    assert!(rms(&out) > 0.001, "silent: {}", rms(&out));
}

#[test]
fn a_capture_made_at_another_rate_plays_too() {
    // 44.1 kHz capture on a 48 kHz output, and 48 kHz capture on a 44.1 kHz one.
    for (engine, capture) in [(48_000, 44_100.0), (44_100, 48_000.0), (96_000, 48_000.0)] {
        let out = play_through(engine, capture);
        assert!(out.iter().all(|s| s.is_finite()), "{engine}/{capture}");
        assert!(rms(&out) > 0.001, "{engine}/{capture} silent");
    }
}

#[test]
fn a_chain_with_a_removed_asset_still_plays_the_rest() {
    let dir = tempfile::tempdir().unwrap();
    let library = Arc::new(Library::new(dir.path().join("library")));
    let amp = import(
        &library,
        dir.path(),
        "amp.nam",
        common::tiny_nam(None, None, "Tiny").as_bytes(),
        AssetKind::Amp,
    );
    let slots = [
        EffectSlot {
            enabled: true,
            effect: EffectConfig::Amp {
                model: amp.clone(),
                input_db: 0.0,
                output_db: -18.0,
                match_loudness: false,
            },
        },
        EffectSlot {
            enabled: true,
            effect: EffectConfig::Cab {
                ir: "removed-long-ago".into(),
            },
        },
    ];
    let chain = Chain::build(
        &slots,
        MAX_TRACK_EFFECTS,
        48_000.0,
        BLOCK,
        &library.assets(48_000),
    );
    assert_eq!(chain.problems.len(), 1);
    assert_eq!(chain.problems[0].index, 1);
    assert!(
        chain.problems[0]
            .message
            .contains("not in your sound library")
    );
    // And once the amp is removed, that block reports a problem too.
    library.remove(&amp).unwrap();
    let chain = Chain::build(
        &slots,
        MAX_TRACK_EFFECTS,
        48_000.0,
        BLOCK,
        &library.assets(48_000),
    );
    assert_eq!(chain.problems.len(), 2);
    assert!(chain.is_empty());
}

#[test]
fn garbage_files_never_reach_the_audio_engine() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::new(dir.path().join("library"));
    let nam = common::tiny_nam(None, None, "Tiny");
    let mut cases: Vec<(&str, Vec<u8>, AssetKind)> = vec![
        ("empty.nam", vec![], AssetKind::Amp),
        ("text.nam", b"this is not json".to_vec(), AssetKind::Amp),
        (
            "half.nam",
            nam.as_bytes()[..nam.len() / 3].to_vec(),
            AssetKind::Amp,
        ),
        ("silent.wav", common::tiny_ir(48_000, 0), AssetKind::Cab),
        (
            "riff.wav",
            b"RIFF\0\0\0\0WAVEfmt junk".to_vec(),
            AssetKind::Cab,
        ),
        ("amp-as-cab.wav", nam.clone().into_bytes(), AssetKind::Cab),
    ];
    // Every prefix of a real WAV is either valid or refused, never a panic.
    let wav = common::tiny_ir(48_000, 512);
    for cut in (0..wav.len()).step_by(97) {
        cases.push(("cut.wav", wav[..cut].to_vec(), AssetKind::Cab));
    }
    for (name, bytes, kind) in cases {
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        // Ok or Err are both fine; the point is that nothing panics.
        let _ = library.import(&path, kind);
    }
}

/// Every Rust source file under `dir`, recursively.
fn rust_sources(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(rust_sources(&path));
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            files.push(path);
        }
    }
    files
}

/// Imported sounds are copied into the app data folder and nowhere else, and only the
/// usage counters, audio transcription and the one-time piano model download touch the network.
#[test]
fn imported_sounds_stay_on_this_computer() {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::new(dir.path().join("library"));
    let id = import(
        &library,
        dir.path(),
        "amp.nam",
        common::tiny_nam(None, None, "Tiny").as_bytes(),
        AssetKind::Amp,
    );
    let stored: Vec<_> = std::fs::read_dir(dir.path().join("library"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(stored.contains(&format!("{id}.nam")), "{stored:?}");

    // Two network clients, both used from Rust, never from the page: `ureq` for the usage
    // counters (src/telemetry.rs) and the piano model download (src/recording/piano_model.rs),
    // and `reqwest` for audio transcription (src/transcription.rs).
    // No other client, no fs/http/shell permission, no remote host in the CSP. The updater
    // plugin makes its own request from Rust.
    let manifest = env!("CARGO_MANIFEST_DIR");
    let cargo = std::fs::read_to_string(format!("{manifest}/Cargo.toml")).unwrap();
    for client in ["hyper", "curl", "isahc", "surf", "attohttpc"] {
        assert!(
            !cargo.contains(client),
            "network client {client} in Cargo.toml"
        );
    }
    let src = std::path::Path::new(manifest).join("src");
    for file in rust_sources(&src) {
        let source = std::fs::read_to_string(&file).unwrap();
        for (client, owners) in [
            ("reqwest", &["transcription.rs"][..]),
            ("ureq", &["telemetry.rs", "recording/piano_model.rs"][..]),
        ] {
            assert!(
                owners.iter().any(|owner| file == src.join(owner)) || !source.contains(client),
                "{client} in {}: only src/{owners:?} may use it",
                file.display()
            );
        }
    }
    // The piano model download has one fixed address: this repository's release. The recording
    // is never part of it.
    let model = std::fs::read_to_string(src.join("recording/piano_model.rs")).unwrap();
    let base = "https://github.com/mbalyi/smart-beat/releases/download/";
    for (index, _) in model.match_indices("https://") {
        assert!(
            model[index..].starts_with(base),
            "unexpected URL in piano_model.rs"
        );
    }
    assert!(
        !model.contains(".post("),
        "piano_model.rs must only download"
    );
    for name in ["telemetry.rs", "transcription.rs", "lib.rs", "commands.rs"] {
        let code = std::fs::read_to_string(src.join(name)).unwrap();
        // The endpoints come from the build, never a literal host.
        assert!(!code.contains("https://"), "hard-coded URL in src/{name}");
    }
    let capabilities =
        std::fs::read_to_string(format!("{manifest}/capabilities/default.json")).unwrap();
    for plugin in ["http:", "shell:", "fs:", "upload:", "websocket:"] {
        assert!(!capabilities.contains(plugin), "permission {plugin}");
    }
    let config: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(format!("{manifest}/tauri.conf.json")).unwrap(),
    )
    .unwrap();
    let csp = &config["app"]["security"]["csp"];
    // Tauri's own IPC channel is the only address the page may talk to.
    let connect = csp["connect-src"].as_str().unwrap_or("");
    let remote: Vec<&str> = connect
        .split_whitespace()
        .filter(|source| !["'self'", "ipc:", "http://ipc.localhost"].contains(source))
        .collect();
    assert!(remote.is_empty(), "connect-src allows {remote:?}");
    assert!(csp["default-src"].as_str().unwrap().contains("'self'"));
}
