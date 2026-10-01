//! A built-in amp that needs no capture file: input filtering, one or two
//! gain stages (asymmetric soft clipping, like a tube triode), a passive-style
//! tone stack (bass, mid, treble), presence and a fizz filter. Three voicings
//! set the gain structure and the mid character.

use serde::{Deserialize, Serialize};

use super::biquad::{Biquad, Coefficients, FilterKind};
use super::{Effect, db_to_gain};
use crate::audio::chain::EffectConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Voicing {
    Clean,
    Crunch,
    Lead,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AmpSimParams {
    pub voicing: Voicing,
    /// 0…1.
    pub gain: f32,
    /// Tone stack, -12…12 dB each.
    pub bass_db: f32,
    pub mid_db: f32,
    pub treble_db: f32,
    /// 0…1: upper-treble lift after the gain stage.
    pub presence: f32,
    /// Output level, dB.
    pub master_db: f32,
}

impl Default for AmpSimParams {
    fn default() -> Self {
        Self {
            voicing: Voicing::Crunch,
            gain: 0.5,
            bass_db: 0.0,
            mid_db: 0.0,
            treble_db: 0.0,
            presence: 0.5,
            master_db: 0.0,
        }
    }
}

/// Filters per channel: input high-pass, pre-emphasis, bass, mid, treble,
/// presence, fizz low-pass.
const FILTERS: usize = 7;

pub struct AmpSim {
    rate: f32,
    voicing: Voicing,
    pre_gain: f32,
    out_gain: f32,
    filters: [[Biquad; FILTERS]; 2],
}

impl AmpSim {
    pub fn new(params: AmpSimParams, sample_rate: f32) -> Self {
        let mut amp = Self {
            rate: sample_rate,
            voicing: params.voicing,
            pre_gain: 1.0,
            out_gain: 1.0,
            filters: [[Biquad::default(); FILTERS]; 2],
        };
        amp.set(params);
        amp
    }

    fn set(&mut self, p: AmpSimParams) {
        let rate = self.rate;
        let gain = p.gain.clamp(0.0, 1.0);
        let tone = |db: f32| db.clamp(-12.0, 12.0);
        let (pre_db, emphasis_hz, emphasis_db, mid_hz) = match p.voicing {
            Voicing::Clean => (gain * 18.0, 1_200.0, 0.0, 600.0),
            Voicing::Crunch => (10.0 + gain * 26.0, 900.0, 4.0, 700.0),
            Voicing::Lead => (18.0 + gain * 34.0, 750.0, 6.0, 650.0),
        };
        let c = [
            Coefficients::new(FilterKind::HighPass, 80.0, 0.707, 0.0, rate),
            Coefficients::new(FilterKind::Peak, emphasis_hz, 0.7, emphasis_db, rate),
            Coefficients::new(FilterKind::LowShelf, 120.0, 0.707, tone(p.bass_db), rate),
            Coefficients::new(FilterKind::Peak, mid_hz, 0.8, tone(p.mid_db), rate),
            Coefficients::new(
                FilterKind::HighShelf,
                3_000.0,
                0.707,
                tone(p.treble_db),
                rate,
            ),
            Coefficients::new(
                FilterKind::HighShelf,
                5_000.0,
                0.707,
                p.presence.clamp(0.0, 1.0) * 9.0 - 3.0,
                rate,
            ),
            Coefficients::new(FilterKind::LowPass, 8_500.0, 0.707, 0.0, rate),
        ];
        for channel in &mut self.filters {
            for (filter, coefficients) in channel.iter_mut().zip(c) {
                filter.set(coefficients);
            }
        }
        self.voicing = p.voicing;
        self.pre_gain = db_to_gain(pre_db);
        // Take back part of the gain so a higher gain knob is not just louder.
        let compensation = if p.voicing == Voicing::Clean {
            -pre_db * 0.8
        } else {
            -pre_db * 0.45
        };
        self.out_gain = db_to_gain(p.master_db.clamp(-40.0, 12.0) + compensation);
    }

    /// Triode-like stage: the positive half clips softer than the negative.
    #[inline]
    fn stage(x: f32) -> f32 {
        if x >= 0.0 {
            x.tanh()
        } else {
            (1.3 * x).tanh() / 1.3
        }
    }
}

impl Effect for AmpSim {
    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        for (channel, samples) in [left, right].into_iter().enumerate() {
            let [hp, emphasis, bass, mid, treble, presence, fizz] = &mut self.filters[channel];
            for s in samples.iter_mut() {
                let mut x = emphasis.tick(hp.tick(*s)) * self.pre_gain;
                x = match self.voicing {
                    Voicing::Clean => x.clamp(-3.0, 3.0) * (1.0 - 0.05 * x * x).max(0.5),
                    Voicing::Crunch => Self::stage(x),
                    Voicing::Lead => Self::stage(Self::stage(x) * 3.0),
                };
                let y = treble.tick(mid.tick(bass.tick(x)));
                *s = fizz.tick(presence.tick(y)) * self.out_gain;
            }
        }
    }

    fn reset(&mut self) {
        self.filters.iter_mut().flatten().for_each(Biquad::reset);
    }

    fn update(&mut self, config: &EffectConfig) -> bool {
        match config {
            EffectConfig::AmpSim(p) => {
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

    fn run(params: AmpSimParams, input: &[f32]) -> Vec<f32> {
        let mut amp = AmpSim::new(params, RATE);
        let (mut l, mut r) = (input.to_vec(), input.to_vec());
        amp.process(&mut l, &mut r);
        assert_eq!(l, r);
        l
    }

    #[test]
    fn every_voicing_is_finite_bounded_and_audible() {
        for voicing in [Voicing::Clean, Voicing::Crunch, Voicing::Lead] {
            for gain in [0.0, 1.0] {
                let out = run(
                    AmpSimParams {
                        voicing,
                        gain,
                        ..Default::default()
                    },
                    &sine(196.0, 0.8, 48_000),
                );
                assert!(all_finite(&out), "{voicing:?}");
                assert!(peak(&out) < 2.0, "{voicing:?} {gain}: {}", peak(&out));
                assert!(rms(&out[24_000..]) > 0.005, "{voicing:?} {gain} silent");
            }
        }
    }

    #[test]
    fn lead_distorts_more_than_clean() {
        let crest = |o: &[f32]| peak(&o[24_000..]) / rms(&o[24_000..]);
        let input = sine(196.0, 0.5, 48_000);
        let clean = run(
            AmpSimParams {
                voicing: Voicing::Clean,
                gain: 0.2,
                ..Default::default()
            },
            &input,
        );
        let lead = run(
            AmpSimParams {
                voicing: Voicing::Lead,
                gain: 1.0,
                ..Default::default()
            },
            &input,
        );
        assert!(crest(&lead) < crest(&clean));
    }

    #[test]
    fn bass_knob_changes_the_low_end() {
        let input = sine(80.0, 0.05, 48_000);
        let level = |db: f32| {
            rms(&run(
                AmpSimParams {
                    voicing: Voicing::Clean,
                    gain: 0.0,
                    bass_db: db,
                    ..Default::default()
                },
                &input,
            )[24_000..])
        };
        assert!(level(12.0) > level(-12.0) * 2.0);
    }

    #[test]
    fn survives_extreme_values() {
        let out = run(
            AmpSimParams {
                gain: 99.0,
                bass_db: 1e9,
                master_db: f32::INFINITY,
                ..Default::default()
            },
            &sine(100.0, 10.0, 4_800),
        );
        assert!(all_finite(&out));
    }
}
