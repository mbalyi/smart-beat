//! Open-Unmix (UMX-HQ, Stöter et al. 2019) inference, written from the architecture: three
//! bidirectional LSTM layers between linear layers, one network per stem. It reads the original
//! `.pth` weight files (see [`super::torch_legacy`]), so the app needs no ONNX export, no
//! PyTorch and no new dependency. The weights are the user's optional download and are not part
//! of the app.
//!
//! The network sees the magnitude spectrogram of a 4096-point STFT (hop 1024, 44.1 kHz) and
//! estimates the magnitude of its own stem; the four estimates are turned into soft power-ratio
//! masks on the complex mixture. (The reference adds an iterative Wiener filter on top; this
//! is a little worse than the reference.)

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use super::stft::{Spec, Stft};
use super::torch_legacy::{Tensor, read_state_dict};
use super::{StemKind, StemSink};
use crate::audio::backing::DecodedAudio;

pub const N_FFT: usize = 4096;
pub const BINS: usize = N_FFT / 2 + 1; // 2049
const HIDDEN: usize = 512;
const LAYERS: usize = 3;
const EPS: f32 = 1e-5;

/// The four stems the network separates and the weight file of each (Zenodo record 3370489).
pub const TARGETS: [(StemKind, &str); 4] = [
    (StemKind::Drums, "drums-9619578f.pth"),
    (StemKind::Bass, "bass-8d85a5bd.pth"),
    (StemKind::Vocals, "vocals-b62c91ce.pth"),
    (StemKind::Other, "other-b52fbbf7.pth"),
];

struct Linear {
    out: usize,
    inp: usize,
    w: Vec<f32>, // out x inp
}

struct BatchNorm {
    scale: Vec<f32>,
    shift: Vec<f32>,
}

struct LstmDir {
    w_ih: Vec<f32>, // 4*256 x in
    w_hh: Vec<f32>, // 4*256 x 256
    bias: Vec<f32>, // b_ih + b_hh
}

/// One stem's network.
pub struct Umx {
    nb_bins: usize,
    input_mean: Vec<f32>,
    input_scale: Vec<f32>,
    output_mean: Vec<f32>,
    output_scale: Vec<f32>,
    fc1: Linear,
    bn1: BatchNorm,
    lstm: Vec<[LstmDir; 2]>,
    fc2: Linear,
    bn2: BatchNorm,
    fc3: Linear,
    bn3: BatchNorm,
}

fn take(sd: &mut HashMap<String, Tensor>, name: &str) -> Result<Tensor, String> {
    sd.remove(name)
        .ok_or_else(|| format!("The weights file lacks {name}"))
}

fn linear(sd: &mut HashMap<String, Tensor>, name: &str) -> Result<Linear, String> {
    let t = take(sd, name)?;
    if t.shape.len() != 2 {
        return Err(format!("{name} has the wrong shape"));
    }
    Ok(Linear {
        out: t.shape[0],
        inp: t.shape[1],
        w: t.data,
    })
}

fn batch_norm(sd: &mut HashMap<String, Tensor>, name: &str) -> Result<BatchNorm, String> {
    let (w, b) = (
        take(sd, &format!("{name}.weight"))?,
        take(sd, &format!("{name}.bias"))?,
    );
    let (m, v) = (
        take(sd, &format!("{name}.running_mean"))?,
        take(sd, &format!("{name}.running_var"))?,
    );
    let scale: Vec<f32> = w
        .data
        .iter()
        .zip(&v.data)
        .map(|(w, v)| w / (v + EPS).sqrt())
        .collect();
    let shift = b
        .data
        .iter()
        .zip(&m.data)
        .zip(&scale)
        .map(|((b, m), s)| b - m * s)
        .collect();
    Ok(BatchNorm { scale, shift })
}

fn lstm_dir(
    sd: &mut HashMap<String, Tensor>,
    layer: usize,
    suffix: &str,
) -> Result<LstmDir, String> {
    let w_ih = take(sd, &format!("lstm.weight_ih_l{layer}{suffix}"))?.data;
    let w_hh = take(sd, &format!("lstm.weight_hh_l{layer}{suffix}"))?.data;
    let b_ih = take(sd, &format!("lstm.bias_ih_l{layer}{suffix}"))?.data;
    let b_hh = take(sd, &format!("lstm.bias_hh_l{layer}{suffix}"))?.data;
    let bias = b_ih.iter().zip(&b_hh).map(|(a, b)| a + b).collect();
    Ok(LstmDir { w_ih, w_hh, bias })
}

impl Umx {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        let mut sd = read_state_dict(bytes)?;
        let input_mean = take(&mut sd, "input_mean")?.data;
        let input_scale = take(&mut sd, "input_scale")?.data;
        let model = Umx {
            nb_bins: input_mean.len(),
            input_mean,
            input_scale,
            output_mean: take(&mut sd, "output_mean")?.data,
            output_scale: take(&mut sd, "output_scale")?.data,
            fc1: linear(&mut sd, "fc1.weight")?,
            bn1: batch_norm(&mut sd, "bn1")?,
            lstm: (0..LAYERS)
                .map(|l| Ok([lstm_dir(&mut sd, l, "")?, lstm_dir(&mut sd, l, "_reverse")?]))
                .collect::<Result<_, String>>()?,
            fc2: linear(&mut sd, "fc2.weight")?,
            bn2: batch_norm(&mut sd, "bn2")?,
            fc3: linear(&mut sd, "fc3.weight")?,
            bn3: batch_norm(&mut sd, "bn3")?,
        };
        if model.fc1.inp != 2 * model.nb_bins
            || model.fc1.out != HIDDEN
            || model.fc3.out != 2 * BINS
            || model.output_mean.len() != BINS
        {
            return Err("These are not Open-Unmix UMX-HQ weights".into());
        }
        Ok(model)
    }

    /// `mag`: frames x 2 channels x [`BINS`] mixture magnitudes. Returns this stem's estimate,
    /// same layout.
    pub fn estimate(&self, mag: &[f32], frames: usize, threads: usize) -> Vec<f32> {
        let nb = self.nb_bins;
        // Input scaling: (x + mean) * scale on the first `nb` bins of each channel.
        let mut x = vec![0.0f32; frames * 2 * nb];
        for f in 0..frames {
            for ch in 0..2 {
                let src = &mag[(f * 2 + ch) * BINS..][..nb];
                let dst = &mut x[f * 2 * nb + ch * nb..][..nb];
                for b in 0..nb {
                    dst[b] = (src[b] + self.input_mean[b]) * self.input_scale[b];
                }
            }
        }
        let mut h0 = matmul(&x, frames, &self.fc1, threads);
        norm_act(&mut h0, &self.bn1, HIDDEN, |v| v.tanh());
        // LSTM stack: layer input is h0, then the concatenated directions.
        let mut input = h0.clone();
        let mut width = HIDDEN;
        for layer in &self.lstm {
            let (fwd, rev) = std::thread::scope(|s| {
                let a = s.spawn(|| run_lstm(&input, frames, width, &layer[0], false));
                let b = run_lstm(&input, frames, width, &layer[1], true);
                (a.join().expect("lstm thread"), b)
            });
            let half = HIDDEN / 2;
            let mut out = vec![0.0f32; frames * HIDDEN];
            for f in 0..frames {
                out[f * HIDDEN..f * HIDDEN + half].copy_from_slice(&fwd[f * half..(f + 1) * half]);
                out[f * HIDDEN + half..(f + 1) * HIDDEN]
                    .copy_from_slice(&rev[f * half..(f + 1) * half]);
            }
            input = out;
            width = HIDDEN;
        }
        // concat [h0, lstm_out] -> fc2 -> bn2 -> relu -> fc3 -> bn3.
        let mut cat = vec![0.0f32; frames * 2 * HIDDEN];
        for f in 0..frames {
            cat[f * 2 * HIDDEN..f * 2 * HIDDEN + HIDDEN]
                .copy_from_slice(&h0[f * HIDDEN..(f + 1) * HIDDEN]);
            cat[f * 2 * HIDDEN + HIDDEN..(f + 1) * 2 * HIDDEN]
                .copy_from_slice(&input[f * HIDDEN..(f + 1) * HIDDEN]);
        }
        let mut h = matmul(&cat, frames, &self.fc2, threads);
        norm_act(&mut h, &self.bn2, HIDDEN, |v| v.max(0.0));
        let mut y = matmul(&h, frames, &self.fc3, threads);
        norm_act(&mut y, &self.bn3, 2 * BINS, |v| v);
        for f in 0..frames {
            for ch in 0..2 {
                let base = (f * 2 + ch) * BINS;
                for b in 0..BINS {
                    let v = y[base + b] * self.output_scale[b] + self.output_mean[b];
                    y[base + b] = v.max(0.0) * mag[base + b];
                }
            }
        }
        y
    }
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut acc = [0.0f32; 8];
    let ((ca, ra), (cb, rb)) = (a.as_chunks::<8>(), b.as_chunks::<8>());
    for (x, y) in ca.iter().zip(cb) {
        for i in 0..8 {
            acc[i] += x[i] * y[i];
        }
    }
    let mut sum: f32 = acc.iter().sum();
    for (x, y) in ra.iter().zip(rb) {
        sum += x * y;
    }
    sum
}

/// `x` (rows x lin.inp) times the transposed weight: rows x lin.out, split over threads.
fn matmul(x: &[f32], rows: usize, lin: &Linear, threads: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; rows * lin.out];
    let per = rows.div_ceil(threads.max(1)).max(1);
    std::thread::scope(|s| {
        for (ci, chunk) in out.chunks_mut(per * lin.out).enumerate() {
            s.spawn(move || {
                for (r, row) in chunk.chunks_mut(lin.out).enumerate() {
                    let xi = &x[(ci * per + r) * lin.inp..][..lin.inp];
                    for (o, cell) in row.iter_mut().enumerate() {
                        *cell = dot(xi, &lin.w[o * lin.inp..][..lin.inp]);
                    }
                }
            });
        }
    });
    out
}

fn norm_act(x: &mut [f32], bn: &BatchNorm, width: usize, act: impl Fn(f32) -> f32) {
    for row in x.chunks_mut(width) {
        for (v, (s, b)) in row.iter_mut().zip(bn.scale.iter().zip(&bn.shift)) {
            *v = act(*v * s + b);
        }
    }
}

fn sigmoid(v: f32) -> f32 {
    1.0 / (1.0 + (-v).exp())
}

/// One direction of one LSTM layer over all frames. Gate order: input, forget, cell, output.
fn run_lstm(x: &[f32], frames: usize, inp: usize, d: &LstmDir, reverse: bool) -> Vec<f32> {
    const H: usize = HIDDEN / 2;
    // The input half of the gates for every frame at once.
    let mut gates_x = vec![0.0f32; frames * 4 * H];
    for f in 0..frames {
        let xi = &x[f * inp..(f + 1) * inp];
        let row = &mut gates_x[f * 4 * H..(f + 1) * 4 * H];
        for (g, cell) in row.iter_mut().enumerate() {
            *cell = dot(xi, &d.w_ih[g * inp..(g + 1) * inp]) + d.bias[g];
        }
    }
    let mut out = vec![0.0f32; frames * H];
    let (mut h, mut c) = ([0.0f32; H], [0.0f32; H]);
    for step in 0..frames {
        let f = if reverse { frames - 1 - step } else { step };
        let gx = &gates_x[f * 4 * H..(f + 1) * 4 * H];
        let mut gates = [0.0f32; 4 * H];
        for (g, cell) in gates.iter_mut().enumerate() {
            *cell = gx[g] + dot(&h, &d.w_hh[g * H..(g + 1) * H]);
        }
        for j in 0..H {
            let (i, fg, g, o) = (
                sigmoid(gates[j]),
                sigmoid(gates[H + j]),
                gates[2 * H + j].tanh(),
                sigmoid(gates[3 * H + j]),
            );
            c[j] = fg * c[j] + i * g;
            h[j] = o * c[j].tanh();
        }
        out[f * H..(f + 1) * H].copy_from_slice(&h);
    }
    out
}

/// The loaded four-stem model.
pub struct Model {
    nets: Vec<(StemKind, Umx)>,
}

impl Model {
    /// Loads the four weight files from `dir` (see [`TARGETS`]).
    pub fn load(dir: &Path) -> Result<Self, String> {
        let mut nets = Vec::new();
        for (kind, file) in TARGETS {
            let bytes = std::fs::read(dir.join(file))
                .map_err(|e| format!("The neural model is not downloaded ({file}: {e})"))?;
            nets.push((kind, Umx::from_bytes(&bytes)?));
        }
        Ok(Self { nets })
    }
}

/// Seconds of audio per piece, and the extra context on each side that is thrown away (the
/// LSTMs need a few seconds to settle).
const PIECE_SECONDS: f64 = 30.0;
const GUARD_SECONDS: f64 = 4.0;

/// Separates `audio` into drums, bass, vocals and other with the neural model.
pub fn separate(
    model: &Model,
    audio: &DecodedAudio,
    sink: &mut dyn StemSink,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<(), String> {
    if audio.rate != 44_100 {
        return Err("The neural model needs a 44.1 kHz recording".into());
    }
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    let stft = Stft::with_frame(N_FFT);
    let len = audio.frames();
    let piece = (PIECE_SECONDS * 44_100.0) as usize;
    let guard = (GUARD_SECONDS * 44_100.0) as usize;
    let pieces = len.div_ceil(piece);
    progress(0.0);
    for p in 0..pieces {
        if cancel.load(Ordering::Relaxed) {
            return Err(super::STOPPED.into());
        }
        let (start, end) = (p * piece, ((p + 1) * piece).min(len));
        let (from, to) = (start.saturating_sub(guard), (end + guard).min(len));
        let n = to - from;
        let (l, r) = (
            stft.analyse(&audio.left[from..to]),
            stft.analyse(&audio.right[from..to]),
        );
        let frames = l.frames();
        let mut mag = vec![0.0f32; frames * 2 * BINS];
        for f in 0..frames {
            for b in 0..BINS {
                mag[(f * 2) * BINS + b] = l.data[f * BINS + b].norm();
                mag[(f * 2 + 1) * BINS + b] = r.data[f * BINS + b].norm();
            }
        }
        let mut estimates = Vec::new();
        for (i, (kind, net)) in model.nets.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Err(super::STOPPED.into());
            }
            estimates.push((*kind, net.estimate(&mag, frames, threads)));
            progress((p as f32 + (i + 1) as f32 / model.nets.len() as f32) / pieces as f32);
        }
        // Soft power-ratio masks.
        let mut power = vec![1e-10f32; mag.len()];
        for (_, e) in &estimates {
            for (p, v) in power.iter_mut().zip(e) {
                *p += v * v;
            }
        }
        let (a, b) = (start - from, end - from);
        for (kind, e) in &estimates {
            let (mut sl, mut sr) = (
                Spec::zeros_with(frames, BINS),
                Spec::zeros_with(frames, BINS),
            );
            for f in 0..frames {
                for bin in 0..BINS {
                    let (il, ir) = ((f * 2) * BINS + bin, (f * 2 + 1) * BINS + bin);
                    let ml = e[il] * e[il] / power[il];
                    let mr = e[ir] * e[ir] / power[ir];
                    sl.data[f * BINS + bin] = l.data[f * BINS + bin] * ml;
                    sr.data[f * BINS + bin] = r.data[f * BINS + bin] * mr;
                }
            }
            let (ol, or) = (stft.synthesise(&sl, n), stft.synthesise(&sr, n));
            sink.write(*kind, &ol[a..b], &or[a..b])?;
        }
    }
    progress(1.0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lstm_cell_follows_the_textbook_equations() {
        // One input, hidden state 128 per gate block would be too large to write by hand, so
        // check a single step against the formulas with simple weights: every weight 0 and the
        // bias chosen per gate.
        let d = LstmDir {
            w_ih: vec![0.0; 4 * 256],
            w_hh: vec![0.0; 4 * 256 * 256],
            bias: (0..4 * 256)
                .map(|g| match g / 256 {
                    0 => 0.0,   // input gate: sigmoid(0) = 0.5
                    1 => 0.0,   // forget gate: irrelevant, c starts at 0
                    2 => 100.0, // cell candidate: tanh(100) = 1
                    _ => 0.0,   // output gate: sigmoid(0) = 0.5
                })
                .collect(),
        };
        let out = run_lstm(&[0.0, 0.0], 2, 1, &d, false);
        // Step 1: c = 0.5 * 1 = 0.5, h = 0.5 * tanh(0.5).
        let h1 = 0.5 * 0.5f32.tanh();
        assert!((out[0] - h1).abs() < 1e-6, "{} vs {h1}", out[0]);
        // Step 2: c = 0.5 * 0.5 + 0.5 * 1 = 0.75, h = 0.5 * tanh(0.75).
        let h2 = 0.5 * 0.75f32.tanh();
        assert!((out[256] - h2).abs() < 1e-6, "{} vs {h2}", out[256]);
        // The reverse direction reads the frames the other way round and gives the same two
        // values swapped for a constant input.
        let rev = run_lstm(&[0.0, 0.0], 2, 1, &d, true);
        assert!((rev[256] - h1).abs() < 1e-6 && (rev[0] - h2).abs() < 1e-6);
    }

    #[test]
    fn the_matrix_product_matches_a_plain_loop() {
        let lin = Linear {
            out: 3,
            inp: 5,
            w: (0..15).map(|i| i as f32 * 0.1 - 0.5).collect(),
        };
        let x: Vec<f32> = (0..10).map(|i| (i as f32).sin()).collect();
        let got = matmul(&x, 2, &lin, 4);
        for r in 0..2 {
            for o in 0..3 {
                let want: f32 = (0..5).map(|i| x[r * 5 + i] * lin.w[o * 5 + i]).sum();
                assert!((got[r * 3 + o] - want).abs() < 1e-5);
            }
        }
    }
}
