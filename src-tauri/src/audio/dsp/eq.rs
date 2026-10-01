//! Parametric EQ: up to [`MAX_BANDS`] filters in series (enough for a 10-band
//! graphic EQ plus high and low pass).

use serde::{Deserialize, Serialize};

use super::Effect;
use super::biquad::{Biquad, Coefficients, FilterKind};

pub const MAX_BANDS: usize = 12;
/// Boost or cut limit of a band, in dB.
pub const MAX_GAIN_DB: f32 = 24.0;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Band {
    pub kind: FilterKind,
    pub freq: f32,
    #[serde(default = "default_q")]
    pub q: f32,
    #[serde(default)]
    pub gain_db: f32,
}

fn default_q() -> f32 {
    0.707
}

/// The ten octave bands of a graphic EQ (31 Hz to 16 kHz), flat.
pub fn graphic_bands() -> Vec<Band> {
    [
        31.0, 62.0, 125.0, 250.0, 500.0, 1_000.0, 2_000.0, 4_000.0, 8_000.0, 16_000.0,
    ]
    .into_iter()
    .map(|freq| Band {
        kind: FilterKind::Peak,
        freq,
        q: 1.41,
        gain_db: 0.0,
    })
    .collect()
}

pub struct Eq {
    bands: Vec<(Biquad, Biquad)>,
}

impl Eq {
    pub fn new(bands: &[Band], sample_rate: f32) -> Self {
        let bands = bands
            .iter()
            .take(MAX_BANDS)
            .map(|band| {
                let c = Coefficients::new(
                    band.kind,
                    band.freq,
                    band.q,
                    band.gain_db.clamp(-MAX_GAIN_DB, MAX_GAIN_DB),
                    sample_rate,
                );
                let mut l = Biquad::default();
                l.set(c);
                (l, l)
            })
            .collect();
        Self { bands }
    }
}

impl Effect for Eq {
    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        for (l, r) in &mut self.bands {
            for s in left.iter_mut() {
                *s = l.tick(*s);
            }
            for s in right.iter_mut() {
                *s = r.tick(*s);
            }
        }
    }

    fn reset(&mut self) {
        for (l, r) in &mut self.bands {
            l.reset();
            r.reset();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_signals::*;
    use super::*;

    #[test]
    fn flat_graphic_eq_keeps_the_level() {
        let mut eq = Eq::new(&graphic_bands(), RATE);
        let mut l = sine(1_000.0, 0.5, 48_000);
        let mut r = l.clone();
        eq.process(&mut l, &mut r);
        assert!((rms(&l[24_000..]) / 0.3536 - 1.0).abs() < 0.02);
        assert_eq!(l, r);
    }

    #[test]
    fn high_pass_band_removes_rumble() {
        let bands = [Band {
            kind: FilterKind::HighPass,
            freq: 90.0,
            q: 0.707,
            gain_db: 0.0,
        }];
        let mut eq = Eq::new(&bands, RATE);
        let mut l = sine(25.0, 0.5, 48_000);
        let mut r = l.clone();
        eq.process(&mut l, &mut r);
        assert!(rms(&l[24_000..]) < 0.03);
    }

    #[test]
    fn clamps_extreme_gain_and_stays_finite() {
        let bands = [Band {
            kind: FilterKind::Peak,
            freq: 1_000.0,
            q: 0.01,
            gain_db: 500.0,
        }];
        let mut eq = Eq::new(&bands, RATE);
        let mut l = sine(1_000.0, 0.5, 4_800);
        let mut r = l.clone();
        eq.process(&mut l, &mut r);
        assert!(all_finite(&l));
        assert!(peak(&l) < 0.5 * 16.0 * 1.1);
    }
}
