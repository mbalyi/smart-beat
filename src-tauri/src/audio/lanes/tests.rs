use std::collections::HashMap;
use std::sync::Arc;

use super::voice::reversed;
use super::*;
use crate::audio::backing::{BackingParams, DecodedAudio, SyncMap};
use crate::audio::chain::{Chain, EffectConfig};
use crate::audio::dsp::delay::DelayParams;
use crate::audio_lanes::{
    AudioBus, AudioClip, AudioLane, AudioLanes, AudioSource, AudioTake, AutomationValue, ClipFade,
    EffectAutomation, FadeShape, LaneSend,
};

const RATE: f32 = 48_000.0;
const BLOCK: usize = 512;
const ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/// A source whose sample `i` is a slow ramp, so positions can be read back from the output.
fn ramp_audio(seconds: f64) -> DecodedAudio {
    let frames = (seconds * RATE as f64) as usize;
    let left: Vec<f32> = (0..frames)
        .map(|i| (i as f32 / frames as f32) * 0.5 + 0.1)
        .collect();
    DecodedAudio {
        rate: RATE as u32,
        channels: 2,
        right: left.clone(),
        left,
    }
}

fn tone(seconds: f64) -> DecodedAudio {
    let frames = (seconds * RATE as f64) as usize;
    let left: Vec<f32> = (0..frames)
        .map(|i| (0.4 * (2.0 * std::f64::consts::PI * 440.0 * i as f64 / RATE as f64).sin()) as f32)
        .collect();
    DecodedAudio {
        rate: RATE as u32,
        channels: 2,
        right: left.clone(),
        left,
    }
}

fn clip(id: &str, start_ms: f64, offset_ms: f64, length_ms: f64) -> AudioClip {
    AudioClip {
        id: id.into(),
        takes: vec![AudioTake {
            name: "a".into(),
            source_id: ID.into(),
            offset_ms,
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
    }
}

fn lane(id: &str, clips: Vec<AudioClip>) -> AudioLane {
    AudioLane {
        id: id.into(),
        name: id.into(),
        color: None,
        params: BackingParams {
            volume: 1.0,
            ..Default::default()
        },
        follow_transposition: true,
        effects: vec![],
        auto_bypass: false,
        automation: vec![],
        sends: vec![],
        parent: None,
        folder: false,
        collapsed: false,
        group: 0,
        clips,
    }
}

fn song(lanes: Vec<AudioLane>) -> AudioLanes {
    AudioLanes {
        lanes,
        sources: vec![AudioSource {
            id: ID.into(),
            name: "a.wav".into(),
            ext: "wav".into(),
            path: None,
            embedded: true,
            legacy_entry: None,
        }],
        ..Default::default()
    }
}

/// Renders `seconds` of the song at unity speed; returns the left channel.
fn render(audio: &AudioLanes, source: DecodedAudio, seconds: f64) -> Vec<f32> {
    let source = Arc::new(source);
    let sources = HashMap::from([(ID.to_string(), source.clone())]);
    let reversed = HashMap::from([(ID.to_string(), Arc::new(reversed(&source)))]);
    let build = |_: Option<usize>, _: &[EffectSlot]| Chain::empty();
    let seconds_at = |tick: f64| tick / 960.0 * 0.5;
    let inputs = LaneInputs {
        audio,
        sources: &sources,
        reversed: &reversed,
        transpose: 0,
        sync: SyncMap::default(),
        output_rate: RATE,
        max_block: BLOCK,
        build_chain: &build,
        seconds_at: &seconds_at,
    };
    let mut mixer = LaneMixer::new(prepare(&inputs), RATE);
    let total = (seconds * RATE as f64) as usize;
    let mut out = Vec::with_capacity(total);
    let (mut l, mut r) = (vec![0.0; BLOCK], vec![0.0; BLOCK]);
    let mut pos = 0;
    while pos < total {
        l.fill(0.0);
        r.fill(0.0);
        mixer.render(
            pos as f64 / RATE as f64,
            1.0,
            true,
            true,
            false,
            (&mut l, &mut r),
        );
        out.extend_from_slice(&l);
        pos += BLOCK;
    }
    out.truncate(total);
    out
}

#[test]
fn a_clip_plays_its_source_range_at_its_place_on_the_timeline() {
    // Starts 0.25 s into the song, plays the source from 0.5 s.
    let out = render(
        &song(vec![lane("a", vec![clip("c", 250.0, 500.0, 1_000.0)])]),
        ramp_audio(4.0),
        2.0,
    );
    let source = ramp_audio(4.0);
    assert!(
        out[..11_000].iter().all(|s| *s == 0.0),
        "silent before the clip"
    );
    for i in [13_000usize, 30_000, 50_000] {
        let expected = source.left[i - 12_000 + 24_000];
        assert!(
            (out[i] - expected).abs() < 1e-3,
            "sample {i}: {} vs {expected}",
            out[i]
        );
    }
    assert!(
        out[61_000..].iter().all(|s| *s == 0.0),
        "silent after the clip"
    );
}

#[test]
fn pieces_that_touch_play_seamlessly_like_the_whole_clip() {
    let whole = song(vec![lane("a", vec![clip("c", 0.0, 0.0, 2_000.0)])]);
    let glued = song(vec![lane(
        "a",
        vec![
            clip("l", 0.0, 0.0, 1_000.0),
            clip("r", 1_000.0, 1_000.0, 1_000.0),
        ],
    )]);
    let a = render(&whole, tone(3.0), 2.0);
    let b = render(&glued, tone(3.0), 2.0);
    // The second piece's stretcher starts fresh at the cut; primed, it joins with no dip.
    let worst = a
        .iter()
        .zip(&b)
        .fold(0.0f32, |m, (x, y)| m.max((x - y).abs()));
    assert!(worst < 1e-4, "largest difference {worst}");
}

#[test]
fn fades_start_and_end_silent() {
    let mut c = clip("c", 0.0, 0.0, 1_000.0);
    c.fade_in = ClipFade {
        ms: 100.0,
        shape: FadeShape::EqualPower,
    };
    c.fade_out = ClipFade {
        ms: 100.0,
        shape: FadeShape::Linear,
    };
    let out = render(&song(vec![lane("a", vec![c])]), tone(2.0), 1.0);
    let peak = |r: std::ops::Range<usize>| out[r].iter().fold(0.0f32, |m, s| m.max(s.abs()));
    assert!(peak(0..200) < 0.05);
    assert!(peak(20_000..24_000) > 0.35);
    assert!(peak(47_800..48_000) < 0.05);
}

#[test]
fn mute_solo_and_folders() {
    let quiet = |mut l: AudioLane, f: fn(&mut AudioLane)| {
        f(&mut l);
        l
    };
    let base = || lane("a", vec![clip("c", 0.0, 0.0, 1_000.0)]);
    let peak = |audio: &AudioLanes| {
        render(audio, tone(2.0), 0.5)
            .iter()
            .fold(0.0f32, |m, s| m.max(s.abs()))
    };
    assert!(peak(&song(vec![base()])) > 0.3);
    assert_eq!(
        peak(&song(vec![quiet(base(), |l| l.params.mute = true)])),
        0.0
    );
    // Another lane soloed silences this one.
    let other = quiet(lane("b", vec![]), |l| l.params.solo = true);
    assert_eq!(peak(&song(vec![base(), other])), 0.0);
    // A muted folder mutes its children.
    let folder = quiet(lane("f", vec![]), |l| {
        l.folder = true;
        l.params.mute = true;
    });
    let child = quiet(base(), |l| l.parent = Some("f".into()));
    assert_eq!(peak(&song(vec![folder, child])), 0.0);
}

#[test]
fn sends_reach_their_bus() {
    let mut l = lane("a", vec![clip("c", 0.0, 0.0, 1_000.0)]);
    l.params.volume = 1.0;
    l.sends = vec![LaneSend {
        bus: "rev".into(),
        level: 1.0,
    }];
    let mut audio = song(vec![l]);
    audio.buses = vec![AudioBus {
        id: "rev".into(),
        name: "Reverb".into(),
        volume: 1.0,
        mute: false,
        effects: vec![],
    }];
    let with_send = render(&audio, tone(2.0), 0.5);
    audio.lanes[0].sends.clear();
    let without = render(&audio, tone(2.0), 0.5);
    let peak = |v: &[f32]| v.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    assert!(
        peak(&with_send) > peak(&without) * 1.5,
        "the bus adds the sent signal"
    );
}

#[test]
fn a_reversed_clip_reads_its_range_backwards() {
    let mut c = clip("c", 0.0, 500.0, 1_000.0);
    c.reversed = true;
    let source = Arc::new(ramp_audio(4.0));
    let plan = voice::ClipPlan::from_clip(&c, 0, 0);
    let rev = Arc::new(reversed(&source));
    let v = voice::ClipVoice::new(plan, rev.clone(), RATE, BLOCK);
    // At the clip start the reversed file is read where the original range ends (1.5 s).
    let at = v.source_at(0.0);
    let original = source.duration() - at;
    assert!((original - 1.5).abs() < 1e-9, "{original}");
}

#[test]
fn stretch_markers_map_clip_time_to_source_time() {
    let mut c = clip("c", 0.0, 0.0, 2_000.0);
    c.stretch = vec![crate::audio_lanes::StretchMarker {
        source_ms: 1_500.0,
        clip_ms: 1_000.0,
    }];
    let plan = voice::ClipPlan::from_clip(&c, 0, 0);
    assert!((plan.source_into(1.0) - 1.5).abs() < 1e-9);
    assert!((plan.source_into(0.5) - 0.75).abs() < 1e-9);
    assert!((plan.source_into(2.0) - 2.0).abs() < 1e-9);
}

#[test]
fn effect_automation_sets_a_parameter_along_the_song() {
    let delay = EffectSlot {
        enabled: true,
        effect: EffectConfig::Delay(DelayParams {
            time_ms: 300.0,
            feedback: 0.3,
            mix: 0.2,
            high_cut_hz: 6_000.0,
            ping_pong: false,
        }),
    };
    let automation = vec![EffectAutomation {
        slot: 0,
        param: "mix".into(),
        points: vec![
            AutomationValue {
                tick: 0.0,
                value: 0.0,
            },
            AutomationValue {
                tick: 960.0,
                value: 1.0,
            },
        ],
    }];
    let frames = AutomationFrames::build(std::slice::from_ref(&delay), &automation, &|t| t / 960.0);
    let mix_at = |s: f64| match &frames.at(s).unwrap().1[0].effect {
        EffectConfig::Delay(p) => p.mix,
        _ => unreachable!(),
    };
    assert_eq!(mix_at(0.0), 0.0);
    assert!((mix_at(0.5) - 0.5).abs() < 1e-6);
    assert_eq!(mix_at(2.0), 1.0);
}
