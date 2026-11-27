//! MIDI lanes in the engine (ADR 0006): a lane's notes sound at their time through the song's
//! SoundFont, a pad bank plays samples, and live notes are heard on an armed lane while the
//! song is stopped.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use smart_beat_lib::audio::backing::{DecodedAudio, SyncMap};
use smart_beat_lib::audio::chain::{Chain, EffectSlot};
use smart_beat_lib::audio::engine::{BLOCK, Engine, POLYPHONY};
use smart_beat_lib::audio::lanes::midi::{LaneSound, LiveQueue, channel_for, live_queue};
use smart_beat_lib::audio::lanes::pads::{Pad, PadBank, PadSampler};
use smart_beat_lib::audio::lanes::{LaneInputs, PreparedLanes, prepare};
use smart_beat_lib::audio::parse_sound_font;
use smart_beat_lib::audio::song::{Song, SongData};
use smart_beat_lib::audio_lanes::{AudioClip, AudioLane, AudioLanes, AudioTake};
use smart_beat_lib::midi_lanes::{
    LaneInstrument, LaneKind, MidiClipData, MidiNote, MidiTake, PadSlot,
};

const RATE: f32 = 48_000.0;

fn sonivox() -> Arc<rustysynth::SoundFont> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf3");
    let bytes = std::fs::read(path).expect("run `pnpm install` first");
    Arc::new(parse_sound_font(&bytes).expect("SF3 converts"))
}

fn engine() -> Engine {
    let data = SongData {
        division: 960,
        events: vec![],
        tempos: vec![(0, 120.0)],
        metronome: vec![],
        tracks: vec![],
        end_tick: 960 * 8,
    };
    let mut engine = Engine::new(sonivox(), RATE);
    engine
        .load(Arc::new(Song::from_data(&data).unwrap()))
        .unwrap();
    engine
}

fn render(engine: &mut Engine, seconds: f32) -> Vec<f32> {
    let frames = (seconds * RATE) as usize;
    let (mut l, mut r) = (vec![0.0; frames], vec![0.0; frames]);
    engine.render(&mut l, &mut r);
    l
}

fn rms(s: &[f32]) -> f32 {
    (s.iter().map(|x| x * x).sum::<f32>() / s.len().max(1) as f32).sqrt()
}

fn at(s: &[f32], from: f32, to: f32) -> &[f32] {
    &s[(from * RATE) as usize..(to * RATE) as usize]
}

fn midi_lane(instrument: LaneInstrument, notes: Vec<MidiNote>) -> AudioLane {
    let json = r#"{"id":"midi","name":"Keys","enabled":true,"volume":1,"pan":0,"mute":false,
        "solo":false,"eq":{"lowDb":0,"midDb":0,"midHz":1000,"highDb":0},"semitones":0,"cents":0,
        "filter":"off"}"#;
    let mut lane: AudioLane = serde_json::from_str(json).unwrap();
    lane.kind = Some(LaneKind::Midi);
    lane.instrument = Some(instrument);
    let clip = r#"{"id":"c","takes":[{"name":"t","sourceId":"","offsetMs":0}],"startMs":0,
        "lengthMs":4000}"#;
    let mut clip: AudioClip = serde_json::from_str(clip).unwrap();
    clip.takes = vec![AudioTake {
        name: "t".into(),
        source_id: String::new(),
        offset_ms: 0.0,
    }];
    clip.midi = Some(MidiClipData {
        takes: vec![MidiTake { notes, cc: vec![] }],
    });
    lane.clips = vec![clip];
    lane
}

fn note(start_ms: f64, len_ms: f64, pitch: u8) -> MidiNote {
    MidiNote {
        id: format!("n{start_ms}"),
        start_ms,
        len_ms,
        pitch,
        vel: 110,
        chan: 0,
        raw_start_ms: None,
        raw_len_ms: None,
        muted: false,
    }
}

fn tone() -> Arc<DecodedAudio> {
    let wave: Vec<f32> = (0..RATE as usize)
        .map(|i| 0.5 * (std::f32::consts::TAU * 220.0 * i as f32 / RATE).sin())
        .collect();
    Arc::new(DecodedAudio {
        rate: RATE as u32,
        channels: 1,
        left: wave.clone(),
        right: wave,
    })
}

fn prepared(engine: &Engine, lane: AudioLane, live: &LiveQueue) -> PreparedLanes {
    let audio = AudioLanes {
        lanes: vec![lane],
        ..Default::default()
    };
    let synths = engine.synth_source();
    let sources = HashMap::new();
    let reversed = HashMap::new();
    let build = |_: Option<usize>, _: &[EffectSlot]| Chain::empty();
    let seconds_at = |t: f64| t;
    let sound = |lane: &AudioLane| -> Option<LaneSound> {
        match &lane.instrument {
            Some(LaneInstrument::Pads { pads }) => {
                let bank: Vec<Pad> = pads.iter().map(|p| Pad::new(p, tone(), RATE)).collect();
                Some(LaneSound::Pads(Box::new(PadBank::new(
                    PadSampler::new(bank, RATE),
                    None,
                    [None; 128],
                ))))
            }
            other => {
                let mut instrument = synths.instrument(POLYPHONY).ok()?;
                if let Some(LaneInstrument::Soundfont { program, .. }) = other {
                    instrument.midi(0, 0xc0, *program as i32, 0);
                }
                Some(LaneSound::Synth {
                    instrument,
                    channel: channel_for(other.as_ref()),
                })
            }
        }
    };
    let queue = live.clone();
    prepare(&LaneInputs {
        audio: &audio,
        sources: &sources,
        reversed: &reversed,
        transpose: 0,
        sync: SyncMap::new(vec![(0.0, 0.0)]),
        output_rate: RATE,
        max_block: BLOCK,
        build_chain: &build,
        seconds_at: &seconds_at,
        sound: &sound,
        live_queue: &move |_| queue.clone(),
    })
}

#[test]
fn a_midi_lane_sounds_its_notes_at_their_time_through_the_soundfont() {
    let mut engine = engine();
    let lane = midi_lane(
        LaneInstrument::Soundfont {
            program: 0,
            bank: 0,
        },
        vec![note(500.0, 500.0, 60)],
    );
    let prepared = prepared(&engine, lane, &live_queue());
    drop(engine.set_lanes(Some(prepared)));
    engine.play();
    let l = render(&mut engine, 1.6);
    assert!(rms(at(&l, 0.0, 0.45)) < 1e-4, "silent before the note");
    assert!(rms(at(&l, 0.55, 0.95)) > 0.005, "the piano note sounds");
    assert!(
        rms(at(&l, 1.4, 1.6)) < rms(at(&l, 0.55, 0.95)) * 0.3,
        "and ends"
    );
    let meters = engine.take_meters();
    assert_eq!(meters.lanes.len(), 1);
}

#[test]
fn a_pad_bank_plays_its_sample_and_live_notes_sound_on_an_armed_lane_while_stopped() {
    let mut engine = engine();
    let pad: PadSlot = serde_json::from_str(r#"{"key":36,"name":"Tone"}"#).unwrap();
    let lane = midi_lane(
        LaneInstrument::Pads { pads: vec![pad] },
        vec![note(200.0, 100.0, 36)],
    );
    let live = live_queue();
    let prepared = prepared(&engine, lane, &live);
    drop(engine.set_lanes(Some(prepared)));
    engine.play();
    let l = render(&mut engine, 0.6);
    assert!(rms(at(&l, 0.0, 0.19)) < 1e-4);
    assert!(
        rms(at(&l, 0.25, 0.5)) > 0.1,
        "a one-shot plays past the note's end"
    );
    engine.pause();
    render(&mut engine, 1.2);

    // Stopped and not armed: a live hit is not heard.
    live.push([0x90, 36, 127]).unwrap();
    let quiet = render(&mut engine, 0.2);
    assert!(
        rms(&quiet) < 1e-4,
        "an unarmed lane is silent while stopped"
    );
    render(&mut engine, 1.2);
    // Armed: it is.
    engine.set_live_midi(Some("midi".into()));
    live.push([0x90, 36, 127]).unwrap();
    let heard = render(&mut engine, 0.2);
    assert!(rms(&heard) > 0.1, "the armed lane plays live hits");
}
