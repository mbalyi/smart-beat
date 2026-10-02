//! Boost, overdrive, distortion and fuzz: a high pass that tightens the low
//! end, a waveshaper and a tone control. The overdrive is a tube-screamer style
//! mid-hump boost, the usual "tighten before the amp" pedal in metal.

use serde::{Deserialize, Serialize};

use super::biquad::{Biquad, Coefficients, FilterKind};
use super::{Effect, db_to_gain};
use crate::audio::chain::EffectConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DriveMode {
    Boost,
    Overdrive,
    Distortion,
    Fuzz,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DriveParams {
    pub mode: DriveMode,
    /// 0…1.
    pub drive: f32,
    /// 0 (dark) … 1 (bright).
    pub tone: f32,
    /// Output level, dB.
    pub level_db: f32,
    /// High-pass before the clipping (Hz); higher is tighter.
    pub tight_hz: f32,
}

impl Default for DriveParams {
    fn default() -> Self {
        Self {
            mode: DriveMode::Overdrive,
            drive: 0.3,
            tone: 0.5,
            level_db: 0.0,
            tight_hz: 120.0,
        }
    }
}

pub struct Drive {
    rate: f32,
    mode: DriveMode,
    pre_gain: f32,
    out_gain: f32,
    filters: [[Biquad; 3]; 2],
}

impl Drive {
    pub fn new(params: DriveParams, sample_rate: f32) -> Self {
        let drive = params.drive.clamp(0.0, 1.0);
        let pre_db = match params.mode {
            DriveMode::Boost => drive * 20.0,
            DriveMode::Overdrive => 6.0 + drive * 30.0,
            DriveMode::Distortion => 12.0 + drive * 36.0,
            DriveMode::Fuzz => 20.0 + drive * 40.0,
        };
        // Clipping raises the level: take some of it back so the bypass
        // switch does not jump in loudness.
        let compensation = match params.mode {
            DriveMode::Boost => 0.0,
            _ => -pre_db * 0.5,
        };
        let tight = Coefficients::new(
            FilterKind::HighPass,
            params.tight_hz.clamp(20.0, 1_000.0),
            0.707,
            0.0,
            sample_rate,
        );
        let mid = match params.mode {
            DriveMode::Overdrive => {
                Coefficients::new(FilterKind::Peak, 720.0, 0.8, 6.0, sample_rate)
            }
            _ => Coefficients::IDENTITY,
        };
        let tone_hz = 1_500.0 + params.tone.clamp(0.0, 1.0) * 8_500.0;
        let tone = Coefficients::new(FilterKind::LowPass, tone_hz, 0.707, 0.0, sample_rate);
        let mut chain = [Biquad::default(); 3];
        chain[0].set(tight);
        chain[1].set(mid);
        chain[2].set(tone);
        Self {
            rate: sample_rate,
            mode: params.mode,
            pre_gain: db_to_gain(pre_db),
            out_gain: db_to_gain(params.level_db.clamp(-40.0, 24.0) + compensation),
            filters: [chain, chain],
        }
    }

    #[inline]
    fn shape(mode: DriveMode, x: f32) -> f32 {
        match mode {
            DriveMode::Boost => x.clamp(-1.0, 1.0),
            DriveMode::Overdrive => x.tanh(),
            // Asymmetric: the positive half clips harder, like a diode pair.
            DriveMode::Distortion => {
                if x >= 0.0 {
                    (1.4 * x).tanh() / 1.4f32.tanh()
                } else {
                    x.tanh()
                }
            }
            DriveMode::Fuzz => (x * 2.0).clamp(-1.0, 1.0),
        }
    }
}

impl Effect for Drive {
    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        for (channel, samples) in [left, right].into_iter().enumerate() {
            let [tight, mid, tone] = &mut self.filters[channel];
            for s in samples.iter_mut() {
                let x = mid.tick(tight.tick(*s)) * self.pre_gain;
                *s = tone.tick(Self::shape(self.mode, x)) * self.out_gain;
            }
        }
    }

    fn reset(&mut self) {
        for f in self.filters.iter_mut().flatten() {
            f.reset();
        }
    }

    fn update(&mut self, config: &EffectConfig) -> bool {
        let EffectConfig::Drive(params) = config else {
            return false;
        };
        let next = Self::new(*params, self.rate);
        for (old, new) in self
            .filters
            .iter_mut()
            .flatten()
            .zip(next.filters.iter().flatten())
        {
            // Keep the filter state, take the new coefficients.
            let mut updated = *new;
            updated.copy_state(old);
            *old = updated;
        }
        self.mode = next.mode;
        self.pre_gain = next.pre_gain;
        self.out_gain = next.out_gain;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_signals::*;
    use super::*;

    fn run(params: DriveParams) -> Vec<f32> {
        let mut d = Drive::new(params, RATE);
        let mut l = sine(220.0, 0.5, 48_000);
        let mut r = l.clone();
        d.process(&mut l, &mut r);
        l
    }

    #[test]
    fn every_mode_is_bounded_and_finite() {
        for mode in [
            DriveMode::Boost,
            DriveMode::Overdrive,
            DriveMode::Distortion,
            DriveMode::Fuzz,
        ] {
            let out = run(DriveParams {
                mode,
                drive: 1.0,
                ..Default::default()
            });
            assert!(all_finite(&out), "{mode:?}");
            assert!(peak(&out) < 2.0, "{mode:?}: {}", peak(&out));
            assert!(rms(&out[24_000..]) > 0.01, "{mode:?} is silent");
        }
    }

    #[test]
    fn more_drive_adds_harmonics() {
        // Squarer waves have a crest factor (peak / rms) closer to 1.
        let crest = |out: &[f32]| peak(&out[24_000..]) / rms(&out[24_000..]);
        let soft = run(DriveParams {
            drive: 0.0,
            tone: 1.0,
            ..Default::default()
        });
        let hard = run(DriveParams {
            drive: 1.0,
            tone: 1.0,
            ..Default::default()
        });
        assert!(crest(&hard) < crest(&soft));
    }

    #[test]
    fn tight_filter_removes_low_end() {
        let mut d = Drive::new(
            DriveParams {
                mode: DriveMode::Boost,
                drive: 0.0,
                tight_hz: 400.0,
                ..Default::default()
            },
            RATE,
        );
        let mut l = sine(50.0, 0.5, 48_000);
        let mut r = l.clone();
        d.process(&mut l, &mut r);
        assert!(rms(&l[24_000..]) < 0.03);
    }
}
