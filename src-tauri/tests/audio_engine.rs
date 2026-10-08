//! Native audio engine against the real Sonivox SoundFont that ships with
//! alphaTab (installed by `pnpm install`): SF3 conversion, rendering a song
//! through effect chains, mixing and transport.

use std::path::PathBuf;
use std::sync::Arc;

use smart_beat_lib::audio::chain::{Chain, EffectConfig, EffectSlot, MAX_TRACK_EFFECTS, NoAssets};
use smart_beat_lib::audio::dsp::Effect;
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
fn reports_every_loop_played_to_the_end() {
    // The Speed Trainer speeds up after loops; the engine reports them (#83).
    let mut engine = Engine::new(sonivox(), RATE);
    engine.load(Arc::new(song())).unwrap();
    engine.set_loop(Some((1.0, 1.5)));
    engine.seek(1.0);
    engine.play();
    render(&mut engine, 1.2);
    assert_eq!(engine.take_loops(), 2);
    assert_eq!(engine.take_loops(), 0, "reported once");
}

#[test]
fn counts_in_before_every_loop_in_time() {
    // Two clicks a quarter second apart, then the loop again: half a second between loops.
    let mut engine = Engine::new(sonivox(), RATE);
    engine.load(Arc::new(song())).unwrap();
    engine.set_loop(Some((1.0, 1.5)));
    engine.set_loop_count_in(Some((2, 0.25)));
    engine.seek(1.0);
    engine.play();
    render(&mut engine, 0.75);
    // The loop ended at 0.5 s: the count-in clicks, the song waits at the loop's start.
    assert_eq!(engine.take_loops(), 1);
    assert!(engine.is_active() && !engine.is_playing());
    assert!(
        (engine.position() - 1.0).abs() < 1e-9,
        "{}",
        engine.position()
    );
    render(&mut engine, 0.45);
    // 0.5 s of count-in, then 0.2 s of the loop.
    assert!(engine.is_playing());
    assert!(
        (engine.position() - 1.2).abs() < 0.01,
        "{}",
        engine.position()
    );
    // With the count-in off again, the next loop follows straight away.
    engine.set_loop_count_in(None);
    render(&mut engine, 1.0);
    assert!(engine.is_playing(), "no count-in once it is off");
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
        // Mastering presets end in a limiter (#42): nothing gets past its ceiling.
        if let Some(ceiling) = slots.last().and_then(|s| match &s.effect {
            EffectConfig::Limiter(p) => Some(p.ceiling_db),
            _ => None,
        }) {
            let ceiling = 10f32.powf(ceiling / 20.0);
            let peak = out.iter().fold(0.0f32, |a, s| a.max(s.abs()));
            assert!(peak <= ceiling + 1e-5, "{id}: peak {peak} over {ceiling}");
        }
    }
}

#[test]
fn previews_a_drum_without_playing_the_song() {
    let mut engine = Engine::new(sonivox(), RATE);
    engine.preview(9, 38, 110).unwrap();
    let (l, _) = render(&mut engine, 0.3);
    assert!(rms(&l) > 0.001, "silent preview");
    assert!(!engine.is_playing());
}

#[test]
fn previews_a_string_with_its_instrument_and_stops_it() {
    // The low E of a guitar, with a nylon guitar (GM 25), as the tuner's reference note (#83).
    let mut engine = Engine::new(sonivox(), RATE);
    engine.preview_with(0, 24, 40, 100).unwrap();
    let (sounding, _) = render(&mut engine, 0.3);
    assert!(rms(&sounding) > 0.001, "silent reference note");
    assert!(!engine.is_playing());
    engine.preview_stop(0);
    // Released notes fade out: well after the release, nothing is left.
    let _ = render(&mut engine, 2.0);
    let (after, _) = render(&mut engine, 0.3);
    assert!(
        rms(&after) < rms(&sounding) / 10.0,
        "the note keeps ringing"
    );
}

fn playing_engine(setup: impl FnOnce(&mut Engine)) -> Engine {
    let mut engine = Engine::new(sonivox(), RATE);
    engine.load(Arc::new(song())).unwrap();
    setup(&mut engine);
    engine.play();
    engine
}

fn chain_of(effects: Vec<EffectConfig>) -> Chain {
    let slots: Vec<EffectSlot> = effects
        .into_iter()
        .map(|effect| EffectSlot {
            enabled: true,
            effect,
        })
        .collect();
    Chain::build(&slots, MAX_TRACK_EFFECTS, RATE, BLOCK, &NoAssets)
}

/// A chain that mostly changes the level (a clean boost with an output level).
fn gain_chain(db: f32) -> Chain {
    use smart_beat_lib::audio::dsp::drive::DriveMode;
    chain_of(vec![EffectConfig::Drive(DriveParams {
        mode: DriveMode::Boost,
        drive: 0.0,
        tone: 1.0,
        level_db: db,
        tight_hz: 20.0,
    })])
}

fn solo_guitar() -> [BusMix; 2] {
    [
        BusMix::default(),
        BusMix {
            mute: true,
            ..Default::default()
        },
    ]
}

#[test]
fn automation_switches_the_sound_at_a_bar() {
    let mut engine = playing_engine(|e| {
        for (i, mix) in solo_guitar().into_iter().enumerate() {
            e.set_mix(i, mix);
        }
        e.set_sound_chain(0, 0, gain_chain(0.0));
        e.set_sound_chain(0, 1, gain_chain(-18.0));
        // Bar 2 starts at 2 s.
        e.set_sound_switches(0, vec![(2.0, 1)]);
    });
    let (first, _) = render(&mut engine, 2.0);
    let (second, _) = render(&mut engine, 2.0);
    let ratio = rms(&second) / rms(&first);
    assert!(ratio < 0.3, "the quieter sound did not take over: {ratio}");
    // Seeking back plays the first sound again at once.
    engine.seek(0.5);
    let (again, _) = render(&mut engine, 1.0);
    assert!(rms(&again) > rms(&second) * 3.0);
    // Dropping the extra sound falls back to the first.
    assert_eq!(engine.set_sound_count(0, 1).len(), 1);
    engine.seek(2.5);
    let (back, _) = render(&mut engine, 1.0);
    assert!(rms(&back) > rms(&second) * 3.0);
}

#[test]
fn knob_turns_update_a_running_chain() {
    use smart_beat_lib::audio::dsp::delay::DelayParams;
    let delay = |time_ms| {
        vec![EffectSlot {
            enabled: true,
            effect: EffectConfig::Delay(DelayParams {
                time_ms,
                ..Default::default()
            }),
        }]
    };
    let mut engine = playing_engine(|e| {
        e.set_track_chain(
            0,
            Chain::build(&delay(300.0), MAX_TRACK_EFFECTS, RATE, BLOCK, &NoAssets),
        );
    });
    render(&mut engine, 0.2);
    assert!(engine.update_sound_chain(Some(0), 0, &delay(120.0), MAX_TRACK_EFFECTS));
    // Adding a block is not a knob turn.
    let mut longer = delay(120.0);
    longer.extend(delay(50.0));
    assert!(!engine.update_sound_chain(Some(0), 0, &longer, MAX_TRACK_EFFECTS));
    let (l, _) = render(&mut engine, 0.5);
    assert!(l.iter().all(|s| s.is_finite()));
}

#[test]
fn volume_and_mute_automation_follow_the_timeline() {
    use smart_beat_lib::audio::mixing::{Automation, AutomationData};
    let data = AutomationData {
        enabled: true,
        volume: vec![(0, 1.0), (1920, 1.0), (1921, 0.05)],
        pan: vec![],
        mute: vec![(0, 0.0), (3840, 1.0)],
    };
    let song = song();
    let mut engine = playing_engine(|e| {
        for (i, mix) in solo_guitar().into_iter().enumerate() {
            e.set_mix(i, mix);
        }
        e.set_automation(0, Automation::from_ticks(&data, |t| song.seconds_at(t)));
    });
    let (loud, _) = render(&mut engine, 1.0);
    render(&mut engine, 0.1);
    let (quiet, _) = render(&mut engine, 0.8);
    assert!(
        rms(&quiet) < rms(&loud) * 0.15,
        "{} vs {}",
        rms(&quiet),
        rms(&loud)
    );
    // Muted from 2 s (tick 3840) on: only the gain ramp's first block leaks.
    engine.seek(2.2);
    let (muted, _) = render(&mut engine, 0.5);
    assert_eq!(rms(&muted), 0.0);
}

#[test]
fn pan_eq_trim_and_master_pan() {
    use smart_beat_lib::audio::mixing::TrackEq;
    let level = |setup: &dyn Fn(&mut Engine)| {
        let mut engine = playing_engine(|e| {
            for (i, mix) in solo_guitar().into_iter().enumerate() {
                e.set_mix(i, mix);
            }
            setup(e);
        });
        let (l, r) = render(&mut engine, 1.0);
        (rms(&l), rms(&r))
    };
    let (centre_l, centre_r) = level(&|_| {});
    assert!((centre_l - centre_r).abs() < centre_l * 0.2);
    // Hard left: the right side is silent.
    let (_, right) = level(&|e| {
        e.set_mix(
            0,
            BusMix {
                pan: -1.0,
                ..Default::default()
            },
        )
    });
    assert!(right < 1e-4, "{right}");
    let (_, right) = level(&|e| e.set_master_pan(-1.0));
    assert!(right < 1e-4, "{right}");
    // Focus: trimming a track by -12 dB.
    let (trimmed, _) = level(&|e| {
        e.set_mix(
            0,
            BusMix {
                trim_db: -12.0,
                ..Default::default()
            },
        )
    });
    assert!(
        (trimmed / centre_l - 0.25).abs() < 0.05,
        "{}",
        trimmed / centre_l
    );
    // A deep cut on every band of the channel EQ.
    let (cut, _) = level(&|e| {
        e.set_track_eq(
            0,
            &TrackEq {
                graphic: vec![-15.0; 10],
                ..Default::default()
            },
        )
    });
    assert!(cut < centre_l * 0.3, "{cut} vs {centre_l}");
}

#[test]
fn drum_elements_have_their_own_mix_and_meters() {
    // Kick (36) and snare (38) on separate elements.
    let groups = vec![vec![35, 36], vec![38, 40]];
    let drums_only = [
        BusMix {
            mute: true,
            ..Default::default()
        },
        BusMix::default(),
    ];
    let run = |mixes: [BusMix; 3], stereo: bool| {
        let mut engine = playing_engine(|e| {
            for (i, mix) in drums_only.into_iter().enumerate() {
                e.set_mix(i, mix);
            }
            let split = e.synth_source().drum_split(&groups).unwrap();
            assert!(e.set_drum_split(1, Some(split)).is_none());
            e.set_drum_mix(1, &mixes, stereo);
        });
        let (l, r) = render(&mut engine, 2.0);
        (l, r, engine.take_meters())
    };
    let on = BusMix::default();
    let (both, _, meters) = run([on, on, on], true);
    assert_eq!(meters.drums[1].len(), 3, "kick, snare and other");
    assert!(meters.drums[1][0] > 0.0 && meters.drums[1][1] > 0.0);
    assert_eq!(meters.drums[1][2], 0.0, "nothing else was played");
    assert!(meters.drums[0].is_empty());
    let (no_snare, _, meters) = run([on, BusMix { mute: true, ..on }, on], true);
    assert_eq!(meters.drums[1][1], 0.0);
    assert!(rms(&no_snare) < rms(&both));
    let (kick_solo, _, meters) = run([BusMix { solo: true, ..on }, on, on], true);
    assert_eq!(meters.drums[1][1], 0.0);
    assert!(rms(&kick_solo) > 0.0);
    // Mono: both sides are the same even with a panned snare.
    let (l, r, _) = run([on, BusMix { pan: 1.0, ..on }, on], false);
    assert!(l.iter().zip(&r).all(|(a, b)| (a - b).abs() < 1e-6));
}

#[test]
fn the_audio_track_follows_sync_points_and_solo() {
    use smart_beat_lib::audio::backing::{Backing, BackingParams, DecodedAudio, SyncMap};
    let rate = 44_100u32;
    let tone: Vec<f32> = (0..rate as usize * 6)
        .map(|i| 0.5 * (std::f32::consts::TAU * 330.0 * i as f32 / rate as f32).sin())
        .collect();
    let audio = Arc::new(DecodedAudio {
        rate,
        channels: 1,
        left: tone.clone(),
        right: tone,
    });
    let backing = |solo| {
        let mut b = Backing::new(audio.clone(), RATE, BLOCK);
        b.set(
            BackingParams {
                solo,
                ..Default::default()
            },
            SyncMap::new(vec![(0.0, 0.5)]),
        );
        b
    };
    let mut engine = playing_engine(|e| {
        e.set_backing(Some(backing(true)));
    });
    let (l, _) = render(&mut engine, 1.0);
    // Solo on the audio track silences the score, so only the 330 Hz tone is left.
    let crossings = l[4_800..]
        .windows(2)
        .filter(|w| w[0] <= 0.0 && w[1] > 0.0)
        .count();
    let freq = crossings as f32 * RATE / (l.len() - 4_800) as f32;
    assert!((freq - 330.0).abs() < 5.0, "{freq} Hz");
    assert!(engine.take_meters().backing > 0.3);
    // Paused: the audio track stops too.
    engine.pause();
    let (paused, _) = render(&mut engine, 0.2);
    assert!(rms(&paused) < 1e-4);
    // Offline renders include it.
    let mut offline = playing_engine(|e| {
        e.set_backing(Some(backing(false)));
    });
    let bytes = smart_beat_lib::audio::render_offline(&mut offline, 48_000 * 60);
    assert!(bytes.len() / 8 > 4 * 48_000);
    // Sync map: song second 1 is recording second 1.5.
    let map = SyncMap::new(vec![(0.0, 0.5)]);
    assert_eq!(map.audio_at(1.0), 1.5);
    let _ = BackingParams::default();
}

/// The mastering chain (#39): EQ, compressor and limiter keep the song under
/// the ceiling, and the meters show the compressor and limiter working.
#[test]
fn mastering_chain_limits_the_song_and_meters_the_reduction() {
    use smart_beat_lib::audio::dsp::limiter::LimiterParams;
    let mut engine = playing_engine(|engine| {
        engine.set_master_volume(1.0);
        engine.set_master_chain(chain_of(vec![
            EffectConfig::Eq {
                bands: graphic_bands(),
            },
            EffectConfig::Compressor(CompressorParams {
                threshold_db: -30.0,
                ratio: 4.0,
                makeup_db: 12.0,
                ..Default::default()
            }),
            EffectConfig::Limiter(LimiterParams {
                ceiling_db: -3.0,
                input_db: 12.0,
                ..Default::default()
            }),
        ]));
    });
    let (l, r) = render(&mut engine, 2.0);
    let ceiling = 10f32.powf(-3.0 / 20.0);
    let peak = l.iter().chain(&r).fold(0.0f32, |a, s| a.max(s.abs()));
    assert!(l.iter().chain(&r).all(|s| s.is_finite()));
    assert!(peak <= ceiling + 1e-4, "peak {peak}");
    assert!(rms(&l) > 0.05, "loud, not silent");
    let meters = engine.take_meters();
    assert_eq!(meters.reduction.master.len(), 3);
    assert!(
        meters.reduction.master[1] > 1.0,
        "compressor: {:?}",
        meters.reduction.master
    );
    assert!(
        meters.reduction.master[2] > 0.1,
        "limiter: {:?}",
        meters.reduction.master
    );
    assert_eq!(meters.reduction.tracks.len(), 2);
    // Read once: the next read starts from zero.
    assert!(
        engine
            .take_meters()
            .reduction
            .master
            .iter()
            .all(|&m| m == 0.0)
    );
}

/// Every compressor and limiter preset of the pedals (#39) builds and keeps the
/// audio finite and bounded.
#[test]
fn every_dynamics_preset_builds_and_sounds() {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/lib/audio/dynamics-presets.json");
    let data: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    for preset in data["presets"].as_array().unwrap() {
        let id = preset["id"].as_str().unwrap();
        let mut slot = preset["params"].clone();
        slot["type"] = preset["type"].clone();
        slot["enabled"] = true.into();
        let slot: EffectSlot = serde_json::from_value(slot).unwrap_or_else(|e| panic!("{id}: {e}"));
        let mut chain = Chain::build(&[slot], MAX_TRACK_EFFECTS, RATE, BLOCK, &NoAssets);
        assert!(chain.problems.is_empty() && !chain.is_empty(), "{id}");
        let mut out = Vec::new();
        for block in 0..400 {
            let mut l: Vec<f32> = (0..BLOCK)
                .map(|i| 0.9 * (((block * BLOCK + i) as f32) * 0.03).sin())
                .collect();
            let mut r = l.clone();
            chain.process(&mut l, &mut r);
            out.extend(l);
        }
        assert!(
            out.iter().all(|s| s.is_finite() && s.abs() < 8.0),
            "{id}: unbounded"
        );
        assert!(rms(&out[out.len() / 2..]) > 0.01, "{id}: silent");
        if preset["type"] == "limiter" {
            let ceiling = 10f32.powf(preset["params"]["ceilingDb"].as_f64().unwrap() as f32 / 20.0);
            assert!(
                out.iter().all(|s| s.abs() <= ceiling + 1e-5),
                "{id}: over the ceiling"
            );
        }
    }
}

#[test]
fn count_in_clicks_then_starts_the_song_on_time() {
    let mut engine = Engine::new(sonivox(), RATE);
    engine.load(Arc::new(song())).unwrap();
    engine.set_metronome_volume(0.0);
    engine.start_count_in(2, 0.25);
    assert!(engine.is_active());
    assert!(!engine.is_playing());

    // The clicks are heard although the metronome is off, and the song waits.
    let (l, _) = render(&mut engine, 0.4);
    assert!(l.iter().any(|v| v.abs() > 0.01));
    assert_eq!(engine.position(), 0.0);

    // Two beats of 0.25 s: the song starts at 0.5 s (within one block).
    render(&mut engine, 0.2);
    assert!(engine.is_playing());
    let position = engine.position();
    assert!((0.09..0.11).contains(&position), "position {position}");
}

#[test]
fn pausing_or_seeking_cancels_the_count_in() {
    let mut engine = Engine::new(sonivox(), RATE);
    engine.load(Arc::new(song())).unwrap();
    engine.start_count_in(4, 0.5);
    engine.pause();
    assert!(!engine.is_active());
    engine.start_count_in(4, 0.5);
    engine.seek(1.0);
    assert!(!engine.is_active());
}

/// An effect that crashes, like a broken capture or a bug in a block would.
struct Crashes;

impl Effect for Crashes {
    fn process(&mut self, _: &mut [f32], _: &mut [f32]) {
        panic!("test: this block always crashes");
    }
    fn reset(&mut self) {}
}

/// A crash inside a block must not take the audio thread (or the engine lock)
/// with it: that buffer is silent, playback stops, every chain is switched
/// off, and the engine can play again straight away (#41).
#[test]
fn a_crashing_block_is_caught_and_the_engine_recovers() {
    let mut engine = playing_engine(|e| {
        e.set_track_chain(0, Chain::from_effects(vec![Box::new(Crashes)]));
    });
    let (mut l, mut r) = (vec![0.5; 512], vec![0.5; 512]);
    assert!(
        !engine.render_guarded(&mut l, &mut r),
        "the crash is reported"
    );
    assert!(l.iter().chain(&r).all(|s| *s == 0.0), "silent buffer");
    assert!(!engine.is_playing(), "playback stopped");
    // The same engine, the same song: now without the broken block.
    engine.seek(0.0);
    engine.play();
    let (mut l, mut r) = (vec![0.0; 24_000], vec![0.0; 24_000]);
    assert!(
        engine.render_guarded(&mut l, &mut r),
        "no crash the second time"
    );
    assert!(l.iter().all(|s| s.is_finite()));
    assert!(rms(&l) > 0.001, "the song is audible again");
}

/// Eight, nine and ten string guitars reach very low pitches: the engine must
/// sound on every key a tuning can ask for (F#1 and lower), not just on the
/// usual guitar range (#43).
#[test]
fn very_low_notes_still_sound_and_stay_finite() {
    let q = 960;
    for key in [30u32, 28, 25, 20, 18] {
        let mut events = vec![[0, 0xC0, 30, 0]];
        events.push([0, 0x90, key, 110]);
        events.push([q * 2, 0x80, key, 0]);
        let song = Song::from_data(&SongData {
            division: q,
            events,
            tempos: vec![(0, 120.0)],
            metronome: vec![],
            tracks: vec![vec![0]],
            end_tick: q * 4,
        })
        .unwrap();
        let mut engine = Engine::new(sonivox(), RATE);
        engine.load(Arc::new(song)).unwrap();
        engine.play();
        let (l, r) = render(&mut engine, 1.0);
        assert!(l.iter().chain(&r).all(|s| s.is_finite()), "key {key}");
        assert!(rms(&l) > 0.0005, "key {key} is silent (rms {})", rms(&l));
    }
}
