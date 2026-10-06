//! Streaming sample-rate conversion for blocks that only run at one rate
//! (a Neural Amp Modeler capture is tied to the rate it was recorded at).
//!
//! The converter reads its input through the same band-limited interpolator
//! (windowed sinc) the audio track uses, so converting down does not alias.
//! It works on one block at a time, keeps its state between blocks and does
//! not allocate while running as long as it was created for the largest block
//! it will be given.

use super::super::backing::Interpolator;

/// Input samples the interpolator looks ahead (and so the delay of one converter).
const LOOK_AHEAD: usize = 8;
/// Input samples the interpolator looks behind.
const LOOK_BEHIND: usize = 7;

pub struct StreamResampler {
    interpolator: Interpolator,
    /// Input samples advanced per output sample (`from / to`).
    step: f64,
    /// Input still needed for the next outputs.
    history: Vec<f32>,
    /// Where the next output sits in `history` (in input samples).
    position: f64,
}

impl StreamResampler {
    /// A converter from `from` to `to` (Hz) for input blocks of up to `max_input` samples.
    pub fn new(from: f32, to: f32, max_input: usize) -> Self {
        let step = f64::from(from) / f64::from(to);
        Self {
            interpolator: Interpolator::new(step),
            step,
            history: Vec::with_capacity(max_input + 4 * (LOOK_AHEAD + LOOK_BEHIND) + 8),
            position: 0.0,
        }
    }

    /// The most samples that `input_len` input samples can produce (for sizing buffers).
    pub fn max_output(from: f32, to: f32, input_len: usize) -> usize {
        (input_len as f64 * f64::from(to) / f64::from(from)).ceil() as usize + 4
    }

    /// Converts `input`, writing to `output`; returns how many samples were
    /// written. Input that does not fit stays inside for the next call.
    pub fn process(&mut self, input: &[f32], output: &mut [f32]) -> usize {
        self.history.extend_from_slice(input);
        let len = self.history.len();
        let mut written = 0;
        while written < output.len() {
            let base = self.position.floor() as usize;
            if base + LOOK_AHEAD >= len {
                break;
            }
            output[written] = self.interpolator.read(&self.history, self.position);
            written += 1;
            self.position += self.step;
        }
        // Forget what is no longer needed.
        let keep_from = (self.position.floor() as usize).saturating_sub(LOOK_BEHIND);
        if keep_from > 0 {
            self.history.drain(..keep_from);
            self.position -= keep_from as f64;
        }
        written
    }

    pub fn reset(&mut self) {
        self.history.clear();
        self.position = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use std::f32::consts::TAU;

    use super::*;

    fn sine(freq: f32, rate: f32, frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|i| 0.5 * (TAU * freq * i as f32 / rate).sin())
            .collect()
    }

    /// Converts in blocks of 64, like the audio callback.
    fn convert(input: &[f32], from: f32, to: f32) -> Vec<f32> {
        let mut resampler = StreamResampler::new(from, to, 64);
        let mut out = Vec::new();
        let mut buffer = vec![0.0; StreamResampler::max_output(from, to, 64)];
        for block in input.chunks(64) {
            let n = resampler.process(block, &mut buffer);
            out.extend_from_slice(&buffer[..n]);
        }
        out
    }

    #[test]
    fn keeps_a_tone_at_the_right_pitch_and_level() {
        // 440 Hz: 44.1 kHz -> 48 kHz must still be 440 Hz.
        let out = convert(&sine(440.0, 44_100.0, 8_820), 44_100.0, 48_000.0);
        let expected = sine(440.0, 48_000.0, out.len());
        // Skip the start (filter delay), compare after aligning the tiny delay.
        let skip = 200;
        let delay_best = (0..=16)
            .map(|d: usize| {
                let err: f32 = (skip..out.len() - 20)
                    .map(|i| (out[i] - expected[i - d.min(i)]).abs())
                    .sum::<f32>();
                (err / (out.len() - 20 - skip) as f32, d)
            })
            .fold((f32::MAX, 0), |a, b| if b.0 < a.0 { b } else { a });
        assert!(delay_best.0 < 0.01, "mean error {delay_best:?}");
    }

    #[test]
    fn produces_the_expected_number_of_samples() {
        let out = convert(&vec![0.1; 48_000], 48_000.0, 44_100.0);
        assert!((out.len() as i64 - 44_100).abs() < 20, "{}", out.len());
        let out = convert(&vec![0.1; 44_100], 44_100.0, 48_000.0);
        assert!((out.len() as i64 - 48_000).abs() < 20, "{}", out.len());
    }

    #[test]
    fn going_down_removes_what_would_alias() {
        // 15 kHz at 48 kHz is above half of 22.05 kHz / 2: it must not fold back.
        let out = convert(&sine(15_000.0, 48_000.0, 9_600), 48_000.0, 22_050.0);
        let rms = (out[200..].iter().map(|s| s * s).sum::<f32>() / (out.len() - 200) as f32).sqrt();
        assert!(rms < 0.05, "aliased energy {rms}");
    }

    #[test]
    fn does_not_depend_on_the_block_size() {
        let input = sine(330.0, 44_100.0, 4_410);
        let small = convert(&input, 44_100.0, 48_000.0);
        let mut resampler = StreamResampler::new(44_100.0, 48_000.0, 4_410);
        let mut big = vec![0.0; StreamResampler::max_output(44_100.0, 48_000.0, 4_410)];
        let n = resampler.process(&input, &mut big);
        assert!(n.abs_diff(small.len()) <= 1);
        for i in 0..n.min(small.len()) {
            assert!((big[i] - small[i]).abs() < 1e-4, "sample {i}");
        }
    }

    #[test]
    fn reset_forgets_the_past() {
        let mut resampler = StreamResampler::new(44_100.0, 48_000.0, 64);
        let mut buffer = vec![0.0; 128];
        resampler.process(&[1.0; 64], &mut buffer);
        resampler.reset();
        let n = resampler.process(&[0.0; 64], &mut buffer);
        assert!(buffer[..n].iter().all(|s| *s == 0.0));
    }
}
