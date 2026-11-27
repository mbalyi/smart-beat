//! The pad bank: a sampler whose pads each play one sample (ADR 0006).
//!
//! A pad answers one MIDI key and plays its sample one-shot (to the end), gated (while the key is
//! held) or looped (while held). It has trim, tune, volume, pan, velocity depth, a choke group,
//! a voice limit, and send levels to the song's first two buses. Voices are preallocated: nothing
//! allocates on the audio thread. A full pool steals the oldest voice with a short fade.

use std::sync::Arc;

use crate::audio::backing::DecodedAudio;
use crate::audio::engine::Instrument;
use crate::midi_lanes::{PadPlayback, PadSlot};

/// The most voices of the whole bank at once.
pub const MAX_VOICES: usize = 64;
/// How long a voice fades when it is let go, choked or stolen, in seconds.
const RELEASE_S: f32 = 0.012;
/// How long a loop's ends crossfade, in frames (avoids a click at the seam).
const LOOP_XFADE: usize = 64;

/// One pad, ready to play.
pub struct Pad {
    pub key: u8,
    audio: Arc<DecodedAudio>,
    /// Frames of the source played: [start, end).
    start: usize,
    end: usize,
    /// Source frames per output frame (rate and tune).
    step: f64,
    playback: PadPlayback,
    /// Left and right gains (volume and pan).
    gains: (f32, f32),
    vel_depth: f32,
    choke: u8,
    voices: u8,
    pub send_a: f32,
    pub send_b: f32,
}

impl Pad {
    /// A pad from its settings and its decoded sample, for an output at `rate`.
    pub fn new(slot: &PadSlot, audio: Arc<DecodedAudio>, rate: f32) -> Self {
        let frames = audio.frames();
        let at = |ms: f64| ((ms / 1_000.0) * audio.rate as f64).round().max(0.0) as usize;
        let start = at(slot.trim_start_ms).min(frames);
        let end = if slot.trim_end_ms > 0.0 {
            at(slot.trim_end_ms).clamp(start, frames)
        } else {
            frames
        };
        let cents = slot.semitones as f64 * 100.0 + slot.cents as f64;
        let pan = slot.pan.clamp(-1.0, 1.0);
        let volume = slot.volume.clamp(0.0, 1.0);
        // Constant-power pan.
        let angle = (pan + 1.0) * std::f32::consts::FRAC_PI_4;
        Self {
            key: slot.key,
            start,
            end,
            step: audio.rate as f64 / rate as f64 * 2f64.powf(cents / 1_200.0),
            audio,
            playback: slot.playback,
            gains: (
                volume * angle.cos() * std::f32::consts::SQRT_2,
                volume * angle.sin() * std::f32::consts::SQRT_2,
            ),
            vel_depth: slot.vel_depth.clamp(0.0, 1.0),
            choke: slot.choke,
            voices: slot.voices.clamp(1, 32),
            send_a: slot.send_a.clamp(0.0, 1.0),
            send_b: slot.send_b.clamp(0.0, 1.0),
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Voice {
    active: bool,
    pad: usize,
    pos: f64,
    gain: f32,
    /// Set while the voice fades out: the level drops by this per frame.
    fade: f32,
    level: f32,
    held: bool,
    /// When the voice started (for stealing the oldest).
    age: u64,
}

/// Plays a bank of pads.
pub struct PadSampler {
    pads: Vec<Pad>,
    /// `by_key[key]` is the pad that answers it.
    by_key: [Option<u16>; 128],
    voices: Vec<Voice>,
    clock: u64,
    release_step: f32,
}

impl PadSampler {
    pub fn new(pads: Vec<Pad>, rate: f32) -> Self {
        let mut by_key = [None; 128];
        for (i, pad) in pads.iter().enumerate() {
            if let Some(slot) = by_key.get_mut(pad.key as usize) {
                slot.get_or_insert(i as u16);
            }
        }
        Self {
            pads,
            by_key,
            voices: vec![Voice::default(); MAX_VOICES],
            clock: 0,
            release_step: 1.0 / (RELEASE_S * rate).max(1.0),
        }
    }

    /// The pads, in bank order.
    pub fn pads(&self) -> &[Pad] {
        &self.pads
    }

    /// Voices playing now.
    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|v| v.active).count()
    }

    fn release(&mut self, voice: usize) {
        let step = self.release_step;
        let v = &mut self.voices[voice];
        if v.fade == 0.0 {
            v.fade = step;
        }
    }

    /// A key is hit.
    pub fn note_on(&mut self, key: u8, velocity: u8) {
        if velocity == 0 {
            return self.note_off(key);
        }
        let Some(pad_index) = self.by_key.get(key as usize).copied().flatten() else {
            return;
        };
        let pad_index = pad_index as usize;
        let pad = &self.pads[pad_index];
        if pad.end <= pad.start {
            return;
        }
        let choke = pad.choke;
        let limit = pad.voices as usize;
        let vel = velocity as f32 / 127.0;
        let gain = 1.0 - pad.vel_depth + pad.vel_depth * vel * vel;
        let start = pad.start as f64;
        // Choke: other pads of the group stop; a pad also chokes itself past its voice limit.
        for i in 0..self.voices.len() {
            let v = self.voices[i];
            if v.active
                && v.fade == 0.0
                && choke > 0
                && v.pad != pad_index
                && self.pads[v.pad].choke == choke
            {
                self.release(i);
            }
        }
        // Past the pad's voice limit, its oldest voices fade (no allocation: a scan per voice).
        loop {
            let sounding = |v: &Voice| v.active && v.fade == 0.0 && v.pad == pad_index;
            if self.voices.iter().filter(|v| sounding(v)).count() < limit {
                break;
            }
            let Some(oldest) = self
                .voices
                .iter()
                .enumerate()
                .filter(|(_, v)| sounding(v))
                .min_by_key(|(_, v)| v.age)
                .map(|(i, _)| i)
            else {
                break;
            };
            self.release(oldest);
        }
        // A free voice, or the oldest one (stolen).
        let slot = self
            .voices
            .iter()
            .position(|v| !v.active)
            .unwrap_or_else(|| {
                self.voices
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, v)| v.age)
                    .map_or(0, |(i, _)| i)
            });
        self.clock += 1;
        self.voices[slot] = Voice {
            active: true,
            pad: pad_index,
            pos: start,
            gain,
            fade: 0.0,
            level: 1.0,
            held: true,
            age: self.clock,
        };
    }

    /// A key is let go: gated and looped pads stop, one-shots play on.
    pub fn note_off(&mut self, key: u8) {
        let Some(pad_index) = self.by_key.get(key as usize).copied().flatten() else {
            return;
        };
        let pad_index = pad_index as usize;
        let one_shot = self.pads[pad_index].playback == PadPlayback::OneShot;
        for i in 0..self.voices.len() {
            let v = self.voices[i];
            if v.active && v.pad == pad_index && v.held {
                self.voices[i].held = false;
                if !one_shot {
                    self.release(i);
                }
            }
        }
    }

    /// Every voice fades (`immediate`: stops at once).
    pub fn all_off(&mut self, immediate: bool) {
        for i in 0..self.voices.len() {
            if immediate {
                self.voices[i].active = false;
            } else if self.voices[i].active {
                self.release(i);
            }
        }
    }

    /// Adds the pads' sound to `out`, and their sends to `send_a` and `send_b` (all the same
    /// length).
    pub fn render(
        &mut self,
        out: (&mut [f32], &mut [f32]),
        send_a: (&mut [f32], &mut [f32]),
        send_b: (&mut [f32], &mut [f32]),
    ) {
        let n = out.0.len();
        let (ol, or) = out;
        let (al, ar) = send_a;
        let (bl, br) = send_b;
        for v in self.voices.iter_mut().filter(|v| v.active) {
            let pad = &self.pads[v.pad];
            let (gl, gr) = (pad.gains.0 * v.gain, pad.gains.1 * v.gain);
            let looped = pad.playback == PadPlayback::Loop;
            let len = (pad.end - pad.start) as f64;
            for i in 0..n {
                let mut idx = v.pos as usize;
                if idx + 1 >= pad.end {
                    if looped && len > 2.0 {
                        v.pos -= len;
                        idx = v.pos as usize;
                    } else {
                        v.active = false;
                        break;
                    }
                }
                let frac = (v.pos - idx as f64) as f32;
                let left = &pad.audio.left;
                let right = if pad.audio.right.is_empty() {
                    left
                } else {
                    &pad.audio.right
                };
                let mut sl = left[idx] + (left[idx + 1] - left[idx]) * frac;
                let mut sr = right[idx] + (right[idx + 1] - right[idx]) * frac;
                if looped && len > (2 * LOOP_XFADE) as f64 {
                    // Fade the loop's tail into its head.
                    let to_end = pad.end - 1 - idx;
                    if to_end < LOOP_XFADE {
                        let head = idx + 1 + LOOP_XFADE - (pad.end - pad.start);
                        let head = head.clamp(pad.start, pad.end - 2);
                        let w = 1.0 - to_end as f32 / LOOP_XFADE as f32;
                        sl = sl * (1.0 - w) + left[head] * w;
                        sr = sr * (1.0 - w) + right[head] * w;
                    }
                }
                if v.fade > 0.0 {
                    v.level -= v.fade;
                    if v.level <= 0.0 {
                        v.active = false;
                        break;
                    }
                }
                let (l, r) = (sl * gl * v.level, sr * gr * v.level);
                ol[i] += l;
                or[i] += r;
                if pad.send_a > 0.0 {
                    al[i] += l * pad.send_a;
                    ar[i] += r * pad.send_a;
                }
                if pad.send_b > 0.0 {
                    bl[i] += l * pad.send_b;
                    br[i] += r * pad.send_b;
                }
                v.pos += pad.step;
            }
        }
    }
}

/// A pad bank as a lane plays it: the sampled pads, and pads that play a drum of the General
/// MIDI kit instead (through a synth on channel 10).
pub struct PadBank {
    pub sampler: PadSampler,
    drums: Option<Box<dyn Instrument>>,
    /// `drum_keys[key]`: the General MIDI drum a pad without a sample plays.
    drum_keys: [Option<u8>; 128],
    drum_left: Vec<f32>,
    drum_right: Vec<f32>,
}

impl PadBank {
    pub fn new(
        sampler: PadSampler,
        drums: Option<Box<dyn Instrument>>,
        drum_keys: [Option<u8>; 128],
    ) -> Self {
        Self {
            sampler,
            drums,
            drum_keys,
            drum_left: vec![0.0; 4_096],
            drum_right: vec![0.0; 4_096],
        }
    }

    fn drum(&self, key: u8) -> Option<u8> {
        self.drum_keys.get(key as usize).copied().flatten()
    }

    pub fn note_on(&mut self, key: u8, velocity: u8) {
        match (self.drum(key), &mut self.drums) {
            (Some(drum), Some(synth)) => synth.midi(9, 0x90, drum as i32, velocity as i32),
            _ => self.sampler.note_on(key, velocity),
        }
    }

    pub fn note_off(&mut self, key: u8) {
        match (self.drum(key), &mut self.drums) {
            (Some(drum), Some(synth)) => synth.midi(9, 0x80, drum as i32, 0),
            _ => self.sampler.note_off(key),
        }
    }

    pub fn all_off(&mut self, immediate: bool) {
        self.sampler.all_off(immediate);
        if let Some(synth) = &mut self.drums {
            synth.note_off_all(immediate);
        }
    }

    /// Adds the bank's sound to `out` and the sampled pads' sends to `send_a` and `send_b`.
    pub fn render(
        &mut self,
        out: (&mut [f32], &mut [f32]),
        send_a: (&mut [f32], &mut [f32]),
        send_b: (&mut [f32], &mut [f32]),
    ) {
        let n = out.0.len();
        if let Some(synth) = &mut self.drums {
            let n = n.min(self.drum_left.len());
            let (l, r) = (&mut self.drum_left[..n], &mut self.drum_right[..n]);
            synth.render(l, r);
            for i in 0..n {
                out.0[i] += l[i];
                out.1[i] += r[i];
            }
        }
        self.sampler.render(out, send_a, send_b);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(frames: usize) -> Arc<DecodedAudio> {
        Arc::new(DecodedAudio {
            rate: 48_000,
            channels: 1,
            left: vec![0.5; frames],
            right: vec![],
        })
    }

    fn slot(key: u8) -> PadSlot {
        serde_json::from_str(&format!(r#"{{"key":{key}}}"#)).unwrap()
    }

    fn render(s: &mut PadSampler, n: usize) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
        let (mut l, mut r) = (vec![0.0; n], vec![0.0; n]);
        let (mut al, mut ar) = (vec![0.0; n], vec![0.0; n]);
        let (mut bl, mut br) = (vec![0.0; n], vec![0.0; n]);
        s.render((&mut l, &mut r), (&mut al, &mut ar), (&mut bl, &mut br));
        (l, r, al)
    }

    #[test]
    fn a_one_shot_plays_to_its_end_after_the_key_is_let_go() {
        let mut s = PadSampler::new(vec![Pad::new(&slot(36), tone(1_000), 48_000.0)], 48_000.0);
        s.note_on(36, 127);
        s.note_off(36);
        let (l, _, _) = render(&mut s, 500);
        assert!(l.iter().all(|&x| x > 0.4), "plays on");
        let (l, _, _) = render(&mut s, 1_000);
        assert_eq!(l[600], 0.0, "stops at the end of the sample");
        assert_eq!(s.active_voices(), 0);
    }

    #[test]
    fn a_gated_pad_stops_when_let_go_and_a_loop_repeats_while_held() {
        let gate = PadSlot {
            playback: PadPlayback::Gate,
            ..slot(38)
        };
        let looped = PadSlot {
            playback: PadPlayback::Loop,
            ..slot(40)
        };
        let mut s = PadSampler::new(
            vec![
                Pad::new(&gate, tone(10_000), 48_000.0),
                Pad::new(&looped, tone(300), 48_000.0),
            ],
            48_000.0,
        );
        s.note_on(38, 100);
        render(&mut s, 100);
        s.note_off(38);
        render(&mut s, 2_000);
        assert_eq!(s.active_voices(), 0, "the gated pad faded out");
        s.note_on(40, 100);
        let (l, _, _) = render(&mut s, 2_000);
        assert!(l[1_900] > 0.1, "the loop keeps playing past its length");
    }

    #[test]
    fn choke_groups_voice_limits_and_sends() {
        let open = PadSlot {
            choke: 1,
            send_a: 0.5,
            ..slot(46)
        };
        let closed = PadSlot {
            choke: 1,
            ..slot(42)
        };
        let single = PadSlot {
            voices: 1,
            ..slot(36)
        };
        let mut s = PadSampler::new(
            vec![
                Pad::new(&open, tone(48_000), 48_000.0),
                Pad::new(&closed, tone(48_000), 48_000.0),
                Pad::new(&single, tone(48_000), 48_000.0),
            ],
            48_000.0,
        );
        s.note_on(46, 127);
        let (l, _, send) = render(&mut s, 10);
        assert!(
            (send[5] - l[5] * 0.5).abs() < 1e-6,
            "send A gets half the pad"
        );
        s.note_on(42, 127);
        render(&mut s, 2_000);
        assert_eq!(
            s.active_voices(),
            1,
            "the closed hi-hat choked the open one"
        );
        s.note_on(36, 127);
        s.note_on(36, 127);
        render(&mut s, 2_000);
        assert_eq!(s.active_voices(), 2, "one voice of the kick at a time");
        s.all_off(true);
        assert_eq!(s.active_voices(), 0);
    }

    #[test]
    fn velocity_depth_and_unknown_keys() {
        let mut s = PadSampler::new(vec![Pad::new(&slot(36), tone(1_000), 48_000.0)], 48_000.0);
        s.note_on(37, 127);
        assert_eq!(s.active_voices(), 0, "no pad answers key 37");
        s.note_on(36, 64);
        let (soft, _, _) = render(&mut s, 10);
        s.all_off(true);
        s.note_on(36, 127);
        let (loud, _, _) = render(&mut s, 10);
        assert!(soft[5] < loud[5] * 0.5, "velocity changes the level");
    }

    #[test]
    fn steals_the_oldest_voice_when_the_bank_is_full() {
        let pads: Vec<Pad> = (0..70)
            .map(|k| Pad::new(&slot(k), tone(48_000), 48_000.0))
            .collect();
        let mut s = PadSampler::new(pads, 48_000.0);
        for k in 0..70 {
            s.note_on(k, 100);
        }
        assert_eq!(s.active_voices(), MAX_VOICES);
    }
}
