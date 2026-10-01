//! Stereo echo with feedback, a high cut on the repeats (they darken like a
//! tape or analog delay) and an optional ping-pong between the channels.

use serde::{Deserialize, Serialize};

use super::biquad::{Biquad, Coefficients, FilterKind};
use super::modulation::DelayLine;
use super::{Effect, flush_denormal, time_coefficient};
use crate::audio::chain::EffectConfig;

pub const MAX_DELAY_MS: f32 = 2_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DelayParams {
    pub time_ms: f32,
    /// 0…0.95: how much of each repeat comes back.
    pub feedback: f32,
    /// Share of the echoes, 0…1 (the dry signal always stays at full level).
    pub mix: f32,
    /// Low-pass on the repeats, Hz.
    pub high_cut_hz: f32,
    pub ping_pong: bool,
}

impl Default for DelayParams {
    fn default() -> Self {
        Self {
            time_ms: 375.0,
            feedback: 0.35,
            mix: 0.3,
            high_cut_hz: 6_000.0,
            ping_pong: false,
        }
    }
}

pub struct Delay {
    rate: f32,
    lines: [DelayLine; 2],
    filters: [Biquad; 2],
    /// Current and target delay (samples): turning the time knob glides.
    time: f32,
    target: f32,
    glide: f32,
    feedback: f32,
    mix: f32,
    ping_pong: bool,
}

impl Delay {
    pub fn new(params: DelayParams, sample_rate: f32) -> Self {
        let max = (MAX_DELAY_MS * 0.001 * sample_rate) as usize + 1;
        let mut delay = Self {
            rate: sample_rate,
            lines: [DelayLine::new(max), DelayLine::new(max)],
            filters: [Biquad::default(); 2],
            time: 0.0,
            target: 0.0,
            glide: time_coefficient(50.0, sample_rate),
            feedback: 0.0,
            mix: 0.0,
            ping_pong: false,
        };
        delay.set(params);
        delay.time = delay.target;
        delay
    }

    fn set(&mut self, p: DelayParams) {
        self.target = p.time_ms.clamp(1.0, MAX_DELAY_MS) * 0.001 * self.rate;
        self.feedback = p.feedback.clamp(0.0, 0.95);
        self.mix = p.mix.clamp(0.0, 1.0);
        self.ping_pong = p.ping_pong;
        let c = Coefficients::new(
            FilterKind::LowPass,
            p.high_cut_hz.clamp(500.0, 20_000.0),
            0.707,
            0.0,
            self.rate,
        );
        self.filters.iter_mut().for_each(|f| f.set(c));
    }
}

impl Effect for Delay {
    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            self.time = self.target + self.glide * (self.time - self.target);
            let [line_l, line_r] = &mut self.lines;
            let echo_l = self.filters[0].tick(line_l.read(self.time));
            let echo_r = self.filters[1].tick(line_r.read(self.time));
            if self.ping_pong {
                // Mono input goes into the left line; each repeat crosses over.
                line_l.push(flush_denormal(0.5 * (*l + *r) + echo_r * self.feedback));
                line_r.push(flush_denormal(echo_l * self.feedback));
            } else {
                line_l.push(flush_denormal(*l + echo_l * self.feedback));
                line_r.push(flush_denormal(*r + echo_r * self.feedback));
            }
            *l += echo_l * self.mix;
            *r += echo_r * self.mix;
        }
    }

    fn reset(&mut self) {
        self.lines.iter_mut().for_each(DelayLine::clear);
        self.filters.iter_mut().for_each(Biquad::reset);
        self.time = self.target;
    }

    fn update(&mut self, config: &EffectConfig) -> bool {
        match config {
            EffectConfig::Delay(p) => {
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

    fn impulse_response(params: DelayParams, frames: usize) -> (Vec<f32>, Vec<f32>) {
        let mut delay = Delay::new(params, RATE);
        let (mut l, mut r) = (vec![0.0; frames], vec![0.0; frames]);
        l[0] = 1.0;
        r[0] = 1.0;
        for (a, b) in l.chunks_mut(64).zip(r.chunks_mut(64)) {
            delay.process(a, b);
        }
        (l, r)
    }

    fn loudest(samples: &[f32], from: usize) -> usize {
        from + samples[from..]
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
            .unwrap()
            .0
    }

    #[test]
    fn echo_arrives_after_the_delay_time() {
        let (l, _) = impulse_response(
            DelayParams {
                time_ms: 100.0,
                feedback: 0.0,
                mix: 1.0,
                high_cut_hz: 20_000.0,
                ping_pong: false,
            },
            9_600,
        );
        assert_eq!(l[0], 1.0, "the dry signal is untouched");
        let echo = loudest(&l, 1);
        assert!((echo as i32 - 4_800).abs() <= 3, "echo at {echo}");
    }

    #[test]
    fn feedback_repeats_decay() {
        let (l, _) = impulse_response(
            DelayParams {
                time_ms: 50.0,
                feedback: 0.5,
                mix: 1.0,
                ..Default::default()
            },
            48_000,
        );
        let first = peak(&l[2_000..2_800]);
        let second = peak(&l[4_400..5_200]);
        assert!(second < first && second > first * 0.3, "{first} {second}");
        assert!(peak(&l[40_000..]) < 1e-3);
        assert!(all_finite(&l));
    }

    #[test]
    fn ping_pong_alternates_channels() {
        let (l, r) = impulse_response(
            DelayParams {
                time_ms: 50.0,
                feedback: 0.6,
                mix: 1.0,
                high_cut_hz: 20_000.0,
                ping_pong: true,
            },
            12_000,
        );
        // First repeat on the left, second on the right.
        assert!(peak(&l[2_300..2_500]) > 0.3);
        assert!(peak(&r[2_300..2_500]) < 0.01);
        assert!(peak(&r[4_700..4_900]) > 0.1);
    }

    #[test]
    fn zero_mix_is_bypass_and_reset_clears_the_tail() {
        let input = sine(440.0, 0.5, 4_800);
        let mut delay = Delay::new(
            DelayParams {
                mix: 0.0,
                ..Default::default()
            },
            RATE,
        );
        let (mut l, mut r) = (input.clone(), input.clone());
        delay.process(&mut l, &mut r);
        assert_eq!(l, input);
        assert!(delay.update(&EffectConfig::Delay(DelayParams::default())));
        delay.reset();
        let (mut l, mut r) = (vec![0.0; 48_000], vec![0.0; 48_000]);
        delay.process(&mut l, &mut r);
        assert!(l.iter().all(|s| *s == 0.0));
    }
}
