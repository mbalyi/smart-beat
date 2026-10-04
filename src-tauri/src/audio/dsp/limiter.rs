//! Lookahead brickwall limiter for the mastering chain (#39).
//!
//! The signal is delayed by the lookahead. For every incoming sample the gain
//! that keeps it under the ceiling is computed; a sliding minimum holds that
//! gain over the lookahead window and a moving average of the same length
//! turns the drop into a smooth ramp that reaches the needed gain exactly when
//! the peak leaves the delay line. The gain then recovers with the release
//! time. A final clamp guarantees the ceiling. Stereo-linked, no allocation
//! while processing.

use serde::{Deserialize, Serialize};

use super::{Effect, db_to_gain, flush_denormal, gain_to_db, time_coefficient};
use crate::audio::chain::EffectConfig;

/// Longest lookahead (the buffers are sized for it at 192 kHz).
pub const MAX_LOOKAHEAD_MS: f32 = 5.0;
const MAX_RATE: f32 = 192_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LimiterParams {
    /// The output never goes above this (dBFS, -24…0).
    pub ceiling_db: f32,
    /// Time to recover after a peak (ms).
    pub release_ms: f32,
    /// How far ahead peaks are seen (ms); also the latency added.
    pub lookahead_ms: f32,
    /// Gain before limiting (0…24 dB): how much louder the master gets.
    pub input_db: f32,
}

impl Default for LimiterParams {
    fn default() -> Self {
        Self {
            ceiling_db: -1.0,
            release_ms: 80.0,
            lookahead_ms: 1.5,
            input_db: 0.0,
        }
    }
}

impl LimiterParams {
    fn clamped(self) -> Self {
        let finite = |v: f32, d: f32| if v.is_finite() { v } else { d };
        let d = Self::default();
        Self {
            ceiling_db: finite(self.ceiling_db, d.ceiling_db).clamp(-24.0, 0.0),
            release_ms: finite(self.release_ms, d.release_ms).clamp(1.0, 2_000.0),
            lookahead_ms: finite(self.lookahead_ms, d.lookahead_ms).clamp(0.1, MAX_LOOKAHEAD_MS),
            input_db: finite(self.input_db, d.input_db).clamp(0.0, 24.0),
        }
    }
}

pub struct Limiter {
    rate: f32,
    params: LimiterParams,
    ceiling: f32,
    input: f32,
    release: f32,
    /// Lookahead in samples (the delay, the hold and the averaging length).
    len: usize,
    /// Delayed audio (ring buffers of `len` samples).
    delay_l: Box<[f32]>,
    delay_r: Box<[f32]>,
    pos: usize,
    /// Needed gains of the last `len` samples, for the sliding minimum: a
    /// queue of (sample index, gain) with increasing gains.
    min_index: Box<[u64]>,
    min_gain: Box<[f32]>,
    min_head: usize,
    min_count: usize,
    /// The held gains of the last `len` samples, for the moving average.
    avg: Box<[f32]>,
    avg_sum: f64,
    counter: u64,
    gain: f32,
    /// Largest gain reduction in the last block (dB, ≥ 0).
    pub meter_db: f32,
}

impl Limiter {
    pub fn new(params: LimiterParams, sample_rate: f32) -> Self {
        let params = params.clamped();
        let capacity = (MAX_LOOKAHEAD_MS * 0.001 * MAX_RATE.max(sample_rate)).ceil() as usize + 2;
        let mut limiter = Self {
            rate: sample_rate,
            params,
            ceiling: 1.0,
            input: 1.0,
            release: 0.0,
            len: 1,
            delay_l: vec![0.0; capacity].into_boxed_slice(),
            delay_r: vec![0.0; capacity].into_boxed_slice(),
            pos: 0,
            min_index: vec![0; capacity].into_boxed_slice(),
            min_gain: vec![1.0; capacity].into_boxed_slice(),
            min_head: 0,
            min_count: 0,
            avg: vec![1.0; capacity].into_boxed_slice(),
            avg_sum: 0.0,
            counter: 0,
            gain: 1.0,
            meter_db: 0.0,
        };
        limiter.configure(params);
        limiter.reset();
        limiter
    }

    /// Latency in samples (the lookahead).
    pub fn latency(&self) -> usize {
        self.len
    }

    fn configure(&mut self, params: LimiterParams) {
        let params = params.clamped();
        let len = ((params.lookahead_ms * 0.001 * self.rate).round() as usize)
            .clamp(1, self.delay_l.len() - 1);
        let resize = len != self.len;
        self.params = params;
        self.ceiling = db_to_gain(params.ceiling_db);
        self.input = db_to_gain(params.input_db);
        self.release = time_coefficient(params.release_ms, self.rate);
        self.len = len;
        if resize {
            self.reset();
        }
    }

    fn push_min(&mut self, index: u64, gain: f32) {
        let cap = self.min_gain.len();
        // Drop larger gains from the back: they can never be the minimum again.
        while self.min_count > 0 {
            let back = (self.min_head + self.min_count - 1) % cap;
            if self.min_gain[back] >= gain {
                self.min_count -= 1;
            } else {
                break;
            }
        }
        let slot = (self.min_head + self.min_count) % cap;
        self.min_index[slot] = index;
        self.min_gain[slot] = gain;
        self.min_count += 1;
        // Drop gains that left the window (this sample and the `len` before it:
        // a peak is still held when it comes out of the delay line).
        while self.min_count > 0 && self.min_index[self.min_head] + (self.len as u64) < index {
            self.min_head = (self.min_head + 1) % cap;
            self.min_count -= 1;
        }
    }
}

impl Effect for Limiter {
    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        let mut max_reduction = 0.0f32;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            let mut in_l = *l * self.input;
            let mut in_r = *r * self.input;
            if !in_l.is_finite() || !in_r.is_finite() {
                in_l = 0.0;
                in_r = 0.0;
            }
            let level = in_l.abs().max(in_r.abs());
            let needed = if level > self.ceiling {
                self.ceiling / level
            } else {
                1.0
            };
            let index = self.counter;
            self.counter += 1;
            self.push_min(index, needed);
            let held = self.min_gain[self.min_head];

            let slot = (index % self.len as u64) as usize;
            self.avg_sum += f64::from(held) - f64::from(self.avg[slot]);
            self.avg[slot] = held;
            let smooth = ((self.avg_sum / self.len as f64) as f32).min(1.0);

            // Down at once (the ramp is already smooth), back up with the release.
            self.gain = if smooth < self.gain {
                smooth
            } else {
                flush_denormal(smooth + self.release * (self.gain - smooth))
            };

            let out_l = self.delay_l[self.pos] * self.gain;
            let out_r = self.delay_r[self.pos] * self.gain;
            self.delay_l[self.pos] = in_l;
            self.delay_r[self.pos] = in_r;
            self.pos = (self.pos + 1) % self.len;

            // The ramp reaches the needed gain exactly at the peak; rounding aside,
            // the clamp guarantees the ceiling.
            *l = out_l.clamp(-self.ceiling, self.ceiling);
            *r = out_r.clamp(-self.ceiling, self.ceiling);
            max_reduction = max_reduction.max(-gain_to_db(self.gain));
        }
        self.meter_db = max_reduction;
    }

    fn reset(&mut self) {
        self.delay_l.fill(0.0);
        self.delay_r.fill(0.0);
        self.pos = 0;
        self.min_head = 0;
        self.min_count = 0;
        self.avg.fill(1.0);
        self.avg_sum = self.len as f64;
        self.counter = 0;
        self.gain = 1.0;
        self.meter_db = 0.0;
    }

    fn update(&mut self, config: &EffectConfig) -> bool {
        let EffectConfig::Limiter(params) = config else {
            return false;
        };
        self.configure(*params);
        true
    }

    fn meter_db(&self) -> Option<f32> {
        Some(self.meter_db)
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_signals::*;
    use super::*;

    fn limit(params: LimiterParams, l: &mut [f32], r: &mut [f32]) -> Limiter {
        let mut limiter = Limiter::new(params, RATE);
        for (a, b) in l.chunks_mut(512).zip(r.chunks_mut(512)) {
            limiter.process(a, b);
        }
        limiter
    }

    #[test]
    fn never_goes_above_the_ceiling() {
        let params = LimiterParams {
            ceiling_db: -1.0,
            input_db: 12.0,
            ..Default::default()
        };
        let mut l = sine(110.0, 1.0, 48_000);
        let mut r = sine(220.0, 0.8, 48_000);
        let limiter = limit(params, &mut l, &mut r);
        let ceiling = db_to_gain(-1.0);
        assert!(peak(&l) <= ceiling + 1e-6, "{}", peak(&l));
        assert!(peak(&r) <= ceiling + 1e-6);
        // It is loud: close to the ceiling most of the time.
        assert!(rms(&l[24_000..]) > 0.6);
        assert!(limiter.meter_db > 6.0);
    }

    #[test]
    fn catches_single_sample_peaks_without_clipping_them() {
        let params = LimiterParams::default();
        let mut l = vec![0.1f32; 4_800];
        l[2_400] = 4.0;
        let mut r = l.clone();
        limit(params, &mut l, &mut r);
        let ceiling = db_to_gain(-1.0);
        assert!(peak(&l) <= ceiling + 1e-6);
        // The lookahead turned the gain down before the peak: nothing is
        // simply clamped (the sample before the peak is already quieter).
        let at = 2_400 + Limiter::new(params, RATE).latency();
        assert!(l[at] <= ceiling + 1e-6 && l[at] > 0.5 * ceiling);
        assert!(l[at - 1] < 0.1);
    }

    #[test]
    fn leaves_quiet_signals_alone_apart_from_the_delay() {
        let params = LimiterParams::default();
        let input = sine(440.0, 0.3, 4_800);
        let mut l = input.clone();
        let mut r = input.clone();
        let limiter = limit(params, &mut l, &mut r);
        let delay = limiter.latency();
        for i in delay..4_800 {
            assert!((l[i] - input[i - delay]).abs() < 1e-6);
        }
        assert_eq!(limiter.meter_db, 0.0);
    }

    #[test]
    fn recovers_with_the_release() {
        let params = LimiterParams {
            release_ms: 50.0,
            ..Default::default()
        };
        let mut l: Vec<f32> = (0..48_000)
            .map(|i| if i < 4_800 { 2.0 } else { 0.2 })
            .collect();
        let mut r = l.clone();
        limit(params, &mut l, &mut r);
        // Half a second later the quiet part is back at full level.
        assert!((l[40_000] - 0.2).abs() < 0.001);
    }

    #[test]
    fn survives_nan_infinity_and_silence() {
        let params = LimiterParams::default();
        let mut l = vec![
            f32::NAN,
            f32::INFINITY,
            1.0e-30,
            0.5,
            f32::NEG_INFINITY,
            0.0,
        ];
        let mut r = l.clone();
        let mut limiter = Limiter::new(params, RATE);
        limiter.process(&mut l, &mut r);
        assert!(all_finite(&l) && all_finite(&r));
        let mut silence = vec![0.0f32; 480_000];
        let mut other = silence.clone();
        limiter.process(&mut silence, &mut other);
        assert!(all_finite(&silence));
        assert_eq!(limiter.gain, 1.0, "the gain recovered fully");
    }

    #[test]
    fn knob_turns_keep_running() {
        let mut limiter = Limiter::new(LimiterParams::default(), RATE);
        let mut l = sine(100.0, 1.5, 4_800);
        let mut r = l.clone();
        limiter.process(&mut l, &mut r);
        let ceiling = LimiterParams {
            ceiling_db: -6.0,
            ..Default::default()
        };
        assert!(limiter.update(&EffectConfig::Limiter(ceiling)));
        let mut l = sine(100.0, 1.5, 4_800);
        let mut r = l.clone();
        limiter.process(&mut l, &mut r);
        assert!(peak(&l) <= db_to_gain(-6.0) + 1e-6);
        assert!(!limiter.update(&EffectConfig::Eq { bands: vec![] }));
    }

    #[test]
    fn clamps_its_parameters() {
        let wild = LimiterParams {
            ceiling_db: 12.0,
            release_ms: f32::NAN,
            lookahead_ms: 100.0,
            input_db: -5.0,
        }
        .clamped();
        assert_eq!(wild.ceiling_db, 0.0);
        assert_eq!(wild.release_ms, 80.0);
        assert_eq!(wild.lookahead_ms, MAX_LOOKAHEAD_MS);
        assert_eq!(wild.input_db, 0.0);
    }
}
