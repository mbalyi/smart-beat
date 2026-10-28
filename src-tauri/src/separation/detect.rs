//! Which instruments are in a recording that has no tab (issue #186), from the signal alone.
//!
//! Up to three excerpts of 15 s (at 20 %, 50 % and 80 % of the song; the whole song when it is
//! shorter) go through the separation chain with every stage on. Each part is then judged from
//! the evidence its own stem holds:
//!
//! * drums: share of the energy, onset density and how regular the onsets are;
//! * bass: share of the energy and the fraction of frames with a clear bass note, found by YIN on
//!   the signal with the drums taken out (so a kick does not count as a note);
//! * vocals: share of the energy in the centre stem and its gaps (a voice rests, a leak does not);
//! * panned parts: the hard-panned share of the energy and the panned stem's share.
//!
//! Every feature is a plain number kept in the result, so the benchmark can print them and the
//! thresholds can be tuned against real songs. `confidence` is the weakest feature's soft score
//! (0 to 1, 0.5 at the threshold), and `present` is `confidence >= 0.5`, that is, every feature
//! is on the right side of its threshold.
//!
//! A mono file carries no stereo evidence: vocals and panned parts are reported absent with
//! confidence 0, which means "cannot tell", not "not there".

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use super::stft::{FRAME, HOP, Stft};
use super::{MemorySink, Options, STOPPED, StemKind, bass, separate, stereo};
use crate::audio::backing::DecodedAudio;

/// Length of one analysed excerpt, in seconds.
pub const EXCERPT_SECONDS: f64 = 15.0;
/// Where the excerpts are centred, as a fraction of the song.
pub const EXCERPT_CENTRES: [f64; 3] = [0.2, 0.5, 0.8];
/// An excerpt quieter than this (RMS) is treated as silence and left out of the averages.
pub const SILENCE_RMS: f32 = 1e-4;

// Drums. The drum stem of a song without drums still catches note attacks, so the stem alone is
// not enough: the evidence is hits in the top band of the mix (see `hit_curve`), dense and regular.
/// Share of the mix energy that the drum stem must hold.
pub const DRUMS_MIN_SHARE: f32 = 0.02;
/// Hits per second: fewer is a stray click, more is noise.
pub const DRUMS_MIN_ONSETS: f32 = 1.0;
pub const DRUMS_MAX_ONSETS: f32 = 14.0;
/// Peak of the normalised autocorrelation of the onset curve between 0.2 s and 1.5 s.
pub const DRUMS_MIN_REGULARITY: f32 = 0.35;
/// How much of the top band the strong hits light up at once. Hats and snares light most of it
/// (0.8 on the synthetic band); the high-frequency residue of distorted guitar notes lights a
/// tenth (0.1), and that residue is what a song without drums puts in the drum band.
pub const DRUMS_MIN_STRENGTH: f32 = 0.3;

// Bass.
/// Fraction of the frames that carry bass-range energy and have a clear note (voiced > 0.5).
pub const BASS_MIN_VOICED: f32 = 0.5;
/// Pitch alone cannot tell a bass from a low guitar (YIN also reads the octave below a 110 Hz
/// note as a bass note), so the deciding feature is energy where only a bass lives: the
/// fundamentals of E1 to F#2 (41 to 92 Hz). A guitar's low E (82 Hz) reaches into it, but a song
/// built on guitar has far less there than one with a bass.
pub const BASS_SUB_LO_HZ: f32 = 35.0;
pub const BASS_SUB_HI_HZ: f32 = 90.0;
/// Which quantile of the per-frame share is used (0.4: the bass may rest for a good part of the
/// song, a left-over kick tail may not fill more than that).
pub const BASS_SUB_QUANTILE: f32 = 0.4;
/// Share of a frame's energy in that range, at that quantile.
pub const BASS_MIN_SUB_SHARE: f32 = 0.08;

// Vocals.
/// Share of the mix energy that the centre (vocal) stem must hold.
pub const VOCALS_MIN_SHARE: f32 = 0.008;
/// Fraction of 50 ms blocks in the vocal stem that are quiet (more than 20 dB under its loud
/// blocks). A voice rests between phrases; a smear of leaked sound is on all the time. A track
/// with no rest at all is rare, and this only has to separate it from nothing.
pub const VOCALS_MIN_GAPS: f32 = 0.05;

// Panned parts.
/// Share of the energy above 150 Hz in hard-panned cells (pan beyond 0.6).
pub const PANNED_MIN_SHARE: f32 = 0.15;
/// Share of the mix energy that the panned stem must hold.
pub const PANNED_MIN_STEM_SHARE: f32 = 0.01;

/// Softness of the confidence curve, as a fraction of the threshold.
const SOFTNESS: f32 = 0.25;

/// Drum-stem evidence.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize)]
pub struct DrumsEvidence {
    pub share: f32,
    pub onsets_per_second: f32,
    pub regularity: f32,
    /// How much of the top band a strong hit lights up at once (98th percentile of the hit
    /// curve, 0 to 1).
    pub strength: f32,
}

/// Bass evidence.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize)]
pub struct BassEvidence {
    pub share: f32,
    pub voiced_fraction: f32,
    /// Per-frame share of the drum-free energy between [`BASS_SUB_LO_HZ`] and [`BASS_SUB_HI_HZ`], at a quantile of the frames (see `sub_share`).
    pub sub_share: f32,
    /// Share of the drum-free energy below 250 Hz.
    pub low_share: f32,
}

/// Vocal-stem evidence.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize)]
pub struct VocalsEvidence {
    pub share: f32,
    pub gap_fraction: f32,
}

/// Panned-parts evidence.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize)]
pub struct PannedEvidence {
    pub panned_share: f32,
    pub stem_share: f32,
}

/// One instrument's verdict.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Verdict<E> {
    pub present: bool,
    /// 0 to 1; 0.5 is on the threshold of the weakest feature.
    pub confidence: f32,
    pub evidence: E,
}

/// Experimental, unvalidated: a rough number for "how distorted is the guitar-like part". It has
/// not been checked against real recordings and must not drive any decision yet; it is returned
/// so the benchmark can print it next to the songs and show whether it means anything.
///
/// `high_mid_ratio` is the 2 to 6 kHz energy over the 300 Hz to 2 kHz energy, `flatness` the
/// mean spectral flatness of the stem between 200 Hz and 6 kHz, `index` their blend (0 to 1).
/// The stem is the panned one when there is one, else the drum-free rest.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize)]
pub struct DistortionIndex {
    pub high_mid_ratio: f32,
    pub flatness: f32,
    pub index: f32,
}

/// The result.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Detection {
    /// Left and right are the same signal: no stereo evidence, see the module note.
    pub mono: bool,
    /// The job was stopped; the verdicts use the excerpts finished before that.
    pub cancelled: bool,
    /// Excerpts that were analysed (not silent) and their total length in seconds.
    pub excerpts: usize,
    pub seconds: f32,
    pub drums: Verdict<DrumsEvidence>,
    pub bass: Verdict<BassEvidence>,
    pub vocals: Verdict<VocalsEvidence>,
    pub panned: Verdict<PannedEvidence>,
    pub distortion_index: DistortionIndex,
}

/// Soft score of `x` against `threshold`: 0.5 on it, towards 1 above, towards 0 below.
fn above(x: f32, threshold: f32) -> f32 {
    1.0 / (1.0 + (-(x - threshold) / (SOFTNESS * threshold)).exp())
}

/// Soft score of `x` inside `lo..=hi`.
fn between(x: f32, lo: f32, hi: f32) -> f32 {
    above(x, lo).min(1.0 - above(x, hi))
}

fn verdict<E>(confidence: f32, evidence: E) -> Verdict<E> {
    Verdict {
        present: confidence >= 0.5,
        confidence,
        evidence,
    }
}

fn mid(l: &[f32], r: &[f32]) -> Vec<f32> {
    l.iter().zip(r).map(|(a, b)| 0.5 * (a + b)).collect()
}

fn energy2(l: &[f32], r: &[f32]) -> f64 {
    l.iter().map(|v| (*v as f64).powi(2)).sum::<f64>()
        + r.iter().map(|v| (*v as f64).powi(2)).sum::<f64>()
}

/// Energy per `hop` samples, as RMS.
fn rms_blocks(x: &[f32], len: usize) -> Vec<f32> {
    x.chunks(len)
        .map(|c| (c.iter().map(|v| v * v).sum::<f32>() / c.len() as f32).sqrt())
        .collect()
}

/// Onsets per second and regularity of an onset curve.
fn onset_stats(curve: &[f32], rate: f32) -> (f32, f32, f32) {
    let secs = curve.len() as f32 * HOP as f32 / rate;
    let mut sorted: Vec<f32> = curve.to_vec();
    sorted.sort_by(f32::total_cmp);
    let top = sorted
        .get(sorted.len().saturating_sub(1 + sorted.len() / 50))
        .copied()
        .unwrap_or(0.0);
    if top <= 0.0 || secs <= 0.0 {
        return (0.0, 0.0, 0.0);
    }
    // A peak: the largest within +-4 frames (46 ms) and at least a fifth of the strong ones.
    let floor = 0.2 * top;
    let mut count = 0usize;
    for t in 0..curve.len() {
        let v = curve[t];
        if v < floor {
            continue;
        }
        let lo = t.saturating_sub(4);
        let hi = (t + 5).min(curve.len());
        if curve[lo..hi].iter().all(|&w| w <= v) && curve[lo..t].iter().all(|&w| w < v) {
            count += 1;
        }
    }
    // Normalised autocorrelation between 0.2 s and 1.5 s.
    let mean = curve.iter().sum::<f32>() / curve.len() as f32;
    let c: Vec<f32> = curve.iter().map(|v| v - mean).collect();
    let zero: f32 = c.iter().map(|v| v * v).sum();
    let frames_per_s = rate / HOP as f32;
    let (lag_lo, lag_hi) = ((0.2 * frames_per_s) as usize, (1.5 * frames_per_s) as usize);
    let mut regularity = 0.0f32;
    if zero > 0.0 {
        for lag in lag_lo..lag_hi.min(c.len().saturating_sub(1)) {
            let n = c.len() - lag;
            let r: f32 = (0..n).map(|i| c[i] * c[i + lag]).sum::<f32>() / zero;
            // Rescale for the shrinking overlap so long lags are not punished.
            regularity = regularity.max(r * c.len() as f32 / n as f32);
        }
    }
    (count as f32 / secs, regularity.clamp(0.0, 1.0), top)
}

/// Mean spectral flatness (geometric over arithmetic mean of the power) between `lo` and `hi` Hz,
/// over the frames whose energy in that range is at least a quarter of the mean.
fn mean_flatness(spec: &super::stft::Spec, rate: f32, lo: f32, hi: f32) -> f32 {
    let hz = rate / FRAME as f32;
    let (b0, b1) = (
        (lo / hz) as usize,
        ((hi / hz) as usize).min(super::stft::BINS - 1),
    );
    if b1 <= b0 {
        return 0.0;
    }
    let frames: Vec<(f32, f32)> = (0..spec.frames())
        .map(|t| {
            let row = &spec.data[t * super::stft::BINS..(t + 1) * super::stft::BINS];
            let p: Vec<f32> = row[b0..=b1].iter().map(|c| c.norm_sqr() + 1e-12).collect();
            let arith = p.iter().sum::<f32>() / p.len() as f32;
            let geo = (p.iter().map(|v| v.ln()).sum::<f32>() / p.len() as f32).exp();
            (arith, geo / arith)
        })
        .collect();
    if frames.is_empty() {
        return 0.0;
    }
    let mean = frames.iter().map(|f| f.0).sum::<f32>() / frames.len() as f32;
    let loud: Vec<f32> = frames
        .iter()
        .filter(|f| f.0 >= 0.25 * mean && f.0 > 1e-8)
        .map(|f| f.1)
        .collect();
    if loud.is_empty() {
        0.0
    } else {
        loud.iter().sum::<f32>() / loud.len() as f32
    }
}

/// Lower and upper edge of the band the drum hits are looked for in: where hats, cymbals and the
/// noise of a snare live, above what a distorted guitar or a voice fills.
pub const HITS_LO_HZ: f32 = 4_000.0;
pub const HITS_HI_HZ: f32 = 16_000.0;

/// Hit curve: per frame, the fraction of the bins between [`HITS_LO_HZ`] and [`HITS_HI_HZ`] that
/// rose by 6 dB or more over the two frames before. A hat or a snare lights up much of that band
/// at once; the attack of a pitched note, even a distorted one, does not reach it. Measured on
/// the mix itself, so it does not depend on how good the drum stem is.
fn hit_curve(spec: &super::stft::Spec, rate: f32) -> Vec<f32> {
    let hz = rate / FRAME as f32;
    let (b0, b1) = (
        (HITS_LO_HZ / hz) as usize,
        ((HITS_HI_HZ / hz) as usize).min(super::stft::BINS - 1),
    );
    let power = |t: usize, b: usize| spec.data[t * super::stft::BINS + b].norm_sqr();
    let top = spec
        .data
        .iter()
        .map(|c| c.norm_sqr())
        .fold(0.0f32, f32::max);
    let floor = top * 1e-6;
    let mut out = vec![0.0f32; spec.frames()];
    for (t, slot) in out.iter_mut().enumerate().skip(2) {
        let risen = (b0..=b1)
            .filter(|&b| {
                let p = power(t, b);
                p > floor && p >= 4.0 * power(t - 1, b).max(power(t - 2, b))
            })
            .count();
        *slot = risen as f32 / (b1 - b0 + 1) as f32;
    }
    out
}

/// The share of a frame's energy that sits between [`BASS_SUB_LO_HZ`] and [`BASS_SUB_HI_HZ`],
/// taken at the [`BASS_SUB_QUANTILE`] of the loud frames. A quantile, not a sum, so the tail of a
/// kick that the drum stage left behind (a few frames per beat) does not read as a bass.
fn sub_share(spec: &super::stft::Spec, rate: f32) -> f32 {
    let hz = rate / FRAME as f32;
    let (b0, b1) = (
        (BASS_SUB_LO_HZ / hz) as usize,
        (BASS_SUB_HI_HZ / hz) as usize,
    );
    let rows: Vec<(f32, f32)> = (0..spec.frames())
        .map(|t| {
            let row = &spec.data[t * super::stft::BINS..(t + 1) * super::stft::BINS];
            let all: f32 = row.iter().map(|c| c.norm_sqr()).sum();
            let sub: f32 = row[b0..=b1].iter().map(|c| c.norm_sqr()).sum();
            (all, sub)
        })
        .collect();
    let mean = rows.iter().map(|r| r.0).sum::<f32>() / rows.len().max(1) as f32;
    let mut shares: Vec<f32> = rows
        .iter()
        .filter(|r| r.0 >= 0.25 * mean && r.0 > 1e-8)
        .map(|r| r.1 / r.0)
        .collect();
    if shares.is_empty() {
        return 0.0;
    }
    shares.sort_by(f32::total_cmp);
    shares[((shares.len() - 1) as f32 * BASS_SUB_QUANTILE) as usize]
}

/// Mean-power spectrum summed over the frames, in dB-free linear power per bin.
fn band_power(spec: &super::stft::Spec, rate: f32, lo: f32, hi: f32) -> f64 {
    let hz = rate / FRAME as f32;
    let (b0, b1) = (
        (lo / hz) as usize,
        ((hi / hz) as usize).min(super::stft::BINS - 1),
    );
    let mut sum = 0.0f64;
    for t in 0..spec.frames() {
        let row = &spec.data[t * super::stft::BINS..(t + 1) * super::stft::BINS];
        sum += row[b0..=b1]
            .iter()
            .map(|c| c.norm_sqr() as f64)
            .sum::<f64>();
    }
    sum
}

/// Features of one excerpt.
#[derive(Default)]
struct Excerpt {
    drums: DrumsEvidence,
    bass: BassEvidence,
    vocals: VocalsEvidence,
    panned: PannedEvidence,
    distortion: DistortionIndex,
    seconds: f32,
}

fn analyse(audio: &DecodedAudio, sink: &MemorySink, panned_share: f32) -> Excerpt {
    let rate = audio.rate as f32;
    let total = energy2(&audio.left, &audio.right).max(1e-20);
    let stft = Stft::new();
    let share = |kind: StemKind| -> f32 {
        sink.stems
            .get(&kind)
            .map_or(0.0, |(l, r)| (energy2(l, r) / total) as f32)
    };
    let stem_mid = |kind: StemKind| -> Vec<f32> {
        sink.stems
            .get(&kind)
            .map_or_else(Vec::new, |(l, r)| mid(l, r))
    };
    let mix_mid = mid(&audio.left, &audio.right);
    let mut out = Excerpt {
        seconds: audio.frames() as f32 / rate,
        ..Excerpt::default()
    };

    // Drums.
    let drums = stem_mid(StemKind::Drums);
    let (onsets, regularity, strength) =
        onset_stats(&hit_curve(&stft.analyse(&mix_mid), rate), rate);
    out.drums = DrumsEvidence {
        share: share(StemKind::Drums),
        onsets_per_second: onsets,
        regularity,
        strength,
    };

    // Bass, on the signal with the drums taken out.
    let free: Vec<f32> = mix_mid.iter().zip(&drums).map(|(m, d)| m - d).collect();
    let frames = Stft::frame_count(free.len());
    let free_spec = stft.analyse(&free);
    let low = band_power(&free_spec, rate, 0.0, bass::MAX_HZ);
    let all = band_power(&free_spec, rate, 0.0, rate / 2.0).max(1e-20);
    let pitches = bass::track(&free, rate, frames);
    // Only frames that carry bass-range energy count, so silence and rests do not dilute it.
    let hz = rate / FRAME as f32;
    let b_hi = (bass::MAX_HZ / hz) as usize;
    let low_energy: Vec<f32> = (0..free_spec.frames())
        .map(|t| {
            free_spec.data[t * super::stft::BINS..t * super::stft::BINS + b_hi]
                .iter()
                .map(|c| c.norm_sqr())
                .sum()
        })
        .collect();
    let mean_low = low_energy.iter().sum::<f32>() / low_energy.len().max(1) as f32;
    let (mut voiced, mut counted) = (0usize, 0usize);
    for (p, e) in pitches.iter().zip(&low_energy) {
        if *e >= 0.25 * mean_low && *e > 1e-6 {
            counted += 1;
            if p.voiced > 0.5 {
                voiced += 1;
            }
        }
    }
    out.bass = BassEvidence {
        share: share(StemKind::Bass),
        voiced_fraction: if counted == 0 {
            0.0
        } else {
            voiced as f32 / counted as f32
        },
        sub_share: sub_share(&free_spec, rate),
        low_share: (low / all) as f32,
    };

    // Vocals.
    let vocals = stem_mid(StemKind::Vocals);
    let blocks = rms_blocks(&vocals, (0.05 * rate) as usize);
    let loud = {
        let mut s = blocks.clone();
        s.sort_by(f32::total_cmp);
        s.get(s.len().saturating_sub(1 + s.len() / 10))
            .copied()
            .unwrap_or(0.0)
    };
    out.vocals = VocalsEvidence {
        share: share(StemKind::Vocals),
        gap_fraction: if loud <= 0.0 {
            0.0
        } else {
            blocks.iter().filter(|b| **b < 0.1 * loud).count() as f32 / blocks.len() as f32
        },
    };

    // Panned parts.
    out.panned = PannedEvidence {
        panned_share,
        stem_share: share(StemKind::Panned),
    };

    // Distortion: the panned stem when it holds something, else the drum-free rest.
    let source = if out.panned.stem_share > 1e-3 {
        stem_mid(StemKind::Panned)
    } else {
        free
    };
    let spec = stft.analyse(&source);
    let mid_band = band_power(&spec, rate, 300.0, 2_000.0).max(1e-20);
    let ratio = (band_power(&spec, rate, 2_000.0, 6_000.0) / mid_band) as f32;
    let flat = mean_flatness(&spec, rate, 200.0, 6_000.0);
    out.distortion = DistortionIndex {
        high_mid_ratio: ratio,
        flatness: flat,
        index: (0.5 * ratio / (1.0 + ratio) + 0.5 * flat).clamp(0.0, 1.0),
    };
    out
}

/// Start sample of each excerpt: 15 s windows centred at 20, 50 and 80 % of the song, moved to
/// fit inside it, keeping only those that do not overlap an earlier one. A song of 15 s or less
/// is one excerpt, whole.
fn excerpt_ranges(len: usize, rate: u32) -> Vec<(usize, usize)> {
    let want = (EXCERPT_SECONDS * rate as f64) as usize;
    if len <= want {
        return vec![(0, len)];
    }
    let mut out: Vec<(usize, usize)> = Vec::new();
    for c in EXCERPT_CENTRES {
        let start = ((c * len as f64) as usize)
            .saturating_sub(want / 2)
            .min(len - want);
        if out.last().is_none_or(|(_, prev_end)| start >= *prev_end) {
            out.push((start, start + want));
        }
    }
    out
}

fn mean<T>(items: &[T], f: impl Fn(&T) -> f32) -> f32 {
    if items.is_empty() {
        0.0
    } else {
        items.iter().map(f).sum::<f32>() / items.len() as f32
    }
}

/// Detects the parts of `audio` without a tab. `cancel` is checked between excerpts (and inside
/// the separation, which checks it between segments).
pub fn detect(audio: &DecodedAudio, cancel: &AtomicBool) -> Detection {
    let mono = stereo::is_mono(&audio.left, &audio.right);
    let mut done: Vec<Excerpt> = Vec::new();
    let mut cancelled = false;
    for (from, to) in excerpt_ranges(audio.frames(), audio.rate) {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let piece = DecodedAudio {
            rate: audio.rate,
            channels: audio.channels,
            left: audio.left[from..to].to_vec(),
            right: audio.right[from..to].to_vec(),
        };
        let level = (energy2(&piece.left, &piece.right) / (2.0 * piece.left.len().max(1) as f64))
            .sqrt() as f32;
        if level < SILENCE_RMS {
            continue;
        }
        let mut sink = MemorySink::default();
        match separate(&piece, &Options::default(), &mut sink, cancel, &mut |_| {}) {
            Ok(report) => done.push(analyse(&piece, &sink, report.panned_share)),
            Err(e) if e == STOPPED => {
                cancelled = true;
                break;
            }
            Err(_) => break,
        }
    }

    let drums = DrumsEvidence {
        share: mean(&done, |e| e.drums.share),
        onsets_per_second: mean(&done, |e| e.drums.onsets_per_second),
        regularity: mean(&done, |e| e.drums.regularity),
        strength: mean(&done, |e| e.drums.strength),
    };
    let bass = BassEvidence {
        share: mean(&done, |e| e.bass.share),
        voiced_fraction: mean(&done, |e| e.bass.voiced_fraction),
        sub_share: mean(&done, |e| e.bass.sub_share),
        low_share: mean(&done, |e| e.bass.low_share),
    };
    let vocals = VocalsEvidence {
        share: mean(&done, |e| e.vocals.share),
        gap_fraction: mean(&done, |e| e.vocals.gap_fraction),
    };
    let panned = PannedEvidence {
        panned_share: mean(&done, |e| e.panned.panned_share),
        stem_share: mean(&done, |e| e.panned.stem_share),
    };
    let distortion_index = DistortionIndex {
        high_mid_ratio: mean(&done, |e| e.distortion.high_mid_ratio),
        flatness: mean(&done, |e| e.distortion.flatness),
        index: mean(&done, |e| e.distortion.index),
    };

    let have = !done.is_empty();
    let score = |c: f32| if have { c } else { 0.0 };
    let drums_conf = score(
        above(drums.share, DRUMS_MIN_SHARE)
            .min(between(
                drums.onsets_per_second,
                DRUMS_MIN_ONSETS,
                DRUMS_MAX_ONSETS,
            ))
            .min(above(drums.regularity, DRUMS_MIN_REGULARITY))
            .min(above(drums.strength, DRUMS_MIN_STRENGTH)),
    );
    let bass_conf = score(
        above(bass.voiced_fraction, BASS_MIN_VOICED).min(above(bass.sub_share, BASS_MIN_SUB_SHARE)),
    );
    let vocals_conf = if mono {
        0.0
    } else {
        score(
            above(vocals.share, VOCALS_MIN_SHARE).min(above(vocals.gap_fraction, VOCALS_MIN_GAPS)),
        )
    };
    let panned_conf = if mono {
        0.0
    } else {
        score(
            above(panned.panned_share, PANNED_MIN_SHARE)
                .min(above(panned.stem_share, PANNED_MIN_STEM_SHARE)),
        )
    };

    Detection {
        mono,
        cancelled,
        excerpts: done.len(),
        seconds: done.iter().map(|e| e.seconds).sum(),
        drums: verdict(drums_conf, drums),
        bass: verdict(bass_conf, bass),
        vocals: verdict(vocals_conf, vocals),
        panned: verdict(panned_conf, panned),
        distortion_index,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::separation::synth::{self, Band, Stereo};

    fn audio(mix: &Stereo) -> DecodedAudio {
        DecodedAudio {
            rate: synth::RATE,
            channels: 2,
            left: mix.left.clone(),
            right: mix.right.clone(),
        }
    }

    /// The band without the parts named in `drop` (any of "drums", "bass", "vocals", "guitars").
    fn without(band: &Band, drop: &[&str]) -> Stereo {
        let parts: Vec<&Stereo> = [
            ("drums", &band.drums),
            ("bass", &band.bass),
            ("vocals", &band.vocals),
            ("guitars", &band.guitars),
        ]
        .into_iter()
        .filter(|(n, _)| !drop.contains(n))
        .map(|(_, s)| s)
        .collect();
        Stereo::mix(&parts)
    }

    fn run(label: &str, mix: &Stereo) -> Detection {
        let d = detect(&audio(mix), &AtomicBool::new(false));
        println!(
            "{label}: mono={} drums[{:.2}] share={:.3} ons={:.1} reg={:.2} str={:.3} | bass[{:.2}] share={:.3} voiced={:.2} sub={:.3} low={:.2} | vocals[{:.2}] share={:.3} gaps={:.2} | panned[{:.2}] ps={:.2} share={:.3} | dist={:?}",
            d.mono,
            d.drums.confidence,
            d.drums.evidence.share,
            d.drums.evidence.onsets_per_second,
            d.drums.evidence.regularity,
            d.drums.evidence.strength,
            d.bass.confidence,
            d.bass.evidence.share,
            d.bass.evidence.voiced_fraction,
            d.bass.evidence.sub_share,
            d.bass.evidence.low_share,
            d.vocals.confidence,
            d.vocals.evidence.share,
            d.vocals.evidence.gap_fraction,
            d.panned.confidence,
            d.panned.evidence.panned_share,
            d.panned.evidence.stem_share,
            d.distortion_index
        );
        d
    }

    fn flags(d: &Detection) -> [bool; 4] {
        [
            d.drums.present,
            d.bass.present,
            d.vocals.present,
            d.panned.present,
        ]
    }

    #[test]
    fn a_full_band_has_every_part() {
        let band = synth::band(20.0);
        let tot = energy2(&band.mix.left, &band.mix.right);
        for (n, p) in [
            ("drums", &band.drums),
            ("bass", &band.bass),
            ("vocals", &band.vocals),
            ("guitars", &band.guitars),
        ] {
            println!("true share {n}: {:.3}", energy2(&p.left, &p.right) / tot);
        }
        let d = run("full", &band.mix);
        assert_eq!(flags(&d), [true, true, true, true], "{d:#?}");
        assert!(!d.mono && !d.cancelled);
        assert!(serde_json::to_string(&d).is_ok());
    }

    #[test]
    fn no_drums() {
        let band = synth::band(20.0);
        let d = run("no drums", &without(&band, &["drums"]));
        assert_eq!(flags(&d), [false, true, true, true], "{d:#?}");
    }

    #[test]
    fn no_bass() {
        let band = synth::band(20.0);
        let d = run("no bass", &without(&band, &["bass"]));
        assert_eq!(flags(&d), [true, false, true, true], "{d:#?}");
    }

    #[test]
    fn no_vocals() {
        let band = synth::band(20.0);
        let d = run("no vocals", &without(&band, &["vocals"]));
        assert_eq!(flags(&d), [true, true, false, true], "{d:#?}");
    }

    #[test]
    fn no_guitars() {
        let band = synth::band(20.0);
        // All that is left is centred; a slightly quieter right channel keeps it stereo.
        let centred = without(&band, &["guitars"]);
        let wide = Stereo {
            right: centred.left.iter().map(|v| v * 0.8).collect(),
            left: centred.left,
        };
        let d = run("no guitars", &wide);
        assert!(!d.mono);
        assert_eq!(flags(&d), [true, true, true, false], "{d:#?}");
    }

    #[test]
    fn a_mono_mix_gives_no_stereo_verdicts() {
        let band = synth::band(20.0);
        let mono = Stereo {
            left: band.mix.left.clone(),
            right: band.mix.left.clone(),
        };
        let d = run("mono", &mono);
        assert!(d.mono);
        assert_eq!(flags(&d), [true, true, false, false], "{d:#?}");
        assert_eq!(d.vocals.confidence, 0.0);
    }

    #[test]
    fn silence_has_nothing_and_a_stopped_job_says_so() {
        let silent = Stereo::silent(44_100 * 5);
        let d = run("silence", &silent);
        assert_eq!(flags(&d), [false; 4]);
        assert_eq!(d.excerpts, 0);

        let band = synth::band(20.0);
        let d = detect(&audio(&band.mix), &AtomicBool::new(true));
        assert!(d.cancelled);
        assert_eq!(flags(&d), [false; 4]);
    }

    #[test]
    fn excerpts_cover_a_long_song_and_a_short_one_whole() {
        let rate = 44_100u32;
        let r = excerpt_ranges(rate as usize * 200, rate);
        assert_eq!(r.len(), 3);
        assert!(r.iter().all(|(a, b)| b - a == rate as usize * 15));
        assert_eq!(excerpt_ranges(rate as usize * 10, rate), vec![(0, 441_000)]);
        // 20 s: the windows overlap, so only the first is kept... plus none that overlap it.
        assert_eq!(excerpt_ranges(rate as usize * 20, rate).len(), 1);
    }
}
