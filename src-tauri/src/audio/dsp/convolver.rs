//! Cabinet simulation: convolution with a mono impulse response, by uniformly
//! partitioned FFT convolution (overlap-save). Adds [`PARTITION`] samples of
//! latency.

use std::sync::Arc;

use realfft::num_complex::Complex32;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};

use super::{Effect, flush_denormal};

pub const PARTITION: usize = 128;
const FFT_SIZE: usize = PARTITION * 2;
const BINS: usize = PARTITION + 1;
/// Longest impulse response used (about 1.4 s at 48 kHz); the rest is cut.
pub const MAX_IR_SAMPLES: usize = 1 << 16;

/// The spectra of an impulse response, cut into partitions. Shared by both
/// channels and every instance that uses the same IR.
pub struct IrSpectrum {
    partitions: Vec<Vec<Complex32>>,
}

impl IrSpectrum {
    /// `ir` must already be at the engine's sample rate. Normalised so the
    /// loudest frequency has unity gain, so cabinets do not jump in volume.
    pub fn new(ir: &[f32]) -> Self {
        let ir = &ir[..ir.len().min(MAX_IR_SAMPLES)];
        let mut planner = RealFftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        let mut partitions: Vec<Vec<Complex32>> = ir
            .chunks(PARTITION)
            .map(|chunk| {
                let mut input = vec![0.0; FFT_SIZE];
                input[..chunk.len()].copy_from_slice(chunk);
                let mut spectrum = fft.make_output_vec();
                fft.process(&mut input, &mut spectrum)
                    .expect("fixed FFT sizes");
                spectrum
            })
            .collect();
        if partitions.is_empty() {
            let mut unit = vec![Complex32::new(0.0, 0.0); BINS];
            unit.iter_mut().for_each(|c| *c = Complex32::new(1.0, 0.0));
            partitions.push(unit);
        }
        // Normalise by the largest magnitude of the summed response.
        let mut total = vec![Complex32::new(0.0, 0.0); BINS];
        for p in &partitions {
            for (t, c) in total.iter_mut().zip(p) {
                *t += *c;
            }
        }
        let peak = total.iter().map(|c| c.norm()).fold(0.0f32, f32::max);
        if peak > 1.0e-9 {
            let scale = 1.0 / peak;
            for p in &mut partitions {
                p.iter_mut().for_each(|c| *c *= scale);
            }
        }
        Self { partitions }
    }

    pub fn len(&self) -> usize {
        self.partitions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.partitions.is_empty()
    }
}

struct Channel {
    /// Last two partitions of input (overlap-save frame).
    frame: Vec<f32>,
    /// Frequency-domain delay line: spectra of past input frames, newest at `head`.
    history: Vec<Vec<Complex32>>,
    head: usize,
    output: Vec<f32>,
}

pub struct Convolver {
    ir: Arc<IrSpectrum>,
    forward: Arc<dyn RealToComplex<f32>>,
    inverse: Arc<dyn ComplexToReal<f32>>,
    channels: [Channel; 2],
    /// Samples gathered for the next partition / position in the output.
    filled: usize,
    scratch_in: Vec<f32>,
    scratch_spectrum: Vec<Complex32>,
    accumulator: Vec<Complex32>,
    scratch_out: Vec<f32>,
}

impl Convolver {
    pub fn new(ir: Arc<IrSpectrum>) -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let forward = planner.plan_fft_forward(FFT_SIZE);
        let inverse = planner.plan_fft_inverse(FFT_SIZE);
        let channel = || Channel {
            frame: vec![0.0; FFT_SIZE],
            history: vec![vec![Complex32::new(0.0, 0.0); BINS]; ir.len()],
            head: 0,
            output: vec![0.0; PARTITION],
        };
        Self {
            channels: [channel(), channel()],
            scratch_in: forward.make_input_vec(),
            scratch_spectrum: forward.make_output_vec(),
            accumulator: inverse.make_input_vec(),
            scratch_out: inverse.make_output_vec(),
            forward,
            inverse,
            ir,
            filled: 0,
        }
    }

    fn convolve_partition(&mut self, index: usize) {
        let ch = &mut self.channels[index];
        self.scratch_in.copy_from_slice(&ch.frame);
        self.forward
            .process(&mut self.scratch_in, &mut self.scratch_spectrum)
            .expect("fixed FFT sizes");
        let len = ch.history.len();
        ch.head = (ch.head + len - 1) % len;
        ch.history[ch.head].copy_from_slice(&self.scratch_spectrum);
        self.accumulator
            .iter_mut()
            .for_each(|c| *c = Complex32::new(0.0, 0.0));
        for (p, h) in self.ir.partitions.iter().enumerate() {
            let x = &ch.history[(ch.head + p) % len];
            for ((acc, a), b) in self.accumulator.iter_mut().zip(x).zip(h) {
                *acc += a * b;
            }
        }
        // A real signal's DC and Nyquist bins must have no imaginary part.
        self.accumulator[0].im = 0.0;
        self.accumulator[BINS - 1].im = 0.0;
        self.inverse
            .process(&mut self.accumulator, &mut self.scratch_out)
            .expect("fixed FFT sizes");
        let scale = 1.0 / FFT_SIZE as f32;
        for (o, s) in ch.output.iter_mut().zip(&self.scratch_out[PARTITION..]) {
            *o = flush_denormal(s * scale);
        }
        ch.frame.copy_within(PARTITION.., 0);
    }
}

impl Effect for Convolver {
    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        for i in 0..left.len() {
            let pos = PARTITION + self.filled;
            self.channels[0].frame[pos] = left[i];
            self.channels[1].frame[pos] = right[i];
            left[i] = self.channels[0].output[self.filled];
            right[i] = self.channels[1].output[self.filled];
            self.filled += 1;
            if self.filled == PARTITION {
                self.filled = 0;
                self.convolve_partition(0);
                self.convolve_partition(1);
            }
        }
    }

    fn reset(&mut self) {
        for ch in &mut self.channels {
            ch.frame.iter_mut().for_each(|s| *s = 0.0);
            ch.output.iter_mut().for_each(|s| *s = 0.0);
            for spectrum in &mut ch.history {
                spectrum
                    .iter_mut()
                    .for_each(|c| *c = Complex32::new(0.0, 0.0));
            }
        }
        self.filled = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_signals::*;
    use super::*;

    fn run(ir: &[f32], input: &[f32]) -> Vec<f32> {
        let mut c = Convolver::new(Arc::new(IrSpectrum::new(ir)));
        let mut l = input.to_vec();
        let mut r = input.to_vec();
        // Odd block sizes on purpose: the convolver buffers internally.
        for (lb, rb) in l.chunks_mut(37).zip(r.chunks_mut(37)) {
            c.process(lb, rb);
        }
        assert_eq!(l, r);
        l
    }

    #[test]
    fn unit_impulse_delays_by_one_partition() {
        let input = sine(500.0, 0.5, 4_000);
        let out = run(&[1.0], &input);
        for i in 0..1_000 {
            assert!((out[i + PARTITION] - input[i]).abs() < 1.0e-4, "sample {i}");
        }
    }

    #[test]
    fn matches_direct_convolution_for_a_multi_partition_ir() {
        let ir: Vec<f32> = (0..300)
            .map(|i| (-(i as f32) / 40.0).exp() * if i % 2 == 0 { 1.0 } else { -0.5 })
            .collect();
        let input = sine(300.0, 0.3, 2_000);
        let out = run(&ir, &input);
        // Expected: direct convolution, then the same normalisation.
        let spectrum = IrSpectrum::new(&ir);
        let mut probe = Convolver::new(Arc::new(spectrum));
        let mut impulse = vec![0.0; 1_000];
        impulse[0] = 1.0;
        let mut copy = impulse.clone();
        probe.process(&mut impulse, &mut copy);
        let scale = impulse[PARTITION] / ir[0];
        for n in 400..1_500 {
            let direct: f32 = (0..ir.len())
                .filter(|&k| k <= n)
                .map(|k| ir[k] * input[n - k])
                .sum();
            assert!(
                (out[n + PARTITION] - direct * scale).abs() < 1.0e-3,
                "sample {n}"
            );
        }
    }

    #[test]
    fn empty_ir_passes_signal_and_silence_stays_silent() {
        let out = run(&[], &sine(200.0, 0.5, 1_000));
        assert!(all_finite(&out));
        assert!(peak(&out) > 0.4);
        let silent = run(&[0.3, 0.2], &vec![0.0; 1_000]);
        assert!(silent.iter().all(|&s| s == 0.0));
    }
}
