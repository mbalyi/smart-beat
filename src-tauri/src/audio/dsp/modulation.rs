//! Modulation effects: chorus, phaser and tremolo. Each one is driven by a
//! low-frequency oscillator; the right channel's LFO runs a quarter cycle
//! ahead, which widens the stereo image.

use std::f32::consts::TAU;

use serde::{Deserialize, Serialize};

use super::{Effect, flush_denormal};
use crate::audio::chain::EffectConfig;

/// A sine LFO with a phase accumulator.
#[derive(Debug, Clone, Copy)]
pub struct Lfo {
    phase: f32,
    step: f32,
}

impl Lfo {
    pub fn new(rate_hz: f32, sample_rate: f32) -> Self {
        Self {
            phase: 0.0,
            step: rate_hz / sample_rate,
        }
    }

    pub fn set_rate(&mut self, rate_hz: f32, sample_rate: f32) {
        self.step = rate_hz / sample_rate;
    }

    /// The value at `offset` (in cycles) ahead of the current phase, -1…1.
    #[inline]
    pub fn value(&self, offset: f32) -> f32 {
        (TAU * (self.phase + offset)).sin()
    }

    #[inline]
    pub fn advance(&mut self) {
        self.phase += self.step;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
        }
    }

    pub fn reset(&mut self) {
        self.phase = 0.0;
    }
}

/// A delay line read at fractional positions (linear interpolation).
#[derive(Debug, Clone)]
pub struct DelayLine {
    buffer: Vec<f32>,
    write: usize,
}

impl DelayLine {
    /// Holds up to `max_samples` of delay.
    pub fn new(max_samples: usize) -> Self {
        Self {
            buffer: vec![0.0; max_samples.max(2) + 2],
            write: 0,
        }
    }

    pub fn capacity(&self) -> usize {
        self.buffer.len() - 2
    }

    #[inline]
    pub fn push(&mut self, sample: f32) {
        self.buffer[self.write] = sample;
        self.write = (self.write + 1) % self.buffer.len();
    }

    /// The sample written `delay` samples ago (`delay` ≥ 1, fractional).
    #[inline]
    pub fn read(&self, delay: f32) -> f32 {
        let len = self.buffer.len();
        let delay = delay.clamp(1.0, self.capacity() as f32);
        let whole = delay as usize;
        let frac = delay - whole as f32;
        let a = self.buffer[(self.write + len - whole) % len];
        let b = self.buffer[(self.write + len - whole - 1) % len];
        a + (b - a) * frac
    }

    pub fn clear(&mut self) {
        self.buffer.fill(0.0);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChorusParams {
    /// LFO speed, Hz.
    pub rate_hz: f32,
    /// 0…1: how far the delay swings (up to ±4 ms).
    pub depth: f32,
    /// Centre delay, ms.
    pub delay_ms: f32,
    /// Share of the chorused signal, 0…1.
    pub mix: f32,
}

impl Default for ChorusParams {
    fn default() -> Self {
        Self {
            rate_hz: 0.8,
            depth: 0.5,
            delay_ms: 12.0,
            mix: 0.5,
        }
    }
}

const CHORUS_MAX_MS: f32 = 40.0;

pub struct Chorus {
    rate: f32,
    lfo: Lfo,
    lines: [DelayLine; 2],
    centre: f32,
    swing: f32,
    mix: f32,
}

impl Chorus {
    pub fn new(params: ChorusParams, sample_rate: f32) -> Self {
        let max = (CHORUS_MAX_MS * 0.001 * sample_rate) as usize;
        let mut chorus = Self {
            rate: sample_rate,
            lfo: Lfo::new(1.0, sample_rate),
            lines: [DelayLine::new(max), DelayLine::new(max)],
            centre: 0.0,
            swing: 0.0,
            mix: 0.0,
        };
        chorus.set(params);
        chorus
    }

    fn set(&mut self, p: ChorusParams) {
        let ms = self.rate * 0.001;
        self.lfo.set_rate(p.rate_hz.clamp(0.05, 10.0), self.rate);
        self.centre = p.delay_ms.clamp(5.0, 30.0) * ms;
        self.swing = p.depth.clamp(0.0, 1.0) * 4.0 * ms;
        self.mix = p.mix.clamp(0.0, 1.0);
    }
}

impl Effect for Chorus {
    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            let [line_l, line_r] = &mut self.lines;
            line_l.push(*l);
            line_r.push(*r);
            let wet_l = line_l.read(self.centre + self.swing * self.lfo.value(0.0));
            let wet_r = line_r.read(self.centre + self.swing * self.lfo.value(0.25));
            *l += (wet_l - *l) * self.mix;
            *r += (wet_r - *r) * self.mix;
            self.lfo.advance();
        }
    }

    fn reset(&mut self) {
        self.lines.iter_mut().for_each(DelayLine::clear);
        self.lfo.reset();
    }

    fn update(&mut self, config: &EffectConfig) -> bool {
        match config {
            EffectConfig::Chorus(p) => {
                self.set(*p);
                true
            }
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PhaserParams {
    pub rate_hz: f32,
    /// 0…1: the sweep range.
    pub depth: f32,
    /// 0…0.9: resonance.
    pub feedback: f32,
    pub mix: f32,
}

impl Default for PhaserParams {
    fn default() -> Self {
        Self {
            rate_hz: 0.4,
            depth: 0.7,
            feedback: 0.4,
            mix: 0.5,
        }
    }
}

const PHASER_STAGES: usize = 4;
const PHASER_LOW_HZ: f32 = 200.0;

/// One first-order all-pass section.
#[derive(Debug, Clone, Copy, Default)]
struct AllPass {
    x1: f32,
    y1: f32,
}

impl AllPass {
    #[inline]
    fn tick(&mut self, x: f32, a: f32) -> f32 {
        let y = a * x + self.x1 - a * self.y1;
        self.x1 = x;
        self.y1 = flush_denormal(y);
        y
    }
}

pub struct Phaser {
    rate: f32,
    lfo: Lfo,
    stages: [[AllPass; PHASER_STAGES]; 2],
    last: [f32; 2],
    high_hz: f32,
    feedback: f32,
    mix: f32,
}

impl Phaser {
    pub fn new(params: PhaserParams, sample_rate: f32) -> Self {
        let mut phaser = Self {
            rate: sample_rate,
            lfo: Lfo::new(1.0, sample_rate),
            stages: [[AllPass::default(); PHASER_STAGES]; 2],
            last: [0.0; 2],
            high_hz: PHASER_LOW_HZ,
            feedback: 0.0,
            mix: 0.0,
        };
        phaser.set(params);
        phaser
    }

    fn set(&mut self, p: PhaserParams) {
        self.lfo.set_rate(p.rate_hz.clamp(0.05, 10.0), self.rate);
        self.high_hz = PHASER_LOW_HZ + p.depth.clamp(0.0, 1.0) * 3_800.0;
        self.feedback = p.feedback.clamp(0.0, 0.9);
        self.mix = p.mix.clamp(0.0, 1.0);
    }

    /// All-pass coefficient for a notch near `freq`.
    #[inline]
    fn coefficient(&self, freq: f32) -> f32 {
        let t = (std::f32::consts::PI * freq.min(self.rate * 0.45) / self.rate).tan();
        (t - 1.0) / (t + 1.0)
    }
}

impl Effect for Phaser {
    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            for (channel, sample) in [l, r].into_iter().enumerate() {
                // Exponential sweep between the low and high frequency.
                let lfo = 0.5 + 0.5 * self.lfo.value(channel as f32 * 0.25);
                let freq = PHASER_LOW_HZ * (self.high_hz / PHASER_LOW_HZ).powf(lfo);
                let a = self.coefficient(freq);
                let mut y = *sample + self.last[channel] * self.feedback;
                for stage in &mut self.stages[channel] {
                    y = stage.tick(y, a);
                }
                self.last[channel] = flush_denormal(y);
                *sample += (y - *sample) * self.mix;
            }
            self.lfo.advance();
        }
    }

    fn reset(&mut self) {
        self.stages = [[AllPass::default(); PHASER_STAGES]; 2];
        self.last = [0.0; 2];
        self.lfo.reset();
    }

    fn update(&mut self, config: &EffectConfig) -> bool {
        match config {
            EffectConfig::Phaser(p) => {
                self.set(*p);
                true
            }
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TremoloParams {
    pub rate_hz: f32,
    /// 0…1: how deep the volume dips.
    pub depth: f32,
    /// 0 (smooth sine) … 1 (square, choppy).
    pub shape: f32,
    /// Alternate the two channels (auto-pan) instead of moving together.
    pub stereo: bool,
}

impl Default for TremoloParams {
    fn default() -> Self {
        Self {
            rate_hz: 5.0,
            depth: 0.5,
            shape: 0.0,
            stereo: false,
        }
    }
}

pub struct Tremolo {
    rate: f32,
    lfo: Lfo,
    depth: f32,
    shape: f32,
    stereo: bool,
}

impl Tremolo {
    pub fn new(params: TremoloParams, sample_rate: f32) -> Self {
        let mut tremolo = Self {
            rate: sample_rate,
            lfo: Lfo::new(1.0, sample_rate),
            depth: 0.0,
            shape: 0.0,
            stereo: false,
        };
        tremolo.set(params);
        tremolo
    }

    fn set(&mut self, p: TremoloParams) {
        self.lfo.set_rate(p.rate_hz.clamp(0.1, 20.0), self.rate);
        self.depth = p.depth.clamp(0.0, 1.0);
        self.shape = p.shape.clamp(0.0, 1.0);
        self.stereo = p.stereo;
    }

    /// Gain for an LFO value: 1 at the top, `1 - depth` at the bottom.
    #[inline]
    fn gain(&self, lfo: f32) -> f32 {
        // Squaring up the sine: drive it into a soft clip.
        let drive = 1.0 + self.shape * 12.0;
        let wave = (lfo * drive).tanh() / drive.tanh();
        1.0 - self.depth * (0.5 - 0.5 * wave)
    }
}

impl Effect for Tremolo {
    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        let offset = if self.stereo { 0.5 } else { 0.0 };
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            *l *= self.gain(self.lfo.value(0.0));
            *r *= self.gain(self.lfo.value(offset));
            self.lfo.advance();
        }
    }

    fn reset(&mut self) {
        self.lfo.reset();
    }

    fn update(&mut self, config: &EffectConfig) -> bool {
        match config {
            EffectConfig::Tremolo(p) => {
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

    fn run(effect: &mut dyn Effect, input: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let (mut l, mut r) = (input.to_vec(), input.to_vec());
        for (a, b) in l.chunks_mut(64).zip(r.chunks_mut(64)) {
            effect.process(a, b);
        }
        (l, r)
    }

    #[test]
    fn delay_line_reads_whole_and_fractional_delays() {
        let mut line = DelayLine::new(16);
        for i in 0..10 {
            line.push(i as f32);
        }
        assert_eq!(line.read(1.0), 9.0);
        assert_eq!(line.read(3.0), 7.0);
        assert!((line.read(2.5) - 7.5).abs() < 1e-6);
        // Out-of-range delays are clamped, never panic.
        assert!(line.read(1_000.0).is_finite());
    }

    #[test]
    fn zero_mix_is_bypass() {
        let input = sine(440.0, 0.5, 4_800);
        let mut chorus = Chorus::new(
            ChorusParams {
                mix: 0.0,
                ..Default::default()
            },
            RATE,
        );
        assert_eq!(run(&mut chorus, &input).0, input);
        let mut phaser = Phaser::new(
            PhaserParams {
                mix: 0.0,
                ..Default::default()
            },
            RATE,
        );
        assert_eq!(run(&mut phaser, &input).0, input);
        let mut tremolo = Tremolo::new(
            TremoloParams {
                depth: 0.0,
                ..Default::default()
            },
            RATE,
        );
        assert_eq!(run(&mut tremolo, &input).0, input);
    }

    #[test]
    fn modulation_keeps_the_level_and_stays_finite() {
        let input = sine(330.0, 0.5, 48_000);
        let effects: Vec<Box<dyn Effect>> = vec![
            Box::new(Chorus::new(ChorusParams::default(), RATE)),
            Box::new(Phaser::new(PhaserParams::default(), RATE)),
            Box::new(Tremolo::new(TremoloParams::default(), RATE)),
        ];
        for mut effect in effects {
            let (l, r) = run(effect.as_mut(), &input);
            assert!(all_finite(&l) && all_finite(&r));
            assert!(peak(&l) < 1.0, "peak {}", peak(&l));
            assert!(rms(&l[24_000..]) > 0.1, "too quiet: {}", rms(&l[24_000..]));
        }
    }

    #[test]
    fn chorus_widens_the_stereo_image() {
        let (l, r) = run(
            &mut Chorus::new(ChorusParams::default(), RATE),
            &sine(440.0, 0.5, 24_000),
        );
        let diff: f32 = l.iter().zip(&r).map(|(a, b)| (a - b).abs()).sum();
        assert!(diff > 1.0);
    }

    #[test]
    fn tremolo_dips_to_one_minus_depth() {
        let mut tremolo = Tremolo::new(
            TremoloParams {
                rate_hz: 2.0,
                depth: 0.6,
                ..Default::default()
            },
            RATE,
        );
        let (l, _) = run(&mut tremolo, &vec![1.0; 48_000]);
        let min = l.iter().cloned().fold(f32::MAX, f32::min);
        assert!((min - 0.4).abs() < 0.01, "min {min}");
        assert!(peak(&l) <= 1.0 + 1e-6);
    }

    #[test]
    fn phaser_with_heavy_feedback_survives_loud_input_and_resets() {
        let mut phaser = Phaser::new(
            PhaserParams {
                feedback: 5.0,
                ..Default::default()
            },
            RATE,
        );
        let (l, _) = run(&mut phaser, &sine(100.0, 4.0, 48_000));
        assert!(all_finite(&l));
        phaser.reset();
        let (silence, _) = run(&mut phaser, &vec![0.0; 256]);
        assert!(silence.iter().all(|s| *s == 0.0));
    }

    #[test]
    fn updates_keep_running_without_rebuilding() {
        let mut chorus = Chorus::new(ChorusParams::default(), RATE);
        assert!(chorus.update(&EffectConfig::Chorus(ChorusParams {
            depth: 1.0,
            ..Default::default()
        })));
        assert!(!chorus.update(&EffectConfig::Tremolo(TremoloParams::default())));
    }
}
