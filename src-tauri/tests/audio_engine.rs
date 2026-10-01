//! Native audio engine against the real Sonivox SoundFont that ships with
//! alphaTab (installed by `pnpm install`): SF3 conversion, rendering a song
//! through effect chains, mixing and transport.

use std::path::PathBuf;
use std::sync::Arc;

use smart_beat_lib::audio::chain::{Chain, EffectConfig, EffectSlot, MAX_TRACK_EFFECTS, NoAssets};
use smart_beat_lib::audio::dsp::compressor::CompressorParams;
use smart_beat_lib::audio::dsp::drive::DriveParams;
use smart_beat_lib::audio::dsp::eq::graphic_bands;
use smart_beat_lib::audio::dsp::gate::GateParams;
use smart_beat_lib::audio::engine::{BLOCK, BusMix, Engine};
use smart_beat_lib::audio::parse_sound_font;
use smart_beat_lib::audio::song::{Song, SongData};

const RATE: f32 = 48_000.0;

fn soundfont_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../node_modules/@coderline/alphatab/dist/soundfont")
        .join(name)
}

fn sonivox() -> Arc<rustysynth::SoundFont> {
    let bytes = std::fs::read(soundfont_path("sonivox.sf3")).expect("run `pnpm install` first");
    Arc::new(parse_sound_font(&bytes).expect("SF3 converts"))
}

/// Two bars at 120 BPM: a distorted guitar (channel 0) playing a power chord
/// on every beat, and drums (channel 9) with kick and snare.
fn song() -> Song {
    let q = 960;
    let mut events = vec![[0, 0xC0, 30, 0]]; // distortion guitar
    for beat in 0..8u32 {
        let t = beat * q;
        for key in [40, 47] {
            events.push([t, 0x90, key, 100]);
            events.push([t + q - 10, 0x80, key, 0]);
        }
        events.push([t, 0x99, if beat % 2 == 0 { 36 } else { 38 }, 110]);
        events.push([t + 100, 0x89, if beat % 2 == 0 { 36 } else { 38 }, 0]);
    }
    Song::from_data(&SongData {
        division: q,
        events,
        tempos: vec![(0, 120.0)],
        metronome: (0..8).map(|b| (b * q, b % 4 == 0)).collect(),
        tracks: vec![vec![0], vec![9]],
        end_tick: 8 * q,
    })
    .unwrap()
}

fn render(engine: &mut Engine, seconds: f32) -> (Vec<f32>, Vec<f32>) {
    let frames = (seconds * RATE) as usize;
    let (mut l, mut r) = (vec![0.0; frames], vec![0.0; frames]);
    engine.render(&mut l, &mut r);
    (l, r)
}

fn rms(s: &[f32]) -> f32 {
    (s.iter().map(|x| x * x).sum::<f32>() / s.len().max(1) as f32).sqrt()
}

fn heavy_chain() -> Vec<EffectSlot> {
    let slot = |effect| EffectSlot {
        enabled: true,
        effect,
    };
    vec![
        slot(EffectConfig::Gate(GateParams::default())),
        slot(EffectConfig::Compressor(CompressorParams::default())),
        slot(EffectConfig::Drive(DriveParams::default())),
        slot(EffectConfig::Eq {
            bands: graphic_bands(),
        }),
    ]
}

#[test]
fn sf3_and_sf2_versions_have_the_same_presets() {
    let sf3 = sonivox();
    let sf2_bytes = std::fs::read(soundfont_path("sonivox.sf2")).unwrap();
    let sf2 = parse_sound_font(&sf2_bytes).unwrap();
    assert_eq!(sf3.get_presets().len(), sf2.get_presets().len());
    assert!(sf3.get_presets().len() > 100);
}

#[test]
fn plays_a_song_through_effect_chains() {
    let mut engine = Engine::new(sonivox(), RATE);
    engine.load(Arc::new(song())).unwrap();
    assert!((engine.duration() - 4.0).abs() < 1e-9);
    let chain = Chain::build(&heavy_chain(), MAX_TRACK_EFFECTS, RATE, BLOCK, &NoAssets);
    assert!(chain.problems.is_empty());
    engine.set_track_chain(0, chain);
    engine.play();
    let (l, r) = render(&mut engine, 2.0);
    assert!(l.iter().chain(&r).all(|s| s.is_finite() && s.abs() <= 1.0));
    assert!(rms(&l) > 0.01, "silent: {}", rms(&l));
    assert!((engine.position() - 2.0).abs() < 0.01);
    let meters = engine.take_meters();
    assert!(meters.tracks.iter().all(|&p| p > 0.0), "{meters:?}");
}

#[test]
fn solo_and_mute_select_the_buses() {
    let level_with = |mixes: [BusMix; 2]| {
        let mut engine = Engine::new(sonivox(), RATE);
        engine.load(Arc::new(song())).unwrap();
        for (i, mix) in mixes.into_iter().enumerate() {
            engine.set_mix(i, mix);
        }
        engine.play();
        let (l, _) = render(&mut engine, 1.0);
        rms(&l)
    };
    let on = BusMix::default();
    let muted = BusMix { mute: true, ..on };
    let solo = BusMix { solo: true, ..on };
    assert_eq!(level_with([muted, muted]), 0.0);
    let both = level_with([on, on]);
    let guitar_solo = level_with([solo, on]);
    assert!(guitar_solo > 0.0 && guitar_solo < both);
}

#[test]
fn seeking_loops_and_stops_at_the_end() {
    let mut engine = Engine::new(sonivox(), RATE);
    engine.load(Arc::new(song())).unwrap();
    engine.set_loop(Some((1.0, 1.5)));
    engine.seek(1.0);
    engine.play();
    render(&mut engine, 2.0);
    assert!(
        engine.position() >= 1.0 && engine.position() < 1.5,
        "{}",
        engine.position()
    );
    engine.set_loop(None);
    engine.set_rate(2.0);
    engine.seek(3.5);
    render(&mut engine, 2.0);
    assert!(!engine.is_playing());
}

#[test]
fn renders_much_faster_than_real_time() {
    // A rough guard for the ADR's numbers: 8 tracks with the full chain must
    // render 4 s of audio in well under 4 s even in a debug build.
    let mut song = song();
    let mut tracks = Vec::new();
    for _ in 0..4 {
        tracks.push(vec![0]);
        tracks.push(vec![9]);
    }
    for (i, e) in song.events.iter_mut().enumerate() {
        e.track = (i % 8) as u16;
    }
    song.clicks.clear();
    song.track_channels = tracks;
    let mut engine = Engine::new(sonivox(), RATE);
    engine.load(Arc::new(song)).unwrap();
    for t in 0..8 {
        engine.set_track_chain(
            t,
            Chain::build(&heavy_chain(), MAX_TRACK_EFFECTS, RATE, BLOCK, &NoAssets),
        );
    }
    engine.play();
    let started = std::time::Instant::now();
    render(&mut engine, 4.0);
    let factor = started.elapsed().as_secs_f32() / 4.0;
    assert!(factor < 1.0, "real-time factor {factor}");
}

#[test]
fn renders_the_whole_song_offline() {
    let mut engine = Engine::new(sonivox(), RATE);
    engine.load(Arc::new(song())).unwrap();
    let bytes = smart_beat_lib::audio::render_offline(&mut engine, 48_000 * 60);
    let frames = bytes.len() / 8;
    // 4 s of music plus the release tail.
    assert!(
        frames as f32 >= 4.0 * RATE && (frames as f32) < 6.0 * RATE,
        "{frames}"
    );
    let samples: Vec<f32> = bytes
        .chunks(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    assert!(samples.iter().all(|s| s.is_finite()));
    assert!(rms(&samples) > 0.01);
}

#[test]
fn loop_points_come_from_ticks() {
    let song = song();
    assert!((song.seconds_at(960 * 2) - 1.0).abs() < 1e-9);
}

/// Every bundled preset (`src/lib/audio/presets.json`) loads, builds without
/// problems and turns a loud signal into finite, bounded, non-silent audio.
#[test]
fn every_bundled_preset_builds_and_sounds() {
    use smart_beat_lib::audio::chain::MAX_MASTER_EFFECTS;
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/lib/audio/presets.json");
    let data: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let presets = data["presets"].as_array().unwrap();
    assert!(presets.len() >= 10);
    let dir = tempfile::tempdir().unwrap();
    let library = Arc::new(smart_beat_lib::audio::library::Library::new(
        dir.path().to_path_buf(),
    ));
    for preset in presets {
        let id = preset["id"].as_str().unwrap();
        let slots: Vec<EffectSlot> =
            serde_json::from_value(preset["chain"].clone()).unwrap_or_else(|e| panic!("{id}: {e}"));
        let limit = if preset["target"] == "master" {
            MAX_MASTER_EFFECTS
        } else {
            MAX_TRACK_EFFECTS
        };
        assert!(slots.len() <= limit, "{id}: too many effects");
        let mut chain = Chain::build(&slots, limit, RATE, BLOCK, &library.assets(48_000));
        assert!(chain.problems.is_empty(), "{id}: {:?}", chain.problems);
        let mut out = Vec::new();
        for block in 0..1_500 {
            let mut l: Vec<f32> = (0..BLOCK)
                .map(|i| 0.8 * (((block * BLOCK + i) as f32) * 0.05).sin())
                .collect();
            let mut r = l.clone();
            chain.process(&mut l, &mut r);
            out.extend(l);
        }
        assert!(
            out.iter().all(|s| s.is_finite() && s.abs() < 16.0),
            "{id}: unbounded"
        );
        assert!(rms(&out[out.len() / 2..]) > 0.001, "{id}: silent");
    }
}
