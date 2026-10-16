//! Measurements for ADR 0003 (audio engine). Run with:
//!
//! ```sh
//! cargo run --release --example audio_bench --manifest-path src-tauri/Cargo.toml
//! ```
//!
//! Prints SoundFont conversion time, the CPU cost of the effect chain and of
//! whole songs (as a share of real time), and the audio output's latency.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use smart_beat_lib::audio::chain::{Chain, EffectConfig, EffectSlot, MAX_TRACK_EFFECTS};
use smart_beat_lib::audio::dsp::compressor::CompressorParams;
use smart_beat_lib::audio::dsp::eq::graphic_bands;
use smart_beat_lib::audio::dsp::gate::GateParams;
use smart_beat_lib::audio::engine::{BLOCK, Engine};
use smart_beat_lib::audio::output::{self, Output};
use smart_beat_lib::audio::parse_sound_font;
use smart_beat_lib::audio::song::{Song, SongData};

const RATE: f32 = 48_000.0;

fn chain() -> Vec<EffectSlot> {
    let slot = |effect| EffectSlot {
        enabled: true,
        effect,
    };
    vec![
        slot(EffectConfig::Gate(GateParams::default())),
        slot(EffectConfig::Compressor(CompressorParams::default())),
        slot(EffectConfig::Eq {
            bands: graphic_bands(),
        }),
        slot(EffectConfig::Cab {
            ir: "builtin:4x12-modern".into(),
        }),
    ]
}

fn song(tracks: usize, seconds: u32) -> Song {
    let q = 960;
    let beats = seconds * 2; // 120 BPM
    let mut events = Vec::new();
    let mut channels = Vec::new();
    for t in 0..tracks {
        let channel = if t % 4 == 3 { 9 } else { (t % 9) as u32 };
        channels.push(vec![channel as u8]);
        if channel != 9 {
            events.push([0, 0xC0 | channel, [30, 33, 0, 48][t % 4], 0]);
        }
        for beat in 0..beats {
            for sub in 0..4 {
                let tick = beat * q + sub * q / 4;
                let key = if channel == 9 {
                    [36, 42, 38, 42][sub as usize]
                } else {
                    40 + (t as u32 * 5 + sub) % 24
                };
                events.push([tick, 0x90 | channel, key, 100]);
                events.push([tick + q / 4 - 5, 0x80 | channel, key, 0]);
            }
        }
    }
    Song::from_data(&SongData {
        division: q,
        events,
        tempos: vec![(0, 120.0)],
        metronome: vec![],
        tracks: channels,
        end_tick: beats * q,
    })
    .unwrap()
}

fn main() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let library = smart_beat_lib::audio::library::Library::new(
        std::env::temp_dir().join("smart-beat-bench-lib"),
    );
    let library = Arc::new(library);

    println!("## SoundFont conversion (SF3 → SF2 + parse)");
    let mut font = None;
    for path in [
        root.join("node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf3"),
        root.join("public/soundfont/FluidR3Mono_GM.sf3"),
    ] {
        let Ok(bytes) = std::fs::read(&path) else {
            println!("- {} not found (skipped)", path.display());
            continue;
        };
        let started = Instant::now();
        let parsed = parse_sound_font(&bytes).unwrap();
        println!(
            "- {}: {:.1} MB → {:.0} ms",
            path.file_name().unwrap().to_string_lossy(),
            bytes.len() as f64 / 1e6,
            started.elapsed().as_secs_f64() * 1000.0
        );
        font.get_or_insert(Arc::new(parsed));
    }
    let font = font.expect("run `pnpm install` first");

    println!("\n## Effect chain only (gate, compressor, 10-band EQ, cab IR), one stereo track");
    let mut c = Chain::build(
        &chain(),
        MAX_TRACK_EFFECTS,
        RATE,
        BLOCK,
        &library.assets(48_000),
        &smart_beat_lib::audio::plugin::PluginPool::default(),
    );
    let seconds = 20.0;
    let frames = (seconds * RATE) as usize;
    let (mut l, mut r) = (vec![0.1f32; BLOCK], vec![0.1f32; BLOCK]);
    let started = Instant::now();
    for _ in 0..frames / BLOCK {
        c.process(&mut l, &mut r);
    }
    let factor = started.elapsed().as_secs_f32() / seconds;
    println!(
        "- {:.3}% of one core ({:.0}× faster than real time)",
        factor * 100.0,
        1.0 / factor
    );

    println!("\n## Whole song: synth + chain per track (16 notes per bar per track)");
    for tracks in [1, 4, 8, 16] {
        for with_chain in [false, true] {
            let mut engine = Engine::new(font.clone(), RATE);
            engine.load(Arc::new(song(tracks, 20))).unwrap();
            if with_chain {
                for t in 0..tracks {
                    engine.set_track_chain(
                        t,
                        Chain::build(
                            &chain(),
                            MAX_TRACK_EFFECTS,
                            RATE,
                            BLOCK,
                            &library.assets(48_000),
                            &smart_beat_lib::audio::plugin::PluginPool::default(),
                        ),
                    );
                }
            }
            engine.play();
            let (mut l, mut r) = (vec![0.0; 512], vec![0.0; 512]);
            let started = Instant::now();
            for _ in 0..frames / 512 {
                engine.render(&mut l, &mut r);
            }
            let factor = started.elapsed().as_secs_f32() / seconds;
            println!(
                "- {tracks:>2} tracks{}: {:.2}% of one core",
                if with_chain { " + chains" } else { "         " },
                factor * 100.0
            );
        }
    }

    println!("\n## Audio output (default device)");
    match output::default_sample_rate() {
        Err(e) => println!("- no output: {e}"),
        Ok(rate) => {
            let engine = Arc::new(Mutex::new(Engine::new(font, rate as f32)));
            match Output::open(engine, false) {
                Err(e) => println!("- cannot open: {e}"),
                Ok(out) => {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let latency = out
                        .published
                        .latency_us
                        .load(std::sync::atomic::Ordering::Relaxed);
                    println!(
                        "- {} Hz, {} channels, output latency {:.1} ms (callback → playback)",
                        out.sample_rate,
                        out.channels,
                        latency as f64 / 1000.0
                    );
                }
            }
        }
    }
}
