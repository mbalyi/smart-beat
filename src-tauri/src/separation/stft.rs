//! Short-time Fourier transform shared by every separation method: Hann windows, 75 % overlap,
//! exact overlap-add reconstruction (the synthesis divides by the summed squared window, so an
//! unmodified spectrogram gives back the input).

use realfft::num_complex::Complex32;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use std::sync::Arc;

pub type C = Complex32;
pub const FRAME: usize = 2048;
pub const HOP: usize = 512;
pub const BINS: usize = FRAME / 2 + 1;

/// A spectrogram: `frames` rows of [`BINS`] complex bins. Frame `t` is centred on sample
/// `t * HOP`.
#[derive(Debug, Clone, PartialEq)]
pub struct Spec {
    frames: usize,
    bins: usize,
    pub data: Vec<C>,
}

impl Spec {
    pub fn zeros(frames: usize) -> Self {
        Self::zeros_with(frames, BINS)
    }

    pub fn zeros_with(frames: usize, bins: usize) -> Self {
        Self {
            frames,
            bins,
            data: vec![C::new(0.0, 0.0); frames * bins],
        }
    }

    pub fn frames(&self) -> usize {
        self.frames
    }

    pub fn bins(&self) -> usize {
        self.bins
    }

    pub fn magnitudes(&self) -> Vec<f32> {
        self.data.iter().map(|c| c.norm()).collect()
    }
}

pub struct Stft {
    frame: usize,
    hop: usize,
    fwd: Arc<dyn RealToComplex<f32>>,
    inv: Arc<dyn ComplexToReal<f32>>,
    window: Vec<f32>,
}

impl Default for Stft {
    fn default() -> Self {
        Self::new()
    }
}

impl Stft {
    pub fn new() -> Self {
        Self::with_frame(FRAME)
    }

    /// A transform with another frame length (hop is a quarter of it). A short frame shows
    /// drum hits as lines across the spectrum; a long one resolves notes.
    pub fn with_frame(frame: usize) -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let window = (0..frame)
            .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / frame as f32).cos())
            .collect();
        Self {
            frame,
            hop: frame / 4,
            fwd: planner.plan_fft_forward(frame),
            inv: planner.plan_fft_inverse(frame),
            window,
        }
    }

    /// Number of frames that cover `len` samples with the default frame length.
    pub fn frame_count(len: usize) -> usize {
        len.div_ceil(HOP) + 1
    }

    pub fn frames_for(&self, len: usize) -> usize {
        len.div_ceil(self.hop) + 1
    }

    pub fn bins(&self) -> usize {
        self.frame / 2 + 1
    }

    pub fn analyse(&self, x: &[f32]) -> Spec {
        let frames = self.frames_for(x.len());
        let bins = self.bins();
        let mut spec = Spec::zeros_with(frames, bins);
        let mut buf = vec![0.0f32; self.frame];
        let mut scratch = self.fwd.make_scratch_vec();
        for t in 0..frames {
            let start = (t * self.hop) as isize - (self.frame / 2) as isize;
            for (i, b) in buf.iter_mut().enumerate() {
                let pos = start + i as isize;
                *b = if pos >= 0 && (pos as usize) < x.len() {
                    x[pos as usize] * self.window[i]
                } else {
                    0.0
                };
            }
            let out = &mut spec.data[t * bins..(t + 1) * bins];
            // Sizes are fixed, so this cannot fail.
            let _ = self.fwd.process_with_scratch(&mut buf, out, &mut scratch);
        }
        spec
    }

    pub fn synthesise(&self, spec: &Spec, len: usize) -> Vec<f32> {
        let bins = self.bins();
        let mut out = vec![0.0f32; len];
        let mut weight = vec![0.0f32; len];
        let mut frame = vec![C::new(0.0, 0.0); bins];
        let mut buf = vec![0.0f32; self.frame];
        let mut scratch = self.inv.make_scratch_vec();
        for t in 0..spec.frames {
            frame.copy_from_slice(&spec.data[t * bins..(t + 1) * bins]);
            // The inverse transform wants real DC and Nyquist bins.
            frame[0].im = 0.0;
            frame[bins - 1].im = 0.0;
            let _ = self
                .inv
                .process_with_scratch(&mut frame, &mut buf, &mut scratch);
            let start = (t * self.hop) as isize - (self.frame / 2) as isize;
            for (i, (&b, &w)) in buf.iter().zip(&self.window).enumerate() {
                let pos = start + i as isize;
                if pos >= 0 && (pos as usize) < len {
                    let p = pos as usize;
                    out[p] += b / self.frame as f32 * w;
                    weight[p] += w * w;
                }
            }
        }
        for (o, w) in out.iter_mut().zip(&weight) {
            if *w > 1e-3 {
                *o /= w;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(len: usize) -> Vec<f32> {
        let mut state = 12345u32;
        (0..len)
            .map(|_| {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                (state >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0
            })
            .collect()
    }

    #[test]
    fn an_unchanged_spectrogram_gives_back_the_input() {
        let x = noise(10_000);
        let stft = Stft::new();
        let y = stft.synthesise(&stft.analyse(&x), x.len());
        let worst = x
            .iter()
            .zip(&y)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f32::max);
        assert!(worst < 1e-4, "worst error {worst}");
    }

    #[test]
    fn a_short_frame_also_round_trips() {
        let x = noise(5_000);
        let stft = Stft::with_frame(512);
        let spec = stft.analyse(&x);
        assert_eq!(spec.bins(), 257);
        let y = stft.synthesise(&spec, x.len());
        let worst = x
            .iter()
            .zip(&y)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f32::max);
        assert!(worst < 1e-4, "worst error {worst}");
    }

    #[test]
    fn a_sine_peaks_in_its_bin() {
        let rate = 44_100.0f32;
        let hz = 1_000.0f32;
        let x: Vec<f32> = (0..8192)
            .map(|i| (std::f32::consts::TAU * hz * i as f32 / rate).sin())
            .collect();
        let spec = Stft::new().analyse(&x);
        let frame = &spec.data[5 * BINS..6 * BINS];
        let peak = (0..BINS)
            .max_by(|&a, &b| frame[a].norm().total_cmp(&frame[b].norm()))
            .unwrap();
        let expected = (hz / rate * FRAME as f32).round() as usize;
        assert_eq!(peak, expected);
    }
}
