//! Noise gate with hold and hysteresis, stereo-linked. Cuts the hiss and the
//! ringing between palm-muted chugs.

use serde::{Deserialize, Serialize};

use super::{Effect, db_to_gain, flush_denormal, time_coefficient};

/// The gate closes this many dB below the threshold, so it does not chatter.
const HYSTERESIS_DB: f32 = 4.0;
/// How fast the level detector falls (ms).
const DETECTOR_RELEASE_MS: f32 = 10.0;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GateParams {
    pub threshold_db: f32,
    /// How much a closed gate attenuates (dB, negative; -80 is silence).
    pub range_db: f32,
    pub attack_ms: f32,
    pub hold_ms: f32,
    pub release_ms: f32,
}

impl Default for GateParams {
    fn default() -> Self {
        Self {
            threshold_db: -50.0,
            range_db: -80.0,
            attack_ms: 0.5,
            hold_ms: 20.0,
            release_ms: 60.0,
        }
    }
}

pub struct Gate {
    open_level: f32,
    close_level: f32,
    floor: f32,
    attack: f32,
    release: f32,
    detector_release: f32,
    hold_samples: u32,
    envelope: f32,
    gain: f32,
    held: u32,
    open: bool,
}

impl Gate {
    pub fn new(params: GateParams, sample_rate: f32) -> Self {
        let threshold = params.threshold_db.clamp(-90.0, 0.0);
        Self {
            open_level: db_to_gain(threshold),
            close_level: db_to_gain(threshold - HYSTERESIS_DB),
            floor: db_to_gain(params.range_db.clamp(-90.0, 0.0)),
            attack: time_coefficient(params.attack_ms.clamp(0.0, 50.0), sample_rate),
            release: time_coefficient(params.release_ms.clamp(1.0, 2_000.0), sample_rate),
            detector_release: time_coefficient(DETECTOR_RELEASE_MS, sample_rate),
            hold_samples: (params.hold_ms.clamp(0.0, 500.0) * 0.001 * sample_rate) as u32,
            envelope: 0.0,
            gain: 0.0,
            held: 0,
            open: false,
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }
}

impl Effect for Gate {
    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            let level = l.abs().max(r.abs());
            self.envelope = if level > self.envelope {
                level
            } else {
                flush_denormal(level + self.detector_release * (self.envelope - level))
            };
            if self.envelope >= self.open_level {
                self.open = true;
                self.held = self.hold_samples;
            } else if self.envelope < self.close_level {
                if self.held > 0 {
                    self.held -= 1;
                } else {
                    self.open = false;
                }
            }
            let (target, coeff) = if self.open {
                (1.0, self.attack)
            } else {
                (self.floor, self.release)
            };
            self.gain = flush_denormal(target + coeff * (self.gain - target));
            *l *= self.gain;
            *r *= self.gain;
        }
    }

    fn reset(&mut self) {
        self.envelope = 0.0;
        self.gain = 0.0;
        self.held = 0;
        self.open = false;
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_signals::*;
    use super::*;

    #[test]
    fn passes_loud_notes_and_silences_hiss() {
        let mut gate = Gate::new(
            GateParams {
                threshold_db: -40.0,
                ..Default::default()
            },
            RATE,
        );
        let mut loud = sine(110.0, 0.5, 24_000);
        let mut copy = loud.clone();
        gate.process(&mut loud, &mut copy);
        assert!(gate.is_open());
        assert!((peak(&loud[12_000..]) - 0.5).abs() < 0.01);

        let mut hiss = sine(3_000.0, 0.001, 48_000); // -60 dB
        let mut copy = hiss.clone();
        gate.process(&mut hiss, &mut copy);
        assert!(!gate.is_open());
        assert!(peak(&hiss[40_000..]) < 1.0e-6);
    }

    #[test]
    fn hold_keeps_it_open_briefly() {
        let params = GateParams {
            threshold_db: -40.0,
            hold_ms: 100.0,
            ..Default::default()
        };
        let mut gate = Gate::new(params, RATE);
        let mut burst = sine(200.0, 0.5, 4_800);
        let mut copy = burst.clone();
        gate.process(&mut burst, &mut copy);
        let mut quiet = vec![0.0; 2_400]; // 50 ms, inside the hold time
        let mut copy = quiet.clone();
        gate.process(&mut quiet, &mut copy);
        assert!(gate.is_open());
    }

    #[test]
    fn reset_closes_it_and_output_stays_finite() {
        let mut gate = Gate::new(GateParams::default(), RATE);
        let mut x = sine(100.0, 1.0, 1_000);
        let mut y = x.clone();
        gate.process(&mut x, &mut y);
        gate.reset();
        assert!(!gate.is_open());
        assert!(all_finite(&x));
    }
}
