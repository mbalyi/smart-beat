//! Second-order filters with the standard audio-EQ formulas (shelves, peaks,
//! high/low pass), in transposed direct form II.

use std::f32::consts::PI;

use serde::{Deserialize, Serialize};

use super::flush_denormal;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterKind {
    LowShelf,
    Peak,
    HighShelf,
    HighPass,
    LowPass,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Coefficients {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
}

impl Coefficients {
    pub const IDENTITY: Self = Self {
        b0: 1.0,
        b1: 0.0,
        b2: 0.0,
        a1: 0.0,
        a2: 0.0,
    };

    /// `freq` in Hz, `q` > 0, `gain_db` used by shelves and peaks.
    pub fn new(kind: FilterKind, freq: f32, q: f32, gain_db: f32, sample_rate: f32) -> Self {
        let freq = freq.clamp(10.0, sample_rate * 0.49);
        let q = q.max(0.05);
        let w0 = 2.0 * PI * freq / sample_rate;
        let (sin, cos) = w0.sin_cos();
        let alpha = sin / (2.0 * q);
        let a = 10f32.powf(gain_db / 40.0);
        let (b0, b1, b2, a0, a1, a2) = match kind {
            FilterKind::Peak => (
                1.0 + alpha * a,
                -2.0 * cos,
                1.0 - alpha * a,
                1.0 + alpha / a,
                -2.0 * cos,
                1.0 - alpha / a,
            ),
            FilterKind::LowShelf => {
                let s = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) - (a - 1.0) * cos + s),
                    2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
                    a * ((a + 1.0) - (a - 1.0) * cos - s),
                    (a + 1.0) + (a - 1.0) * cos + s,
                    -2.0 * ((a - 1.0) + (a + 1.0) * cos),
                    (a + 1.0) + (a - 1.0) * cos - s,
                )
            }
            FilterKind::HighShelf => {
                let s = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) + (a - 1.0) * cos + s),
                    -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
                    a * ((a + 1.0) + (a - 1.0) * cos - s),
                    (a + 1.0) - (a - 1.0) * cos + s,
                    2.0 * ((a - 1.0) - (a + 1.0) * cos),
                    (a + 1.0) - (a - 1.0) * cos - s,
                )
            }
            FilterKind::HighPass => (
                (1.0 + cos) / 2.0,
                -(1.0 + cos),
                (1.0 + cos) / 2.0,
                1.0 + alpha,
                -2.0 * cos,
                1.0 - alpha,
            ),
            FilterKind::LowPass => (
                (1.0 - cos) / 2.0,
                1.0 - cos,
                (1.0 - cos) / 2.0,
                1.0 + alpha,
                -2.0 * cos,
                1.0 - alpha,
            ),
        };
        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        }
    }
}

/// One filter for one channel.
#[derive(Debug, Clone, Copy)]
pub struct Biquad {
    c: Coefficients,
    z1: f32,
    z2: f32,
}

impl Default for Biquad {
    fn default() -> Self {
        Self {
            c: Coefficients::IDENTITY,
            z1: 0.0,
            z2: 0.0,
        }
    }
}

impl Biquad {
    pub fn set(&mut self, c: Coefficients) {
        self.c = c;
    }

    #[inline]
    pub fn tick(&mut self, x: f32) -> f32 {
        let c = &self.c;
        let y = c.b0 * x + self.z1;
        self.z1 = flush_denormal(c.b1 * x - c.a1 * y + self.z2);
        self.z2 = flush_denormal(c.b2 * x - c.a2 * y);
        y
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }

    /// Takes the filter memory of `other` (to change coefficients smoothly).
    pub fn copy_state(&mut self, other: &Biquad) {
        self.z1 = other.z1;
        self.z2 = other.z2;
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_signals::*;
    use super::*;

    fn gain_at(kind: FilterKind, filter_freq: f32, gain_db: f32, test_freq: f32) -> f32 {
        let mut f = Biquad::default();
        f.set(Coefficients::new(kind, filter_freq, 0.707, gain_db, RATE));
        let input = sine(test_freq, 0.5, 48_000);
        let out: Vec<f32> = input.iter().map(|&x| f.tick(x)).collect();
        rms(&out[24_000..]) / rms(&input[24_000..])
    }

    #[test]
    fn identity_passes_signal_unchanged() {
        let mut f = Biquad::default();
        for x in [0.1, -0.5, 0.9] {
            assert_eq!(f.tick(x), x);
        }
    }

    #[test]
    fn high_pass_cuts_lows_and_keeps_highs() {
        assert!(gain_at(FilterKind::HighPass, 100.0, 0.0, 30.0) < 0.15);
        assert!((gain_at(FilterKind::HighPass, 100.0, 0.0, 2_000.0) - 1.0).abs() < 0.02);
    }

    #[test]
    fn low_pass_cuts_highs() {
        assert!(gain_at(FilterKind::LowPass, 1_000.0, 0.0, 10_000.0) < 0.02);
    }

    #[test]
    fn peak_boosts_by_its_gain_at_the_centre() {
        let g = gain_at(FilterKind::Peak, 1_000.0, 6.0, 1_000.0);
        assert!((g - 1.995).abs() < 0.03, "gain {g}");
    }

    #[test]
    fn shelves_change_their_side_only() {
        let low = gain_at(FilterKind::LowShelf, 200.0, -12.0, 40.0);
        assert!((low - 0.251).abs() < 0.03, "low shelf {low}");
        assert!((gain_at(FilterKind::LowShelf, 200.0, -12.0, 8_000.0) - 1.0).abs() < 0.03);
        let high = gain_at(FilterKind::HighShelf, 4_000.0, 6.0, 15_000.0);
        assert!((high - 1.995).abs() < 0.08, "high shelf {high}");
    }

    #[test]
    fn decays_to_exact_zero_without_denormals() {
        let mut f = Biquad::default();
        f.set(Coefficients::new(
            FilterKind::LowPass,
            500.0,
            0.707,
            0.0,
            RATE,
        ));
        f.tick(1.0);
        let mut last = 1.0;
        for _ in 0..200_000 {
            last = f.tick(0.0);
        }
        assert_eq!(last, 0.0);
    }
}
