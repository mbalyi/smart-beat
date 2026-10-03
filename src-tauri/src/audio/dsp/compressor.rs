//! Feed-forward compressor / limiter with a soft knee, stereo-linked.

use serde::{Deserialize, Serialize};

use super::{Effect, db_to_gain, flush_denormal, gain_to_db, time_coefficient};
use crate::audio::chain::EffectConfig;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CompressorParams {
    /// Level above which the gain is reduced (dBFS, -60…0).
    pub threshold_db: f32,
    /// 1 (off) to 20; 20 behaves as a limiter.
    pub ratio: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
    /// Gain added after compression (0…24 dB).
    pub makeup_db: f32,
    /// Width of the soft knee (0 = hard knee, up to 24 dB).
    pub knee_db: f32,
    /// Share of the compressed signal (1 = fully compressed; below 1 = parallel compression).
    pub mix: f32,
}

impl Default for CompressorParams {
    fn default() -> Self {
        Self {
            threshold_db: -18.0,
            ratio: 4.0,
            attack_ms: 10.0,
            release_ms: 120.0,
            makeup_db: 0.0,
            knee_db: 6.0,
            mix: 1.0,
        }
    }
}

impl CompressorParams {
    fn clamped(self) -> Self {
        Self {
            threshold_db: self.threshold_db.clamp(-60.0, 0.0),
            ratio: self.ratio.clamp(1.0, 20.0),
            attack_ms: self.attack_ms.clamp(0.0, 200.0),
            release_ms: self.release_ms.clamp(1.0, 2_000.0),
            makeup_db: self.makeup_db.clamp(0.0, 24.0),
            knee_db: self.knee_db.clamp(0.0, 24.0),
            mix: self.mix.clamp(0.0, 1.0),
        }
    }

    /// Gain reduction (dB, ≥ 0) for an input level.
    pub fn reduction_db(&self, level_db: f32) -> f32 {
        let over = level_db - self.threshold_db;
        let slope = 1.0 - 1.0 / self.ratio;
        let half = self.knee_db / 2.0;
        if self.knee_db > 0.0 && over.abs() <= half {
            slope * (over + half).powi(2) / (2.0 * self.knee_db)
        } else if over > 0.0 {
            slope * over
        } else {
            0.0
        }
    }
}

/// Makeup gain and mix glide over about this long after a knob turn.
const GLIDE_MS: f32 = 10.0;

pub struct Compressor {
    rate: f32,
    params: CompressorParams,
    attack: f32,
    release: f32,
    makeup: f32,
    /// Makeup gain and mix as heard (they glide to the knob values, no zipper noise).
    makeup_now: f32,
    mix_now: f32,
    /// Glide coefficient for makeup and mix.
    glide: f32,
    /// Smoothed gain reduction in dB.
    reduction: f32,
    /// Largest reduction in the last block (for the meter).
    pub meter_db: f32,
}

impl Compressor {
    pub fn new(params: CompressorParams, sample_rate: f32) -> Self {
        let params = params.clamped();
        Self {
            rate: sample_rate,
            params,
            attack: time_coefficient(params.attack_ms, sample_rate),
            release: time_coefficient(params.release_ms, sample_rate),
            makeup: db_to_gain(params.makeup_db),
            makeup_now: db_to_gain(params.makeup_db),
            mix_now: params.mix,
            glide: time_coefficient(GLIDE_MS, sample_rate),
            reduction: 0.0,
            meter_db: 0.0,
        }
    }
}

impl Effect for Compressor {
    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        let p = self.params;
        let mut max_reduction = 0.0f32;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            let peak = l.abs().max(r.abs());
            // NaN or infinity must not stick in the envelope.
            let level = gain_to_db(if peak.is_finite() { peak } else { 0.0 });
            let target = p.reduction_db(level);
            let coeff = if target > self.reduction {
                self.attack
            } else {
                self.release
            };
            self.reduction = flush_denormal(target + coeff * (self.reduction - target));
            max_reduction = max_reduction.max(self.reduction);
            self.makeup_now = self.makeup + self.glide * (self.makeup_now - self.makeup);
            self.mix_now = p.mix + self.glide * (self.mix_now - p.mix);
            let gain = db_to_gain(-self.reduction) * self.makeup_now;
            let wet = self.mix_now;
            *l *= wet * gain + (1.0 - wet);
            *r *= wet * gain + (1.0 - wet);
        }
        self.meter_db = max_reduction;
    }

    fn reset(&mut self) {
        self.reduction = 0.0;
        self.meter_db = 0.0;
    }

    fn update(&mut self, config: &EffectConfig) -> bool {
        let EffectConfig::Compressor(params) = config else {
            return false;
        };
        *self = Self {
            reduction: self.reduction,
            makeup_now: self.makeup_now,
            mix_now: self.mix_now,
            ..Self::new(*params, self.rate)
        };
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

    fn run(params: CompressorParams, amplitude: f32) -> (Vec<f32>, f32) {
        let mut c = Compressor::new(params, RATE);
        let mut l = sine(200.0, amplitude, 48_000);
        let mut r = l.clone();
        c.process(&mut l, &mut r);
        (l, c.meter_db)
    }

    #[test]
    fn leaves_quiet_signals_alone() {
        let params = CompressorParams {
            threshold_db: -6.0,
            knee_db: 0.0,
            ..Default::default()
        };
        let (out, meter) = run(params, 0.1);
        assert!((peak(&out) - 0.1).abs() < 0.001);
        assert_eq!(meter, 0.0);
    }

    #[test]
    fn reduces_loud_signals_by_the_ratio() {
        // 0 dBFS peak, threshold -20 dB, ratio 4:1 → 15 dB of reduction at peaks.
        let params = CompressorParams {
            threshold_db: -20.0,
            ratio: 4.0,
            knee_db: 0.0,
            attack_ms: 0.0,
            ..Default::default()
        };
        let (out, meter) = run(params, 1.0);
        assert!((meter - 15.0).abs() < 0.2, "meter {meter}");
        assert!(peak(&out[24_000..]) < db_to_gain(-14.0));
    }

    #[test]
    fn soft_knee_is_continuous() {
        let p = CompressorParams {
            threshold_db: -20.0,
            ratio: 4.0,
            knee_db: 6.0,
            ..Default::default()
        };
        assert_eq!(p.reduction_db(-23.0), 0.0);
        assert!((p.reduction_db(-17.0) - 0.75 * 3.0).abs() < 1e-4);
        assert!(p.reduction_db(-20.0) > 0.0);
    }

    #[test]
    fn makeup_gain_and_parallel_mix() {
        let dry = CompressorParams {
            ratio: 1.0,
            makeup_db: 6.0,
            ..Default::default()
        };
        let (out, _) = run(dry, 0.25);
        assert!((peak(&out) - 0.25 * db_to_gain(6.0)).abs() < 0.01);
        let parallel = CompressorParams {
            mix: 0.0,
            threshold_db: -40.0,
            ..Default::default()
        };
        let (out, _) = run(parallel, 0.5);
        assert!((peak(&out) - 0.5).abs() < 0.001);
    }

    #[test]
    fn survives_silence_and_garbage_parameters() {
        let params = CompressorParams {
            ratio: f32::INFINITY,
            attack_ms: -5.0,
            ..Default::default()
        };
        let (out, _) = run(params, 0.0);
        assert!(all_finite(&out));
        assert!(out.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn makeup_gain_glides_after_a_knob_turn() {
        let mut c = Compressor::new(
            CompressorParams {
                ratio: 1.0,
                ..Default::default()
            },
            RATE,
        );
        let (mut l, mut r) = (vec![0.25f32; 480], vec![0.25f32; 480]);
        c.process(&mut l, &mut r);
        assert!(c.update(&EffectConfig::Compressor(CompressorParams {
            ratio: 1.0,
            makeup_db: 12.0,
            ..Default::default()
        })));
        let (mut l, mut r) = (vec![0.25f32; 4_800], vec![0.25f32; 4_800]);
        c.process(&mut l, &mut r);
        let step = l
            .windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0, f32::max);
        assert!(step < 0.01, "zipper step {step}");
        assert!((l.last().unwrap() - 0.25 * db_to_gain(12.0)).abs() < 1e-3);
    }

    #[test]
    fn survives_nan_and_infinity() {
        let mut c = Compressor::new(CompressorParams::default(), RATE);
        let mut l = vec![f32::NAN, f32::INFINITY, 0.5, 0.5];
        let mut r = l.clone();
        c.process(&mut l, &mut r);
        assert!(c.meter_db.is_finite());
        let (mut l, mut r) = (sine(100.0, 0.5, 4_800), sine(100.0, 0.5, 4_800));
        c.process(&mut l, &mut r);
        assert!(all_finite(&l) && all_finite(&r), "the envelope recovered");
    }

    #[test]
    fn its_state_settles_to_zero_in_silence() {
        let mut c = Compressor::new(CompressorParams::default(), RATE);
        let (mut l, mut r) = (vec![1.0f32; 4_800], vec![1.0f32; 4_800]);
        c.process(&mut l, &mut r);
        let (mut l, mut r) = (vec![0.0f32; 480_000], vec![0.0f32; 480_000]);
        c.process(&mut l, &mut r);
        assert_eq!(c.reduction, 0.0, "no denormals left behind");
    }
}
