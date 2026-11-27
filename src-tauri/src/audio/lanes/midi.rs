//! MIDI lanes in the engine (ADR 0006): a lane's clips become one sorted list of events on the
//! audio timeline, played sample-accurately into the lane's instrument ahead of its filter, EQ,
//! effect chain, fader and sends. Live notes (an armed lane, the on-screen pads, a connected
//! device) come through a lock-free queue and sound whether or not the song plays.

use std::sync::Arc;

use crossbeam_queue::ArrayQueue;

use crate::audio::engine::Instrument;
use crate::audio::lanes::pads::PadBank;
use crate::audio_lanes::AudioLane;
use crate::midi_lanes::{LaneInstrument, MidiCcKind};

/// How many live messages wait at most (a burst of pad hits fits easily).
pub const LIVE_QUEUE: usize = 1_024;
/// A jump of the timeline larger than this (seconds) is a seek, not playback.
const SEEK_GAP_S: f64 = 0.1;
/// Notes shorter than this after the play position are not restarted by a seek.
const CHASE_MIN_S: f64 = 0.03;

/// Live MIDI messages for one lane (status, data 1, data 2).
pub type LiveQueue = Arc<ArrayQueue<[u8; 3]>>;

/// A new, empty live queue.
pub fn live_queue() -> LiveQueue {
    Arc::new(ArrayQueue::new(LIVE_QUEUE))
}

/// One MIDI message at a point of the audio timeline (seconds).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MidiEvent {
    pub at: f64,
    pub status: u8,
    pub d1: u8,
    pub d2: u8,
}

/// A note as it sounds (for restarting held notes after a seek).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Span {
    start: f64,
    end: f64,
    status: u8,
    key: u8,
    vel: u8,
}

/// What a MIDI lane sounds with.
pub enum LaneSound {
    /// A SoundFont synth, an imported kit or a plugin instrument. `channel` overrides the
    /// events' channel (a General MIDI program plays on 0, a drum kit on 9).
    Synth {
        instrument: Box<dyn Instrument>,
        channel: Option<u8>,
    },
    Pads(Box<PadBank>),
}

impl LaneSound {
    fn send(&mut self, status: u8, d1: u8, d2: u8) {
        let command = status & 0xf0;
        match self {
            LaneSound::Synth {
                instrument,
                channel,
            } => {
                let chan = channel.unwrap_or(status & 0x0f);
                instrument.midi(chan as i32, command as i32, d1 as i32, d2 as i32);
            }
            LaneSound::Pads(pads) => match command {
                0x90 => pads.note_on(d1, d2),
                0x80 => pads.note_off(d1),
                0xb0 if d1 == 120 => pads.all_off(true),
                0xb0 if d1 == 123 => pads.all_off(false),
                _ => {}
            },
        }
    }

    /// Every note stops (`immediate`: without a release).
    pub fn all_off(&mut self, immediate: bool) {
        match self {
            LaneSound::Synth { instrument, .. } => instrument.note_off_all(immediate),
            LaneSound::Pads(pads) => pads.all_off(immediate),
        }
    }

    fn chases(&self) -> bool {
        // A drum hit is not restarted halfway; held synth notes are.
        matches!(self, LaneSound::Synth { channel, .. } if *channel != Some(9))
    }
}

/// Which instrument settings a running sound was built from (an unchanged one is kept).
pub fn sound_key(lane: &AudioLane) -> String {
    serde_json::to_string(&lane.instrument).unwrap_or_default()
}

/// The channel a lane's instrument plays its events on (none: each event's own).
pub fn channel_for(instrument: Option<&LaneInstrument>) -> Option<u8> {
    match instrument {
        None | Some(LaneInstrument::Soundfont { .. }) => Some(0),
        Some(LaneInstrument::Drums | LaneInstrument::Kit { .. }) => Some(9),
        Some(LaneInstrument::Pads { .. }) | Some(LaneInstrument::Plugin { .. }) => None,
    }
}

/// Whether a lane's notes follow pitch changes (not for drums and pads).
pub fn transposes(instrument: Option<&LaneInstrument>) -> bool {
    matches!(
        instrument,
        None | Some(LaneInstrument::Soundfont { .. }) | Some(LaneInstrument::Plugin { .. })
    )
}

/// The events of a lane's clips on the audio timeline, sorted (note-offs before controllers
/// before note-ons at the same time), and the notes as spans.
fn schedule(lane: &AudioLane, semitones: i32) -> (Vec<MidiEvent>, Vec<Span>) {
    let mut events = Vec::new();
    let mut spans = Vec::new();
    let shift = |pitch: u8| (pitch as i32 + semitones).clamp(0, 127) as u8;
    for clip in lane.clips.iter().filter(|c| !c.mute) {
        let Some(midi) = &clip.midi else { continue };
        let Some(take) = midi.takes.get(clip.take).or(midi.takes.first()) else {
            continue;
        };
        let start = clip.start_ms / 1_000.0;
        let end = start + clip.length_ms / 1_000.0;
        let clip_shift = clip.semitones;
        for note in take.notes.iter().filter(|n| !n.muted) {
            let on = start + note.start_ms / 1_000.0;
            if on >= end {
                continue;
            }
            let off = (on + note.len_ms.max(1.0) / 1_000.0).min(end);
            let key = shift((note.pitch as i32 + clip_shift).clamp(0, 127) as u8);
            let chan = note.chan & 0x0f;
            events.push(MidiEvent {
                at: on,
                status: 0x90 | chan,
                d1: key,
                d2: note.vel.max(1),
            });
            events.push(MidiEvent {
                at: off,
                status: 0x80 | chan,
                d1: key,
                d2: 0,
            });
            spans.push(Span {
                start: on,
                end: off,
                status: 0x90 | chan,
                key,
                vel: note.vel.max(1),
            });
        }
        for cc in &take.cc {
            let at = start + cc.at_ms / 1_000.0;
            if at >= end {
                continue;
            }
            let chan = cc.chan & 0x0f;
            let (status, d1, d2) = match cc.kind {
                MidiCcKind::Cc => (
                    0xb0 | chan,
                    cc.cc.unwrap_or(0),
                    cc.value.clamp(0, 127) as u8,
                ),
                MidiCcKind::Bend => {
                    let v = (cc.value.clamp(-8192, 8191) + 8192) as u16;
                    (0xe0 | chan, (v & 0x7f) as u8, (v >> 7) as u8)
                }
                MidiCcKind::Pressure => (0xd0 | chan, cc.value.clamp(0, 127) as u8, 0),
                MidiCcKind::Program => (0xc0 | chan, cc.value.clamp(0, 127) as u8, 0),
            };
            events.push(MidiEvent { at, status, d1, d2 });
        }
    }
    let order = |e: &MidiEvent| match e.status & 0xf0 {
        0x80 => 0,
        0x90 => 2,
        _ => 1,
    };
    events.sort_by(|a, b| a.at.total_cmp(&b.at).then(order(a).cmp(&order(b))));
    spans.sort_by(|a, b| a.start.total_cmp(&b.start));
    (events, spans)
}

/// A MIDI lane's events and instrument, as the engine plays them.
pub struct MidiPart {
    /// The instrument settings `sound` was built from.
    pub key: String,
    pub sound: LaneSound,
    events: Vec<MidiEvent>,
    spans: Vec<Span>,
    next: usize,
    /// Where the last block ended on the timeline (none: stopped).
    cursor: Option<f64>,
    live: LiveQueue,
    /// The pad bank's sends to the song's first two buses.
    pub send_a: (Vec<f32>, Vec<f32>),
    pub send_b: (Vec<f32>, Vec<f32>),
}

impl MidiPart {
    /// The part for `lane`, playing its clips through `sound` (built off the audio thread).
    pub fn new(
        lane: &AudioLane,
        sound: LaneSound,
        semitones: i32,
        live: LiveQueue,
        max_block: usize,
    ) -> Self {
        let semitones = if transposes(lane.instrument.as_ref()) {
            semitones
        } else {
            0
        };
        let (events, spans) = schedule(lane, semitones);
        Self {
            key: sound_key(lane),
            sound,
            events,
            spans,
            next: 0,
            cursor: None,
            live,
            send_a: (vec![0.0; max_block], vec![0.0; max_block]),
            send_b: (vec![0.0; max_block], vec![0.0; max_block]),
        }
    }

    /// Takes over a running sound built from the same settings, so an edit while playing does
    /// not cut every note's tail. Held notes start again at the next block.
    pub fn take_sound_from(&mut self, old: &mut MidiPart) {
        if old.key == self.key {
            std::mem::swap(&mut self.sound, &mut old.sound);
            self.sound.all_off(false);
        }
    }

    /// The last clip's end, in timeline seconds.
    pub fn end(&self) -> f64 {
        self.events.last().map_or(0.0, |e| e.at)
    }

    /// Events and notes scheduled (for tests and checks).
    pub fn event_count(&self) -> usize {
        self.events.len()
    }

    pub fn reset(&mut self) {
        self.sound.all_off(true);
        self.cursor = None;
        self.next = 0;
    }

    fn seek(&mut self, t: f64) {
        self.next = self.events.partition_point(|e| e.at < t);
        if self.sound.chases() {
            for i in 0..self.spans.len() {
                let s = self.spans[i];
                if s.start >= t {
                    break;
                }
                if s.end > t + CHASE_MIN_S {
                    self.sound.send(s.status, s.key, s.vel);
                }
            }
        }
    }

    fn render_sound(&mut self, from: usize, to: usize, out: &mut (&mut [f32], &mut [f32])) {
        if to <= from {
            return;
        }
        match &mut self.sound {
            LaneSound::Synth { instrument, .. } => {
                instrument.render(&mut out.0[from..to], &mut out.1[from..to]);
            }
            LaneSound::Pads(pads) => pads.render(
                (&mut out.0[from..to], &mut out.1[from..to]),
                (&mut self.send_a.0[from..to], &mut self.send_a.1[from..to]),
                (&mut self.send_b.0[from..to], &mut self.send_b.1[from..to]),
            ),
        }
    }

    /// Plays the block whose samples sit at `times` on the timeline into `out` (which starts
    /// silent). Live messages play at the block start; clip events at their sample.
    pub fn render(&mut self, times: &[f64], playing: bool, mut out: (&mut [f32], &mut [f32])) {
        let n = times.len().min(out.0.len());
        for buf in [
            &mut self.send_a.0,
            &mut self.send_a.1,
            &mut self.send_b.0,
            &mut self.send_b.1,
        ] {
            let len = n.min(buf.len());
            buf[..len].fill(0.0);
        }
        while let Some([status, d1, d2]) = self.live.pop() {
            self.sound.send(status, d1, d2);
        }
        if n == 0 {
            return;
        }
        if !playing {
            if self.cursor.take().is_some() {
                self.sound.all_off(false);
            }
            self.render_sound(0, n, &mut out);
            return;
        }
        let t0 = times[0];
        let jumped = self
            .cursor
            .is_none_or(|c| t0 < c - 1.0e-3 || t0 > c + SEEK_GAP_S);
        if jumped {
            if self.cursor.is_some() {
                self.sound.all_off(false);
            }
            self.seek(t0);
        }
        let step = if n > 1 {
            times[n - 1] - times[n - 2]
        } else {
            0.0
        };
        let end = times[n - 1] + step.max(0.0);
        let mut done = 0;
        while let Some(&e) = self.events.get(self.next) {
            if e.at >= end {
                break;
            }
            let at = times[..n].partition_point(|&t| t < e.at);
            self.render_sound(done, at, &mut out);
            done = done.max(at);
            self.sound.send(e.status, e.d1, e.d2);
            self.next += 1;
        }
        self.render_sound(done, n, &mut out);
        self.cursor = Some(end);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_lanes::{AudioClip, AudioTake};
    use crate::midi_lanes::{LaneKind, MidiClipData, MidiNote, MidiTake};
    use std::sync::Mutex;

    /// Records what it is sent and renders a constant while any note is on.
    type Sent = Arc<Mutex<Vec<(i32, i32, i32, i32)>>>;

    #[derive(Default, Clone)]
    struct Probe(Sent, Arc<Mutex<i32>>);

    impl Instrument for Probe {
        fn midi(&mut self, channel: i32, command: i32, d1: i32, d2: i32) {
            self.0.lock().unwrap().push((channel, command, d1, d2));
            let mut on = self.1.lock().unwrap();
            match command {
                0x90 => *on += 1,
                0x80 => *on -= 1,
                _ => {}
            }
        }
        fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
            let level = if *self.1.lock().unwrap() > 0 {
                1.0
            } else {
                0.0
            };
            left.fill(level);
            right.fill(level);
        }
        fn reset(&mut self) {}
        fn note_off_all(&mut self, _immediate: bool) {
            *self.1.lock().unwrap() = 0;
            self.0.lock().unwrap().push((-1, 0xb0, 123, 0));
        }
    }

    fn note(start_ms: f64, len_ms: f64, pitch: u8) -> MidiNote {
        MidiNote {
            id: format!("n{start_ms}"),
            start_ms,
            len_ms,
            pitch,
            vel: 100,
            chan: 3,
            raw_start_ms: None,
            raw_len_ms: None,
            muted: false,
        }
    }

    fn lane(notes: Vec<MidiNote>) -> AudioLane {
        let json = r#"{"id":"m","name":"M","enabled":true,"volume":1,"pan":0,"mute":false,"solo":false,
            "eq":{"lowDb":0,"midDb":0,"midHz":1000,"highDb":0},"semitones":0,"cents":0,"filter":"off"}"#;
        let mut lane: AudioLane = serde_json::from_str(json).unwrap();
        lane.kind = Some(LaneKind::Midi);
        let clip_json = r#"{"id":"c","takes":[{"name":"t","sourceId":"","offsetMs":0}],"startMs":1000,"lengthMs":2000}"#;
        let mut clip: AudioClip = serde_json::from_str(clip_json).unwrap();
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

    fn part(lane: &AudioLane, probe: &Probe) -> MidiPart {
        MidiPart::new(
            lane,
            LaneSound::Synth {
                instrument: Box::new(probe.clone()),
                channel: channel_for(lane.instrument.as_ref()),
            },
            2,
            live_queue(),
            256,
        )
    }

    /// Times of a block of `n` samples at 1 kHz from `t0` seconds.
    fn block(t0: f64, n: usize) -> Vec<f64> {
        (0..n).map(|i| t0 + i as f64 / 1_000.0).collect()
    }

    #[test]
    fn notes_start_and_stop_on_their_sample_and_are_cut_at_the_clip_end() {
        let lane = lane(vec![note(100.0, 50.0, 60), note(1_900.0, 500.0, 62)]);
        let probe = Probe::default();
        let mut p = part(&lane, &probe);
        assert_eq!(p.event_count(), 4);
        let (mut l, mut r) = (vec![0.0; 256], vec![0.0; 256]);
        p.render(&block(1.0, 256), true, (&mut l, &mut r));
        assert_eq!(l[99], 0.0);
        assert_eq!(l[100], 1.0, "on at 1.100 s, sample 100");
        assert_eq!(l[149], 1.0);
        assert_eq!(l[152], 0.0, "off 50 ms later (within a sample)");
        let sent = probe.0.lock().unwrap().clone();
        assert_eq!(
            sent[0],
            (0, 0x90, 62, 100),
            "General MIDI program: channel 0, +2 semitones"
        );
        // The second note runs past the clip end at 3.0 s: it stops there.
        let mut p = part(&lane, &probe);
        let (mut l, mut r) = (vec![0.0; 256], vec![0.0; 256]);
        p.render(&block(2.95, 256), true, (&mut l, &mut r));
        assert_eq!(l[49], 1.0, "a seek into the note restarts it (chase)");
        assert_eq!(l[50], 0.0, "cut at the clip end");
    }

    #[test]
    fn a_seek_stops_sounding_notes_and_stopping_releases_them() {
        let lane = lane(vec![note(0.0, 1_500.0, 60)]);
        let probe = Probe::default();
        let mut p = part(&lane, &probe);
        let (mut l, mut r) = (vec![0.0; 64], vec![0.0; 64]);
        p.render(&block(1.0, 64), true, (&mut l, &mut r));
        assert_eq!(l[10], 1.0);
        p.render(&block(0.0, 64), true, (&mut l, &mut r));
        assert_eq!(l[10], 0.0, "jumped back before the clip: silent");
        p.render(&block(1.2, 64), true, (&mut l, &mut r));
        assert_eq!(l[10], 1.0, "chased into the long note");
        p.render(&block(1.3, 64), false, (&mut l, &mut r));
        assert_eq!(l[10], 0.0, "stop releases every note");
    }

    #[test]
    fn live_messages_sound_while_stopped_and_drums_play_on_channel_nine() {
        let mut lane = lane(vec![]);
        lane.instrument = Some(LaneInstrument::Drums);
        let probe = Probe::default();
        let live = live_queue();
        let mut p = MidiPart::new(
            &lane,
            LaneSound::Synth {
                instrument: Box::new(probe.clone()),
                channel: channel_for(lane.instrument.as_ref()),
            },
            5,
            live.clone(),
            64,
        );
        live.push([0x90, 38, 90]).unwrap();
        let (mut l, mut r) = (vec![0.0; 64], vec![0.0; 64]);
        p.render(&block(0.0, 64), false, (&mut l, &mut r));
        assert_eq!(l[0], 1.0);
        assert_eq!(
            probe.0.lock().unwrap()[0],
            (9, 0x90, 38, 90),
            "drums never transpose"
        );
    }

    #[test]
    fn muted_notes_and_clips_stay_silent() {
        let mut quiet = note(0.0, 100.0, 60);
        quiet.muted = true;
        let mut lane = lane(vec![quiet]);
        let probe = Probe::default();
        assert_eq!(part(&lane, &probe).event_count(), 0);
        lane.clips[0].mute = true;
        lane.clips[0].midi.as_mut().unwrap().takes[0].notes = vec![note(0.0, 10.0, 60)];
        assert_eq!(part(&lane, &probe).event_count(), 0);
    }
}
