//! Neural stem separation with an ONNX model run by `tract` (issue #186): SCNet Small, SCNet XL
//! and HTDemucs, the user's optional downloads (see `stems::models`). The models split a song
//! into drums, bass, vocals and the rest; nothing of them is part of the app.
//!
//! The graphs hold only the neural network. Everything around it happens here, in plain Rust, so
//! the app needs no PyTorch and no complex tensors in the graph: the STFT in the layout the
//! model was trained with, the cut into segments, the inverse STFT, and the triangular
//! overlap-add of the segments. The conventions below were read from the reference code
//! (`torch.stft` calls of SCNet and `demucs.htdemucs`) and checked on the real exports:
//!
//! * SCNet: STFT of 4096 points, hop 1024, RECTANGULAR window, `center=True` (reflect padding),
//!   `normalized=True`, all 2049 bins, the end of the segment zero-padded to an odd number of
//!   hops. The graph takes `[1, 4, 2049, frames]` (left re, left im, right re, right im) and
//!   returns the four stems the same way. SCNet Small also standardises the spectrogram by one
//!   mean and standard deviation, which the exported graph leaves to the host.
//! * HTDemucs: the graph takes the waveform `[1, 2, 343980]` (standardised by the mean and
//!   standard deviation of the mono mix) and its complex-as-channels spectrogram
//!   `[1, 4, 2048, 336]` (Hann window, hop 1024, 1.5 hops of reflect padding, two frames dropped
//!   at each end) and returns the stems' spectrograms and waveforms, which are added.
//!
//! One segment at a time runs on one thread: the measured peak memory is 1.0 GB (Small), 1.6 GB
//! (HTDemucs) and 3.5 GB (XL). The finished samples are handed to the sink as soon as no later
//! segment can change them, so the result is never held whole.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tract_onnx::prelude::*;

use super::stft::{Spec, Stft};
use super::{StemKind, StemSink};
use crate::audio::backing::DecodedAudio;

/// Samples per second the models were trained at.
pub const RATE: u32 = 44_100;

/// What one graph input carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum In {
    /// The mixture waveform, `[1, 2, segment]`.
    Wave,
    /// The mixture STFT with real and imaginary parts as channels, `[1, 4, bins, frames]`;
    /// channel order left re, left im, right re, right im (the "CaC" layout of Demucs).
    Cac,
}

/// What one graph output carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Out {
    /// Stem waveforms, `[1, stems, 2, segment]`.
    Wave,
    /// Stem STFTs as channels, `[1, stems, 4, bins, frames]` (or the same flattened).
    Cac,
}

/// How the STFT frames line up with the segment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Framing {
    /// HTDemucs: reflect-pad by 1.5 hops, STFT with `center=True`, drop the first two frames:
    /// `ceil(segment / hop)` frames. The inverse pads two zero frames on each side.
    Demucs,
    /// SCNet: zero-pad the end to a whole number of hops with an ODD number of them
    /// (`padding = hop - len % hop`, plus one more hop when the result would be even), then
    /// `torch.stft(center=True)` with a RECTANGULAR window (reflect-pad by `n_fft / 2`):
    /// `padded / hop + 1` frames, all 2049 bins. The inverse is the rectangular-window
    /// overlap-add, cropped back to the segment.
    ScNet,
}

#[derive(Clone, Copy, Debug)]
pub struct Contract {
    pub name: &'static str,
    /// Samples per model call at 44.1 kHz.
    pub segment: usize,
    /// Fraction of a segment shared with the next one (triangular overlap-add).
    pub overlap: f32,
    pub n_fft: usize,
    /// Must be `n_fft / 4` (the shared `Stft`).
    pub hop: usize,
    /// Frequency bins the graph takes and returns (HTDemucs drops the Nyquist bin: 2049 -> 2048).
    pub bins: usize,
    pub framing: Framing,
    /// `torch.stft(normalized=True)`: forward scaled by `1/sqrt(n_fft)`, inverse by `sqrt(n_fft)`.
    pub normalized_stft: bool,
    /// Subtract the mean and divide by the standard deviation of the mono mixture before the
    /// model, undo it on the stems (what `demucs.separate` does around the model).
    pub normalise_mix: bool,
    /// Subtract the mean and divide by `1e-5 +` the standard deviation of the whole input
    /// spectrogram (all channels, bins, frames; one scalar pair per segment) and undo it on every
    /// output channel: starrytong's SCNet does this inside `forward`, the exported core leaves it
    /// to the host.
    pub spec_norm: bool,
    pub inputs: &'static [In],
    pub outputs: &'static [Out],
    /// Order of the stems on the stem axis of the outputs.
    pub stems: &'static [&'static str],
}

/// HTDemucs (`htdemucs_core.onnx`): 343 980 samples (7.8 s), 336 frames of 2048 bins. Inputs the
/// waveform and the spectrogram, outputs the spectral and the time branch, summed.
pub const HTDEMUCS: Contract = Contract {
    name: "htdemucs",
    segment: 343_980,
    overlap: 0.25,
    n_fft: 4096,
    hop: 1024,
    bins: 2048,
    framing: Framing::Demucs,
    normalized_stft: true,
    normalise_mix: true,
    spec_norm: false,
    inputs: &[In::Wave, In::Cac],
    outputs: &[Out::Cac, Out::Wave],
    stems: &["drums", "bass", "other", "vocals"],
};

/// SCNet Small (starrytong's checkpoint, `scnet_cpu.onnx`): 343 980 samples (7.8 s) padded to
/// 337 hops, 338 frames. Normalises the input spectrogram by its mean and standard deviation.
pub const SCNET: Contract = Contract {
    name: "scnet",
    segment: 343_980,
    overlap: 0.25,
    n_fft: 4096,
    hop: 1024,
    bins: 2049,
    framing: Framing::ScNet,
    normalized_stft: true,
    normalise_mix: false,
    spec_norm: true,
    inputs: &[In::Cac],
    outputs: &[Out::Cac],
    stems: &["drums", "bass", "other", "vocals"],
};

/// SCNet XL (ZFTurbo `v1.0.15`, `scnet_xl_core.onnx`): 485 100 samples (11 s) padded to 475 hops,
/// 476 frames, no spectrogram normalisation (`normalize: false`).
pub const SCNET_XL: Contract = Contract {
    name: "scnet-xl",
    segment: 485_100,
    overlap: 0.25,
    n_fft: 4096,
    hop: 1024,
    bins: 2049,
    framing: Framing::ScNet,
    normalized_stft: true,
    normalise_mix: false,
    spec_norm: false,
    inputs: &[In::Cac],
    outputs: &[Out::Cac],
    stems: &["drums", "bass", "other", "vocals"],
};

impl Contract {
    /// The contract of a model by its id (`scnet`, `scnet-xl`, `htdemucs`).
    pub fn by_name(name: &str) -> Option<Contract> {
        [SCNET, SCNET_XL, HTDEMUCS]
            .into_iter()
            .find(|c| c.name == name)
    }

    pub fn frames(&self) -> usize {
        match self.framing {
            Framing::Demucs => self.segment.div_ceil(self.hop),
            Framing::ScNet => self.padded_len() / self.hop + 1,
        }
    }

    /// Samples of reflect padding in front of the signal before the STFT.
    fn pad(&self) -> usize {
        match self.framing {
            Framing::Demucs => self.hop / 2 * 3,
            Framing::ScNet => self.n_fft / 2,
        }
    }

    /// Length of the padded signal: for Demucs every kept frame has its whole window inside it;
    /// for SCNet an odd number of hops (SCNet's rule: `hop - len % hop`, one more hop when the
    /// frame count would come out even).
    fn padded_len(&self) -> usize {
        match self.framing {
            Framing::Demucs => (self.frames() + 3) * self.hop,
            Framing::ScNet => {
                let mut padding = self.hop - self.segment % self.hop;
                if ((self.segment + padding) / self.hop).is_multiple_of(2) {
                    padding += self.hop;
                }
                self.segment + padding
            }
        }
    }

    /// Frames of the full STFT that precede the first kept frame.
    fn lead(&self) -> usize {
        2
    }

    pub fn input_shape(&self, kind: In) -> Vec<usize> {
        match kind {
            In::Wave => vec![1, 2, self.segment],
            In::Cac => vec![1, 4, self.bins, self.frames()],
        }
    }

    pub fn output_shape(&self, kind: Out) -> Vec<usize> {
        let s = self.stems.len();
        match kind {
            Out::Wave => vec![1, s, 2, self.segment],
            Out::Cac => vec![1, s, 4, self.bins, self.frames()],
        }
    }
}

// ---------------------------------------------------------------------------------------------
// STFT in the layout the models want
// ---------------------------------------------------------------------------------------------

/// Reflect padding (`torch` `pad_mode="reflect"`, the edge sample not repeated).
fn reflect_pad(x: &[f32], left: usize, right: usize) -> Vec<f32> {
    let n = x.len() as isize;
    let at = |i: isize| -> f32 {
        if n == 1 {
            return x[0];
        }
        let period = 2 * (n - 1);
        let m = i.rem_euclid(period);
        x[(if m < n { m } else { period - m }) as usize]
    };
    (-(left as isize)..n + right as isize).map(at).collect()
}

/// `[4, bins, frames]` complex-as-channels spectrogram of one segment, flat.
fn cac_forward(stft: &Stft, c: &Contract, left: &[f32], right: &[f32]) -> Vec<f32> {
    if matches!(c.framing, Framing::ScNet) {
        return rect_forward(c, left, right);
    }
    let (f_kept, frames, full) = (c.bins, c.frames(), stft.bins());
    let scale = if c.normalized_stft {
        1.0 / (c.n_fft as f32).sqrt()
    } else {
        1.0
    };
    let pad = c.pad();
    let mut out = vec![0.0f32; 4 * f_kept * frames];
    for (ch, x) in [left, right].into_iter().enumerate() {
        let right_pad = c.padded_len() - pad - x.len();
        let spec = stft.analyse(&reflect_pad(x, pad, right_pad));
        for t in 0..frames {
            let row = &spec.data[(c.lead() + t) * full..][..full];
            for f in 0..f_kept {
                out[(2 * ch) * f_kept * frames + f * frames + t] = row[f].re * scale;
                out[(2 * ch + 1) * f_kept * frames + f * frames + t] = row[f].im * scale;
            }
        }
    }
    out
}

/// Inverse of [`cac_forward`] for one stem: `cac` is `[4, bins, frames]`; returns the two
/// channels, `segment` samples each.
fn cac_inverse(stft: &Stft, c: &Contract, cac: &[f32]) -> [Vec<f32>; 2] {
    if matches!(c.framing, Framing::ScNet) {
        return rect_inverse(c, cac);
    }
    let (f_kept, frames, full) = (c.bins, c.frames(), stft.bins());
    let scale = if c.normalized_stft {
        (c.n_fft as f32).sqrt()
    } else {
        1.0
    };
    std::array::from_fn(|ch| {
        let (lead, total) = (2, frames + 4);
        let mut spec = Spec::zeros_with(total, full);
        for t in 0..frames {
            for f in 0..f_kept {
                let re = cac[(2 * ch) * f_kept * frames + f * frames + t] * scale;
                let im = cac[(2 * ch + 1) * f_kept * frames + f * frames + t] * scale;
                spec.data[(lead + t) * full + f] = realfft::num_complex::Complex32::new(re, im);
            }
        }
        let y = stft.synthesise(&spec, c.padded_len());
        y[c.pad()..c.pad() + c.segment].to_vec()
    })
}

/// `torch.stft(n_fft, hop, window=None (rectangular), center=True, normalized=True)` of one
/// segment zero-padded to `padded_len`, as `[4, bins, frames]` (L re, L im, R re, R im), flat.
/// The shared `Stft` is Hann-windowed, so SCNet gets its own transform.
fn rect_forward(c: &Contract, left: &[f32], right: &[f32]) -> Vec<f32> {
    let (bins, frames, n) = (c.bins, c.frames(), c.n_fft);
    assert_eq!(bins, n / 2 + 1, "SCNet keeps every bin");
    let scale = if c.normalized_stft {
        1.0 / (n as f32).sqrt()
    } else {
        1.0
    };
    let fft = realfft::RealFftPlanner::<f32>::new().plan_fft_forward(n);
    let mut scratch = fft.make_scratch_vec();
    let mut out = vec![0.0f32; 4 * bins * frames];
    for (ch, x) in [left, right].into_iter().enumerate() {
        let mut padded = x.to_vec();
        padded.resize(c.padded_len(), 0.0);
        let padded = reflect_pad(&padded, n / 2, n / 2);
        let mut spectrum = fft.make_output_vec();
        for t in 0..frames {
            let mut frame = padded[t * c.hop..t * c.hop + n].to_vec();
            // Sizes are fixed, so this cannot fail.
            let _ = fft.process_with_scratch(&mut frame, &mut spectrum, &mut scratch);
            for (f, v) in spectrum.iter().enumerate() {
                out[(2 * ch) * bins * frames + f * frames + t] = v.re * scale;
                out[(2 * ch + 1) * bins * frames + f * frames + t] = v.im * scale;
            }
        }
    }
    out
}

/// `torch.istft` (rectangular window, `center=True`, `normalized=True`) of `[4, bins, frames]`:
/// inverse FFT per frame, overlap-add, divide by the number of frames covering each sample, drop
/// the centre padding, crop to the segment.
fn rect_inverse(c: &Contract, cac: &[f32]) -> [Vec<f32>; 2] {
    let (bins, frames, n) = (c.bins, c.frames(), c.n_fft);
    let scale = if c.normalized_stft {
        (n as f32).sqrt()
    } else {
        1.0
    };
    let fft = realfft::RealFftPlanner::<f32>::new().plan_fft_inverse(n);
    let mut scratch = fft.make_scratch_vec();
    let total = (frames - 1) * c.hop + n;
    let mut weight = vec![0.0f32; total];
    for t in 0..frames {
        for w in &mut weight[t * c.hop..t * c.hop + n] {
            *w += 1.0;
        }
    }
    std::array::from_fn(|ch| {
        let mut sum = vec![0.0f32; total];
        let mut frame = fft.make_input_vec();
        let mut buf = fft.make_output_vec();
        for t in 0..frames {
            for (f, v) in frame.iter_mut().enumerate() {
                let re = cac[(2 * ch) * bins * frames + f * frames + t] * scale;
                let im = cac[(2 * ch + 1) * bins * frames + f * frames + t] * scale;
                *v = realfft::num_complex::Complex32::new(re, im);
            }
            // The inverse transform wants real DC and Nyquist bins.
            frame[0].im = 0.0;
            frame[bins - 1].im = 0.0;
            let _ = fft.process_with_scratch(&mut frame, &mut buf, &mut scratch);
            for (d, v) in sum[t * c.hop..t * c.hop + n].iter_mut().zip(&buf) {
                *d += v / n as f32;
            }
        }
        (n / 2..n / 2 + c.segment)
            .map(|p| sum[p] / weight[p])
            .collect::<Vec<f32>>()
    })
}

// ---------------------------------------------------------------------------------------------
// Running the model over a song
// ---------------------------------------------------------------------------------------------

/// Weight of sample `i` of a segment in the overlap-add: a triangle, as Demucs uses.
fn triangle(segment: usize) -> Vec<f32> {
    let half = segment / 2;
    let mut w: Vec<f32> = (1..=half).map(|i| i as f32).collect();
    w.extend((1..=segment - half).rev().map(|i| i as f32));
    let max = w.iter().cloned().fold(0.0, f32::max);
    w.iter().map(|v| v / max).collect()
}

/// Mean and standard deviation (`torch.std`, n - 1) of a buffer.
fn mean_std(x: &[f32]) -> (f32, f32) {
    let n = x.len() as f64;
    let mean = x.iter().map(|&v| v as f64).sum::<f64>() / n;
    let var = x.iter().map(|&v| (v as f64 - mean).powi(2)).sum::<f64>() / (n - 1.0);
    (mean as f32, var.sqrt() as f32)
}

/// Mean and standard deviation of the mono mix, for the models that standardise it.
fn mix_stats(audio: &DecodedAudio) -> (f32, f32) {
    let n = audio.frames().max(1) as f64;
    let mono = |i: usize| 0.5 * (audio.left[i] as f64 + audio.right[i] as f64);
    let mean = (0..audio.frames()).map(mono).sum::<f64>() / n;
    let var = (0..audio.frames())
        .map(|i| (mono(i) - mean).powi(2))
        .sum::<f64>()
        / (audio.frames().saturating_sub(1)).max(1) as f64;
    (mean as f32, (var.sqrt() as f32).max(1e-8))
}

/// Runs the graph on the flat input buffers (one per `contract.inputs`) and returns the flat
/// output buffers (one per `contract.outputs`).
pub type Run<'a> = dyn FnMut(&[Vec<f32>]) -> Result<Vec<Vec<f32>>, String> + 'a;

fn kind_of(name: &str) -> Result<StemKind, String> {
    StemKind::from_id(name).ok_or_else(|| format!("The model returns an unknown stem: {name}"))
}

/// Separates `audio` (44.1 kHz) with the graph behind `run`, writing the four stems to `sink` as
/// their samples become final. `progress` gets the finished fraction after each segment; `cancel`
/// is checked before each segment and ends the job with [`super::STOPPED`].
pub fn separate_with(
    c: &Contract,
    run: &mut Run,
    audio: &DecodedAudio,
    sink: &mut dyn StemSink,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<(), String> {
    assert_eq!(c.hop * 4, c.n_fft, "the shared Stft has hop = n_fft / 4");
    if audio.rate != RATE {
        return Err("The neural model needs a 44.1 kHz recording".into());
    }
    let len = audio.frames();
    if len == 0 {
        return Err("The recording is empty".into());
    }
    let kinds: Vec<StemKind> = c
        .stems
        .iter()
        .map(|n| kind_of(n))
        .collect::<Result<_, _>>()?;
    let stft = Stft::with_frame(c.n_fft);
    let (mean, std) = if c.normalise_mix {
        mix_stats(audio)
    } else {
        (0.0, 1.0)
    };

    let stride = ((c.segment as f32 * (1.0 - c.overlap)) as usize).max(1);
    let segments = if len > c.segment {
        (len - c.segment).div_ceil(stride) + 1
    } else {
        1
    };
    let weight = triangle(c.segment);
    // The overlap-add buffers cover the samples [start, start + segment) of the current segment.
    let mut acc: Vec<[Vec<f32>; 2]> = (0..c.stems.len())
        .map(|_| [vec![0.0f32; c.segment], vec![0.0f32; c.segment]])
        .collect();
    let mut sum_w = vec![0.0f32; c.segment];

    progress(0.0);
    for s in 0..segments {
        if cancel.load(Ordering::Relaxed) {
            return Err(super::STOPPED.into());
        }
        let start = s * stride;
        let take = (len - start).min(c.segment);
        let chunk = |x: &[f32]| -> Vec<f32> {
            let mut v: Vec<f32> = x[start..start + take]
                .iter()
                .map(|v| (v - mean) / std)
                .collect();
            v.resize(c.segment, 0.0);
            v
        };
        let (cl, cr) = (chunk(&audio.left), chunk(&audio.right));

        let mut spec_scale = (0.0f32, 1.0f32);
        let mut inputs = Vec::with_capacity(c.inputs.len());
        for kind in c.inputs {
            let mut data = match kind {
                In::Wave => [cl.as_slice(), cr.as_slice()].concat(),
                In::Cac => cac_forward(&stft, c, &cl, &cr),
            };
            if c.spec_norm && *kind == In::Cac {
                spec_scale = mean_std(&data);
                for v in &mut data {
                    *v = (*v - spec_scale.0) / (1e-5 + spec_scale.1);
                }
            }
            inputs.push(data);
        }
        let outputs = run(&inputs)?;
        if outputs.len() != c.outputs.len() {
            return Err(format!(
                "The {} model returned {} outputs, {} were expected",
                c.name,
                outputs.len(),
                c.outputs.len()
            ));
        }

        // Sum of every output branch, per stem and channel, `segment` samples.
        let mut segment_out: Vec<[Vec<f32>; 2]> = (0..c.stems.len())
            .map(|_| [vec![0.0f32; c.segment], vec![0.0f32; c.segment]])
            .collect();
        for (o, kind) in c.outputs.iter().enumerate() {
            let expected: usize = c.output_shape(*kind).iter().product();
            let data = &outputs[o];
            if data.len() != expected {
                return Err(format!(
                    "The {} model returned {} values for output {o}, {expected} were expected",
                    c.name,
                    data.len()
                ));
            }
            for (si, slot) in segment_out.iter_mut().enumerate() {
                match kind {
                    Out::Wave => {
                        for (ch, dst) in slot.iter_mut().enumerate() {
                            let src = &data[(si * 2 + ch) * c.segment..][..c.segment];
                            for (d, v) in dst.iter_mut().zip(src) {
                                *d += v;
                            }
                        }
                    }
                    Out::Cac => {
                        let per = 4 * c.bins * c.frames();
                        let part = &data[si * per..][..per];
                        let y = if c.spec_norm {
                            let (m, sd) = spec_scale;
                            let restored: Vec<f32> = part.iter().map(|v| v * sd + m).collect();
                            cac_inverse(&stft, c, &restored)
                        } else {
                            cac_inverse(&stft, c, part)
                        };
                        for (dst, src) in slot.iter_mut().zip(&y) {
                            for (d, v) in dst.iter_mut().zip(src) {
                                *d += v;
                            }
                        }
                    }
                }
            }
        }
        for (si, slot) in segment_out.iter().enumerate() {
            for ch in 0..2 {
                for j in 0..take {
                    acc[si][ch][j] += slot[ch][j] * weight[j];
                }
            }
        }
        for j in 0..take {
            sum_w[j] += weight[j];
        }

        // The first `stride` samples (all that is left, in the last segment) are final.
        let last = s + 1 == segments;
        let done = if last { take } else { stride };
        for (si, kind) in kinds.iter().enumerate() {
            let finish = |ch: &[f32]| -> Vec<f32> {
                ch[..done]
                    .iter()
                    .zip(&sum_w)
                    .map(|(v, w)| v / w * std + mean)
                    .collect()
            };
            sink.write(*kind, &finish(&acc[si][0]), &finish(&acc[si][1]))?;
        }
        if !last {
            for stem in &mut acc {
                for ch in stem.iter_mut() {
                    ch.copy_within(stride.., 0);
                    ch[c.segment - stride..].fill(0.0);
                }
            }
            sum_w.copy_within(stride.., 0);
            sum_w[c.segment - stride..].fill(0.0);
        }
        progress((s + 1) as f32 / segments as f32);
    }
    Ok(())
}

/// A model loaded and optimised for its segment size.
pub struct Model {
    contract: Contract,
    runnable: Arc<TypedRunnableModel>,
}

impl Model {
    /// Reads and optimises the ONNX file for `contract` (one to three seconds).
    pub fn load(path: &Path, contract: &Contract) -> Result<Model, String> {
        let fail = |what: &str, e: TractError| format!("{what}: {e:#}");
        let mut model = tract_onnx::onnx()
            .model_for_path(path)
            .map_err(|e| fail("The model file cannot be read", e))?;
        let inputs = model
            .input_outlets()
            .map_err(|e| fail("The model file is not usable", e))?
            .len();
        if inputs != contract.inputs.len() {
            return Err(format!(
                "The model file has {inputs} inputs, the {} model has {}",
                contract.name,
                contract.inputs.len()
            ));
        }
        for (i, kind) in contract.inputs.iter().enumerate() {
            model = model
                .with_input_fact(i, f32::fact(contract.input_shape(*kind)).into())
                .map_err(|e| fail("The model file does not fit this model", e))?;
        }
        let runnable = model
            .into_optimized()
            .and_then(|m| m.into_runnable())
            .map_err(|e| fail("The model could not be prepared", e))?;
        Ok(Model {
            contract: *contract,
            runnable,
        })
    }

    pub fn contract(&self) -> &Contract {
        &self.contract
    }
}

/// Separates `audio` (44.1 kHz) with a loaded model. See [`separate_with`].
pub fn separate(
    model: &Model,
    audio: &DecodedAudio,
    sink: &mut dyn StemSink,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<(), String> {
    let c = &model.contract;
    let fail = |what: &str, e: TractError| format!("{what}: {e}");
    let mut run = |inputs: &[Vec<f32>]| -> Result<Vec<Vec<f32>>, String> {
        let mut tensors = TVec::new();
        for (kind, data) in c.inputs.iter().zip(inputs) {
            let tensor = Tensor::from_shape(&c.input_shape(*kind), data)
                .map_err(|e| fail("input tensor", e))?;
            tensors.push(tensor.into());
        }
        let outputs = model
            .runnable
            .run(tensors)
            .map_err(|e| fail("The model failed on a part of the song", e))?;
        outputs
            .iter()
            .map(|t| {
                let view = t
                    .to_plain_array_view::<f32>()
                    .map_err(|e| fail("output tensor", e))?;
                view.as_slice()
                    .map(<[f32]>::to_vec)
                    .ok_or_else(|| "The model output is not contiguous".to_string())
            })
            .collect()
    };
    separate_with(c, &mut run, audio, sink, cancel, progress)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::separation::MemorySink;

    /// A short stand-in for a model contract: same framing, a segment of a fraction of a second.
    fn small(c: Contract, segment: usize) -> Contract {
        Contract { segment, ..c }
    }

    fn signal(len: usize) -> DecodedAudio {
        // Deterministic noise plus two tones, different in the two channels, zero mean.
        let mut state = 0x2545_f491u32;
        let mut noise = move || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state as f32 / u32::MAX as f32) - 0.5
        };
        let left: Vec<f32> = (0..len)
            .map(|i| 0.3 * (i as f32 * 0.05).sin() + 0.2 * noise())
            .collect();
        let right: Vec<f32> = (0..len)
            .map(|i| 0.3 * (i as f32 * 0.021).sin() + 0.2 * noise())
            .collect();
        DecodedAudio {
            left,
            right,
            rate: RATE,
            channels: 2,
        }
    }

    fn snr_db(reference: &[f32], estimate: &[f32]) -> f32 {
        let signal: f64 = reference.iter().map(|v| (*v as f64).powi(2)).sum();
        let noise: f64 = reference
            .iter()
            .zip(estimate)
            .map(|(a, b)| ((a - b) as f64).powi(2))
            .sum();
        10.0 * (signal / noise.max(1e-30)).log10() as f32
    }

    const GAINS: [f32; 4] = [0.1, 0.2, 0.3, 0.4];

    /// A "model" that returns each stem as `GAINS[i]` times the input spectrogram (SCNet
    /// graphs): the stems then add up to the input and each is a fixed share of it.
    fn scaled_cac(c: Contract) -> impl FnMut(&[Vec<f32>]) -> Result<Vec<Vec<f32>>, String> {
        move |inputs| {
            let spec = &inputs[0];
            let mut out = Vec::with_capacity(spec.len() * 4);
            for g in GAINS {
                out.extend(spec.iter().map(|v| v * g));
            }
            assert_eq!(
                out.len(),
                c.output_shape(Out::Cac).iter().product::<usize>()
            );
            Ok(vec![out])
        }
    }

    #[test]
    fn the_real_contracts_match_the_exported_graphs() {
        assert_eq!(SCNET.frames(), 338);
        assert_eq!(SCNET.input_shape(In::Cac), [1, 4, 2049, 338]);
        assert_eq!(SCNET_XL.frames(), 476);
        assert_eq!(SCNET_XL.input_shape(In::Cac), [1, 4, 2049, 476]);
        assert_eq!(SCNET_XL.output_shape(Out::Cac), [1, 4, 4, 2049, 476]);
        assert_eq!(HTDEMUCS.frames(), 336);
        assert_eq!(HTDEMUCS.input_shape(In::Cac), [1, 4, 2048, 336]);
        assert_eq!(HTDEMUCS.input_shape(In::Wave), [1, 2, 343_980]);
        assert_eq!(HTDEMUCS.output_shape(Out::Wave), [1, 4, 2, 343_980]);
        for c in [SCNET, SCNET_XL, HTDEMUCS] {
            assert_eq!(c.hop * 4, c.n_fft);
            assert_eq!(Contract::by_name(c.name).unwrap().segment, c.segment);
        }
        assert!(Contract::by_name("umx").is_none());
        // SCNet's padding rule: an odd number of hops.
        assert_eq!(SCNET.padded_len() / SCNET.hop % 2, 1);
        assert_eq!(SCNET_XL.padded_len() / SCNET_XL.hop % 2, 1);
        assert_eq!(SCNET_XL.padded_len(), 486_400);
    }

    #[test]
    fn the_rectangular_stft_round_trips_a_segment() {
        let c = small(SCNET_XL, 20_000);
        let audio = signal(c.segment);
        let spec = rect_forward(&c, &audio.left, &audio.right);
        assert_eq!(spec.len(), 4 * c.bins * c.frames());
        let ch = rect_inverse(&c, &spec[..]);
        assert!(snr_db(&audio.left, &ch[0]) > 80.0);
        // The right channel is the second pair of channels: shift the layout to read it.
        let right_only: Vec<f32> = [
            vec![0.0; 2 * c.bins * c.frames()],
            spec[2 * c.bins * c.frames()..].to_vec(),
        ]
        .concat();
        let ch = rect_inverse(&c, &right_only);
        assert!(snr_db(&audio.right, &ch[1]) > 80.0);
    }

    #[test]
    fn the_scnet_stft_follows_torch_conventions() {
        // A constant signal: with a rectangular window and reflect padding, frame 0 is all
        // ones, so only the DC bin is non-zero, equal to n_fft * 1 / sqrt(n_fft) = 64.
        let c = small(SCNET_XL, 20_000);
        let ones = vec![1.0f32; c.segment];
        // The zero padding at the end breaks the constant for the last frames only.
        let spec = rect_forward(&c, &ones, &ones);
        let frames = c.frames();
        assert!((spec[0] - 64.0).abs() < 1e-3, "DC of frame 0: {}", spec[0]);
        for bin in [1usize, 5, 100, 2048] {
            assert!(spec[bin * frames].abs() < 1e-3, "bin {bin}");
        }
        // Imaginary parts of DC and Nyquist are zero for real input.
        assert!(spec[c.bins * frames].abs() < 1e-3);
    }

    #[test]
    fn the_overlap_add_hands_back_each_stems_share_for_scnet_xl_style_models() {
        // Several overlapping segments, a length that is no multiple of the stride.
        let c = small(SCNET_XL, 20_000);
        let audio = signal(57_321);
        let mut sink = MemorySink::default();
        let mut seen = Vec::new();
        separate_with(
            &c,
            &mut scaled_cac(c),
            &audio,
            &mut sink,
            &AtomicBool::new(false),
            &mut |f| seen.push(f),
        )
        .unwrap();
        assert_eq!(seen.first(), Some(&0.0));
        assert_eq!(seen.last(), Some(&1.0));
        assert!(seen.windows(2).all(|w| w[0] <= w[1]));
        for (name, g) in c.stems.iter().zip(GAINS) {
            let kind = StemKind::from_id(name).unwrap();
            let (l, r) = &sink.stems[&kind];
            assert_eq!((l.len(), r.len()), (57_321, 57_321), "{name}");
            let want_l: Vec<f32> = audio.left.iter().map(|v| v * g).collect();
            let want_r: Vec<f32> = audio.right.iter().map(|v| v * g).collect();
            assert!(snr_db(&want_l, l) > 60.0, "{name} left");
            assert!(snr_db(&want_r, r) > 60.0, "{name} right");
        }
    }

    #[test]
    fn a_song_shorter_than_one_segment_is_one_padded_call() {
        let c = small(SCNET_XL, 20_000);
        let audio = signal(7_000);
        let mut calls = 0;
        let mut inner = scaled_cac(c);
        let mut sink = MemorySink::default();
        separate_with(
            &c,
            &mut |i| {
                calls += 1;
                inner(i)
            },
            &audio,
            &mut sink,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(calls, 1);
        let (l, _) = &sink.stems[&StemKind::Drums];
        assert_eq!(l.len(), 7_000);
        let want: Vec<f32> = audio.left.iter().map(|v| v * 0.1).collect();
        assert!(snr_db(&want, l) > 60.0);
    }

    #[test]
    fn scnet_small_standardises_the_spectrogram_and_undoes_it() {
        // The stand-in model returns the (standardised) input scaled; the host must hand back
        // the stem scaled, up to the mean that the standardisation adds back.
        let c = small(SCNET, 20_000);
        let audio = signal(45_000);
        let mut sink = MemorySink::default();
        let mut seen_inputs = Vec::new();
        let mut inner = scaled_cac(c);
        separate_with(
            &c,
            &mut |i| {
                let (m, sd) = mean_std(&i[0]);
                seen_inputs.push((m, sd));
                inner(i)
            },
            &audio,
            &mut sink,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap();
        for (m, sd) in &seen_inputs {
            assert!(m.abs() < 1e-3, "mean {m}");
            assert!((sd - 1.0).abs() < 1e-3, "std {sd}");
        }
        let (l, _) = &sink.stems[&StemKind::Vocals];
        let want: Vec<f32> = audio.left.iter().map(|v| v * 0.4).collect();
        assert!(snr_db(&want, l) > 40.0, "{}", snr_db(&want, l));
    }

    #[test]
    fn the_htdemucs_waveform_branch_is_standardised_and_restored() {
        let c = small(HTDEMUCS, 30_000);
        let audio = signal(70_000);
        let mut sink = MemorySink::default();
        let mut mix_stats_seen = Vec::new();
        separate_with(
            &c,
            &mut |inputs| {
                // Inputs: the waveform [2 x segment], the spectrogram.
                assert_eq!(inputs.len(), 2);
                assert_eq!(inputs[0].len(), 2 * c.segment);
                assert_eq!(inputs[1].len(), 4 * c.bins * c.frames());
                mix_stats_seen.push(mean_std(&inputs[0]).1);
                // Spectral branch: zeros. Time branch: GAINS[i] x the waveform.
                let spectral = vec![0.0f32; c.output_shape(Out::Cac).iter().product()];
                let mut wave = Vec::new();
                for g in GAINS {
                    wave.extend(inputs[0].iter().map(|v| v * g));
                }
                Ok(vec![spectral, wave])
            },
            &audio,
            &mut sink,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap();
        // Standardised by the mono mix: the two channels (which differ) have a spread of about
        // 1 to 1.5, where the raw signal has about 0.2.
        assert!(
            mix_stats_seen[0] > 0.8 && mix_stats_seen[0] < 2.0,
            "{}",
            mix_stats_seen[0]
        );
        for (name, g) in c.stems.iter().zip(GAINS) {
            let kind = StemKind::from_id(name).unwrap();
            let (l, r) = &sink.stems[&kind];
            assert_eq!(l.len(), 70_000);
            let want: Vec<f32> = audio.left.iter().map(|v| v * g).collect();
            assert!(snr_db(&want, l) > 40.0, "{name}: {}", snr_db(&want, l));
            let want: Vec<f32> = audio.right.iter().map(|v| v * g).collect();
            assert!(snr_db(&want, r) > 40.0, "{name} right");
        }
    }

    #[test]
    fn the_htdemucs_spectral_branch_inverts_to_the_waveform() {
        // Identity on the spectrogram: the Demucs framing must give the signal back (inside the
        // segment, where the dropped Nyquist bin and the edges matter least).
        let c = small(HTDEMUCS, 30_000);
        let audio = signal(c.segment);
        let stft = Stft::with_frame(c.n_fft);
        let z = cac_forward(&stft, &c, &audio.left, &audio.right);
        assert_eq!(z.len(), 4 * c.bins * c.frames());
        let back = cac_inverse(&stft, &c, &z);
        let (from, to) = (4_096, c.segment - 4_096);
        let s = snr_db(&audio.left[from..to], &back[0][from..to]);
        assert!(s > 25.0, "left {s}");
        let s = snr_db(&audio.right[from..to], &back[1][from..to]);
        assert!(s > 25.0, "right {s}");
    }

    #[test]
    fn cancelling_stops_between_segments() {
        let c = small(SCNET_XL, 20_000);
        let audio = signal(90_000);
        let cancel = AtomicBool::new(false);
        let mut calls = 0;
        let mut inner = scaled_cac(c);
        let mut sink = MemorySink::default();
        let err = separate_with(
            &c,
            &mut |i| {
                calls += 1;
                inner(i)
            },
            &audio,
            &mut sink,
            &cancel,
            &mut |f| {
                if f > 0.0 {
                    cancel.store(true, Ordering::Relaxed);
                }
            },
        )
        .unwrap_err();
        assert_eq!(err, super::super::STOPPED);
        assert_eq!(calls, 1, "no segment ran after the stop");
    }

    #[test]
    fn wrong_input_is_refused_before_any_model_call() {
        let c = small(SCNET_XL, 20_000);
        let mut sink = MemorySink::default();
        let mut never = |_: &[Vec<f32>]| -> Result<Vec<Vec<f32>>, String> { panic!("called") };
        let mut audio = signal(1_000);
        audio.rate = 48_000;
        assert!(
            separate_with(
                &c,
                &mut never,
                &audio,
                &mut sink,
                &AtomicBool::new(false),
                &mut |_| {}
            )
            .unwrap_err()
            .contains("44.1 kHz")
        );
        let empty = DecodedAudio {
            left: vec![],
            right: vec![],
            rate: RATE,
            channels: 2,
        };
        assert!(
            separate_with(
                &c,
                &mut never,
                &empty,
                &mut sink,
                &AtomicBool::new(false),
                &mut |_| {}
            )
            .is_err()
        );
    }

    #[test]
    fn a_model_that_returns_the_wrong_amount_of_data_is_an_error() {
        let c = small(SCNET_XL, 20_000);
        let audio = signal(5_000);
        let mut sink = MemorySink::default();
        let err = separate_with(
            &c,
            &mut |_| Ok(vec![vec![0.0; 10]]),
            &audio,
            &mut sink,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap_err();
        assert!(err.contains("10 values"), "{err}");
        let err = separate_with(
            &c,
            &mut |_| Ok(vec![]),
            &audio,
            &mut sink,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap_err();
        assert!(err.contains("0 outputs"), "{err}");
    }

    #[test]
    fn a_missing_or_broken_model_file_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("none.onnx");
        let err = Model::load(&missing, &SCNET).err().unwrap();
        assert!(err.contains("cannot be read"), "{err}");
        let broken = dir.path().join("broken.onnx");
        std::fs::write(&broken, b"not an onnx file").unwrap();
        assert!(Model::load(&broken, &SCNET).is_err());
    }

    #[test]
    fn triangle_weights_peak_in_the_middle_and_stay_positive() {
        let w = triangle(1_001);
        assert!(w.iter().all(|v| *v > 0.0));
        assert!((w[500] - 1.0).abs() < 1e-6);
        assert!(w[0] < w[250] && w[250] < w[500]);
    }

    /// Runs the real model when `SMART_BEAT_STEM_ONNX_DIR` points at a folder with the three
    /// ONNX files (`scnet_cpu.onnx`, `scnet_xl_core.onnx`, `htdemucs_core.onnx`) and
    /// `SMART_BEAT_STEM_ONNX_MODEL` names one of `scnet`, `scnet-xl`, `htdemucs` (default
    /// `scnet`). A 10 s mix of a bass tone, a click track and noise must come back as four
    /// stems that add up to it. Slow, so ignored unless asked for:
    /// `cargo test --release real_model -- --ignored`.
    #[test]
    #[ignore = "needs the model files, see the doc comment"]
    fn real_model_separates_and_the_stems_add_up() {
        let Ok(dir) = std::env::var("SMART_BEAT_STEM_ONNX_DIR") else {
            eprintln!("SMART_BEAT_STEM_ONNX_DIR is not set, skipping");
            return;
        };
        let name = std::env::var("SMART_BEAT_STEM_ONNX_MODEL").unwrap_or_else(|_| "scnet".into());
        let c = Contract::by_name(&name).expect("known model");
        let file = match name.as_str() {
            "scnet" => "scnet_cpu.onnx",
            "scnet-xl" => "scnet_xl_core.onnx",
            _ => "htdemucs_core.onnx",
        };
        let model = Model::load(&Path::new(&dir).join(file), &c).expect("model loads");
        let audio = signal(10 * RATE as usize);
        let mut sink = MemorySink::default();
        separate(
            &model,
            &audio,
            &mut sink,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap();
        let mut sum = vec![0.0f32; audio.frames()];
        for (l, _) in sink.stems.values() {
            assert_eq!(l.len(), audio.frames());
            for (s, v) in sum.iter_mut().zip(l) {
                *s += v;
            }
        }
        let s = snr_db(&audio.left, &sum);
        assert!(s > 20.0, "stems vs mix: {s} dB");
    }
}
