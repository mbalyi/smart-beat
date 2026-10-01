//! Effect DSP written for Smart Beat (no third-party DSP code): noise gate,
//! compressor, EQ, drive, a built-in amp, modulation, delay and reverb. Every effect is stereo-linked, processes blocks of
//! samples in place and never allocates while processing.

pub mod amp_sim;
pub mod biquad;
pub mod compressor;
pub mod convolver;
pub mod delay;
pub mod drive;
pub mod eq;
pub mod gate;
pub mod modulation;
pub mod reverb;

/// Smallest level treated as sound; anything below is flushed to zero so the
/// filters never run on denormal numbers (they are very slow on some CPUs).
pub const DENORMAL_LIMIT: f32 = 1.0e-20;

#[inline]
pub fn flush_denormal(value: f32) -> f32 {
    if value.abs() < DENORMAL_LIMIT {
        0.0
    } else {
        value
    }
}

#[inline]
pub fn db_to_gain(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

/// Gain in decibels, with silence clamped to -120 dB.
#[inline]
pub fn gain_to_db(gain: f32) -> f32 {
    20.0 * gain.max(1.0e-6).log10()
}

/// Coefficient of a one-pole smoother that reaches ~63% of a step in `ms`.
#[inline]
pub fn time_coefficient(ms: f32, sample_rate: f32) -> f32 {
    if ms <= 0.0 {
        return 0.0;
    }
    (-1.0 / (ms * 0.001 * sample_rate)).exp()
}

/// An audio effect working in place on a stereo block.
pub trait Effect: Send {
    fn process(&mut self, left: &mut [f32], right: &mut [f32]);
    /// Forgets all state (after a seek or when playback stops).
    fn reset(&mut self);
    /// Takes new parameters while running (a knob turn), keeping the state so
    /// nothing clicks. Returns false if `config` is another kind of block, or
    /// a change that needs the block to be rebuilt.
    fn update(&mut self, _config: &crate::audio::chain::EffectConfig) -> bool {
        false
    }
}

#[cfg(test)]
pub(crate) mod test_signals {
    use std::f32::consts::TAU;

    pub const RATE: f32 = 48_000.0;

    pub fn sine(freq: f32, amplitude: f32, frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|i| amplitude * (TAU * freq * i as f32 / RATE).sin())
            .collect()
    }

    pub fn peak(samples: &[f32]) -> f32 {
        samples.iter().fold(0.0f32, |acc, s| acc.max(s.abs()))
    }

    pub fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32).sqrt()
    }

    pub fn all_finite(samples: &[f32]) -> bool {
        samples.iter().all(|s| s.is_finite())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_decibels_both_ways() {
        assert!((db_to_gain(-6.0) - 0.501).abs() < 0.001);
        assert!((gain_to_db(0.5) + 6.02).abs() < 0.01);
        assert_eq!(gain_to_db(0.0), -120.0);
    }

    #[test]
    fn flushes_tiny_values() {
        assert_eq!(flush_denormal(1.0e-30), 0.0);
        assert_eq!(flush_denormal(0.25), 0.25);
    }

    #[test]
    fn time_coefficient_is_zero_for_instant_and_below_one_otherwise() {
        assert_eq!(time_coefficient(0.0, 48_000.0), 0.0);
        let c = time_coefficient(10.0, 48_000.0);
        assert!(c > 0.99 && c < 1.0);
    }
}
