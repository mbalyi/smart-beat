//! Algorithmic reverb: a pre-delay, eight parallel feedback combs with damping
//! in their loops, then four series all-passes, per channel. This is the
//! classic Schroeder/Moorer structure (the one Freeverb popularised); the
//! loop lengths are mutually prime so their echoes do not line up, and the
//! right channel's are a little longer for width.

use serde::{Deserialize, Serialize};

use super::modulation::DelayLine;
use super::{Effect, flush_denormal};
use crate::audio::chain::EffectConfig;

/// Comb and all-pass lengths at 44.1 kHz (scaled to the actual rate).
const COMBS: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES: [usize; 4] = [556, 441, 341, 225];
const STEREO_SPREAD: usize = 23;
const ALLPASS_FEEDBACK: f32 = 0.5;
/// Input gain into the combs (eight of them sum up).
const INPUT_GAIN: f32 = 0.015;
const MAX_PRE_DELAY_MS: f32 = 200.0;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReverbParams {
    /// Room size 0…1 (longer decay).
    pub size: f32,
    /// 0…1: how quickly the highs die out.
    pub damping: f32,
    /// Share of the reverb, 0…1.
    pub mix: f32,
    pub pre_delay_ms: f32,
    /// Stereo width of the reverb, 0 (mono) … 1.
    pub width: f32,
}

impl Default for ReverbParams {
    fn default() -> Self {
        Self {
            size: 0.5,
            damping: 0.5,
            mix: 0.25,
            pre_delay_ms: 10.0,
            width: 1.0,
        }
    }
}

struct Comb {
    buffer: Vec<f32>,
    pos: usize,
    store: f32,
}

impl Comb {
    fn new(len: usize) -> Self {
        Self {
            buffer: vec![0.0; len.max(1)],
            pos: 0,
            store: 0.0,
        }
    }

    #[inline]
    fn tick(&mut self, x: f32, feedback: f32, damp: f32) -> f32 {
        let out = self.buffer[self.pos];
        self.store = flush_denormal(out * (1.0 - damp) + self.store * damp);
        self.buffer[self.pos] = flush_denormal(x + self.store * feedback);
        self.pos = (self.pos + 1) % self.buffer.len();
        out
    }

    fn clear(&mut self) {
        self.buffer.fill(0.0);
        self.store = 0.0;
    }
}

struct AllPass {
    buffer: Vec<f32>,
    pos: usize,
}

impl AllPass {
    fn new(len: usize) -> Self {
        Self {
            buffer: vec![0.0; len.max(1)],
            pos: 0,
        }
    }

    #[inline]
    fn tick(&mut self, x: f32) -> f32 {
        let stored = self.buffer[self.pos];
        let out = stored - x;
        self.buffer[self.pos] = flush_denormal(x + stored * ALLPASS_FEEDBACK);
        self.pos = (self.pos + 1) % self.buffer.len();
        out
    }

    fn clear(&mut self) {
        self.buffer.fill(0.0);
    }
}

struct Tank {
    combs: Vec<Comb>,
    allpasses: Vec<AllPass>,
}

impl Tank {
    fn new(sample_rate: f32, spread: usize) -> Self {
        let scale = |len: usize| ((len + spread) as f32 * sample_rate / 44_100.0) as usize;
        Self {
            combs: COMBS.iter().map(|&n| Comb::new(scale(n))).collect(),
            allpasses: ALLPASSES.iter().map(|&n| AllPass::new(scale(n))).collect(),
        }
    }

    #[inline]
    fn tick(&mut self, x: f32, feedback: f32, damp: f32) -> f32 {
        let mut out = 0.0;
        for comb in &mut self.combs {
            out += comb.tick(x, feedback, damp);
        }
        for allpass in &mut self.allpasses {
            out = allpass.tick(out);
        }
        out
    }

    fn clear(&mut self) {
        self.combs.iter_mut().for_each(Comb::clear);
        self.allpasses.iter_mut().for_each(AllPass::clear);
    }
}

pub struct Reverb {
    rate: f32,
    pre_delay: DelayLine,
    tanks: [Tank; 2],
    pre_samples: f32,
    feedback: f32,
    damp: f32,
    mix: f32,
    width: f32,
}

impl Reverb {
    pub fn new(params: ReverbParams, sample_rate: f32) -> Self {
        let mut reverb = Self {
            rate: sample_rate,
            pre_delay: DelayLine::new((MAX_PRE_DELAY_MS * 0.001 * sample_rate) as usize + 1),
            tanks: [
                Tank::new(sample_rate, 0),
                Tank::new(sample_rate, STEREO_SPREAD),
            ],
            pre_samples: 1.0,
            feedback: 0.0,
            damp: 0.0,
            mix: 0.0,
            width: 1.0,
        };
        reverb.set(params);
        reverb
    }

    fn set(&mut self, p: ReverbParams) {
        self.pre_samples =
            (p.pre_delay_ms.clamp(0.0, MAX_PRE_DELAY_MS) * 0.001 * self.rate).max(1.0);
        self.feedback = 0.7 + p.size.clamp(0.0, 1.0) * 0.28;
        self.damp = p.damping.clamp(0.0, 1.0) * 0.4;
        self.mix = p.mix.clamp(0.0, 1.0);
        self.width = p.width.clamp(0.0, 1.0);
    }
}

impl Effect for Reverb {
    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        let (same, cross) = (0.5 + 0.5 * self.width, 0.5 - 0.5 * self.width);
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            self.pre_delay.push((*l + *r) * INPUT_GAIN);
            let input = self.pre_delay.read(self.pre_samples);
            let [tank_l, tank_r] = &mut self.tanks;
            let wet_l = tank_l.tick(input, self.feedback, self.damp);
            let wet_r = tank_r.tick(input, self.feedback, self.damp);
            *l += (wet_l * same + wet_r * cross) * self.mix;
            *r += (wet_r * same + wet_l * cross) * self.mix;
        }
    }

    fn reset(&mut self) {
        self.pre_delay.clear();
        self.tanks.iter_mut().for_each(Tank::clear);
    }

    fn update(&mut self, config: &EffectConfig) -> bool {
        match config {
            EffectConfig::Reverb(p) => {
                self.set(*p);
                true
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_signals::*;
    use super::*;

    fn tail(params: ReverbParams, frames: usize) -> (Vec<f32>, Vec<f32>) {
        let mut reverb = Reverb::new(params, RATE);
        let (mut l, mut r) = (vec![0.0; frames], vec![0.0; frames]);
        l[0] = 1.0;
        r[0] = 1.0;
        for (a, b) in l.chunks_mut(64).zip(r.chunks_mut(64)) {
            reverb.process(a, b);
        }
        (l, r)
    }

    #[test]
    fn an_impulse_leaves_a_decaying_tail() {
        let (l, r) = tail(ReverbParams::default(), 96_000);
        assert!(all_finite(&l) && all_finite(&r));
        let early = rms(&l[2_400..12_000]);
        let late = rms(&l[72_000..]);
        assert!(early > 1e-3, "no reverb: {early}");
        assert!(late < early * 0.2, "does not decay: {early} → {late}");
    }

    #[test]
    fn bigger_rooms_ring_longer() {
        let small = tail(
            ReverbParams {
                size: 0.1,
                ..Default::default()
            },
            72_000,
        );
        let big = tail(
            ReverbParams {
                size: 1.0,
                ..Default::default()
            },
            72_000,
        );
        assert!(rms(&big.0[48_000..]) > rms(&small.0[48_000..]) * 2.0);
    }

    #[test]
    fn width_zero_is_mono_and_mix_zero_is_bypass() {
        let (l, r) = tail(
            ReverbParams {
                width: 0.0,
                ..Default::default()
            },
            24_000,
        );
        assert!(l.iter().zip(&r).all(|(a, b)| (a - b).abs() < 1e-6));
        let input = sine(440.0, 0.5, 4_800);
        let mut dry = Reverb::new(
            ReverbParams {
                mix: 0.0,
                ..Default::default()
            },
            RATE,
        );
        let (mut a, mut b) = (input.clone(), input.clone());
        dry.process(&mut a, &mut b);
        assert_eq!(a, input);
    }

    #[test]
    fn loud_input_stays_bounded_and_reset_silences() {
        let mut reverb = Reverb::new(
            ReverbParams {
                size: 1.0,
                damping: 0.0,
                mix: 1.0,
                ..Default::default()
            },
            RATE,
        );
        let mut l = sine(200.0, 1.0, 96_000);
        let mut r = l.clone();
        reverb.process(&mut l, &mut r);
        assert!(all_finite(&l) && peak(&l) < 4.0, "peak {}", peak(&l));
        reverb.reset();
        let (mut l, mut r) = (vec![0.0; 1_024], vec![0.0; 1_024]);
        reverb.process(&mut l, &mut r);
        assert!(l.iter().all(|s| *s == 0.0));
    }
}
