//! Tempo (BPM) detection for a finished recording, offline and without a model (issue #186).
//!
//! The pipeline is the classic one, written from the papers:
//!
//! 1. **Onset strength**: a short-time spectrum, grouped into mel-spaced bands, log-compressed,
//!    then a half-wave rectified difference against the loudest neighbour band of the previous
//!    frame (a SuperFlux-style flux, Böck and Widmer 2013). The log compression and the equal
//!    weight of the bands let hi-hat content count as much as kick and snare. The drums stem and
//!    the full mix are conditioned and added when the drums stem has real content.
//! 2. **Tempo**: the autocorrelation of the onset strength, with the lags of 2x and 4x and half
//!    of the period added (a pulse is also periodic over longer spans and has a subdivision),
//!    weighted by a log-normal prior around 115 BPM to reduce octave errors (Ellis 2007;
//!    Klapuri et al. 2006).
//! 3. **Beats**: dynamic programming over the onset strength with a log-Gaussian penalty on the
//!    interval deviating from the tempo (Ellis 2007, "Beat tracking by dynamic programming").
//!    A robust line fit through the beat times gives the exact tempo (much finer than the
//!    autocorrelation lags) and the phase of the grid.
//! 4. **Sections**: the same estimate in windows of 20 s every 5 s. A change is reported only
//!    when at least two windows in a row agree on a tempo at least 8 % away from its
//!    neighbours; a live drummer who drifts by a few BPM stays one steady tempo.
//!
//! The DSP here is free of Tauri; [`crate::stems::tempo`] feeds it with a stored song.

use realfft::RealFftPlanner;
use serde::{Deserialize, Serialize};

/// Bump when the result can change for the same audio; cached results of another version are
/// recomputed.
pub const ALGORITHM_VERSION: u8 = 1;

/// What the user sees when a job is cancelled.
pub const STOPPED: &str = "Tempo detection stopped.";

/// Search range of the tempo.
pub const MIN_BPM: f64 = 30.0;
pub const MAX_BPM: f64 = 300.0;

/// The centre (in BPM) and the width (in octaves) of the tempo prior.
const PRIOR_CENTRE: f64 = 115.0;
const PRIOR_SIGMA_OCTAVES: f64 = 0.7;

/// Analysis windows for tempo changes.
const WINDOW_SEC: f64 = 20.0;
const HOP_SEC: f64 = 5.0;
/// A change smaller than this is a drifting drummer, not a new tempo.
const SECTION_CHANGE: f64 = 0.08;
/// Windows within this of their run's tempo belong to the run (below [`SECTION_CHANGE`], so a
/// real change of 8 % always starts a new run).
const RUN_TOLERANCE: f64 = 0.06;
/// A run needs this many windows in a row (two windows span 25 s).
const MIN_RUN_WINDOWS: usize = 2;
/// A tempo that lasts less than this is not a section.
const MIN_SECTION_SEC: f64 = 15.0;
/// Shortest recording that is analysed at all.
const MIN_SECONDS: f64 = 5.0;
/// Windowed analysis needs a recording at least this long.
const MIN_SECTION_SECONDS: f64 = 45.0;
/// A window whose autocorrelation peak is below this has no clear tempo.
const WINDOW_MIN_PERIODICITY: f32 = 0.12;
/// How much the autocorrelation at half the period (the subdivision of a beat) adds to a tempo
/// candidate. Without it a dotted-eighth pulse (4/3 of the beat) can beat the beat itself.
const SUBDIVISION_WEIGHT: f32 = 0.5;
/// Beat tracking: how strongly an interval off the tempo is punished (Ellis uses 100).
const TIGHTNESS: f32 = 100.0;

/// One stretch of the song with its own tempo.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub start_sec: f64,
    pub end_sec: f64,
    pub bpm: f64,
}

/// The detected tempo. Mirrored by `StemTempo` in `src/lib/tauri.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tempo {
    /// Beats per minute, 0 when there is nothing to measure (silence, a clip of a few seconds).
    pub bpm: f64,
    /// 0 to 1: how clearly the song pulses at that tempo.
    pub confidence: f64,
    /// The first grid beat at or after the start of the file, in seconds.
    pub first_beat_sec: f64,
    /// Other plausible tempos (half and double time, the next peaks), best first.
    pub alternatives: Vec<f64>,
    /// One tempo from start to end (a few BPM of drift is still steady).
    pub steady: bool,
    /// Large and lasting tempo changes, covering the song from 0 to its end. Empty when steady.
    pub sections: Vec<Section>,
}

impl Tempo {
    fn none() -> Self {
        Self {
            bpm: 0.0,
            confidence: 0.0,
            first_beat_sec: 0.0,
            alternatives: Vec::new(),
            steady: true,
            sections: Vec::new(),
        }
    }
}

/// The tempo together with the beat times of the grid (not stored, used by the tests and the
/// benchmark).
#[derive(Debug, Clone, PartialEq)]
pub struct Analysis {
    pub tempo: Tempo,
    /// Beat times in seconds as the tracker found them.
    pub beats: Vec<f64>,
}

/// The job was cancelled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stopped;

type Cancel<'a> = &'a dyn Fn() -> bool;

fn check(stop: Cancel) -> Result<(), Stopped> {
    if stop() { Err(Stopped) } else { Ok(()) }
}

// ---------------------------------------------------------------------------------------------
// Onset strength
// ---------------------------------------------------------------------------------------------

/// Onset strength per frame.
#[derive(Debug, Clone)]
pub struct Envelope {
    pub values: Vec<f32>,
    pub fps: f64,
}

fn frame_and_hop(rate: u32) -> (usize, usize) {
    if rate >= 32_000 {
        (1024, 256)
    } else {
        (512, 128)
    }
}

fn mel(hz: f64) -> f64 {
    2595.0 * (1.0 + hz / 700.0).log10()
}

fn inv_mel(m: f64) -> f64 {
    700.0 * (10f64.powf(m / 2595.0) - 1.0)
}

/// Bin ranges `[from, to)` of about 24 mel-spaced bands between 40 Hz and 12 kHz (or just under
/// Nyquist), every one at least one bin wide.
fn band_edges(rate: u32, frame: usize) -> Vec<usize> {
    let bins = frame / 2 + 1;
    let top_hz = (f64::from(rate) / 2.0 * 0.95).min(12_000.0);
    let (lo, hi) = (mel(40.0), mel(top_hz));
    let bands = 24;
    let mut edges: Vec<usize> = Vec::new();
    for i in 0..=bands {
        let hz = inv_mel(lo + (hi - lo) * i as f64 / bands as f64);
        let mut bin = (hz / f64::from(rate) * frame as f64).round() as usize;
        bin = bin.max(1);
        if let Some(&last) = edges.last() {
            bin = bin.max(last + 1);
        }
        edges.push(bin.min(bins - 1));
    }
    edges.dedup();
    edges
}

/// The raw onset strength of a mono signal (see the module docs): one value per hop, about 172
/// per second at 44.1 kHz.
pub fn onset_envelope(x: &[f32], rate: u32, stop: Cancel) -> Result<Envelope, Stopped> {
    let (frame, hop) = frame_and_hop(rate);
    let fps = f64::from(rate) / hop as f64;
    let frames = x.len() / hop + 1;
    let edges = band_edges(rate, frame);
    let bands = edges.len() - 1;
    let window: Vec<f32> = (0..frame)
        .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / frame as f32).cos())
        .collect();
    let fft = RealFftPlanner::<f32>::new().plan_fft_forward(frame);
    let mut scratch = fft.make_scratch_vec();
    let mut buf = vec![0.0f32; frame];
    let mut spectrum = fft.make_output_vec();
    // A sine of amplitude 1 has the magnitude frame / 4 at its bin.
    let norm = 4.0 / frame as f32;
    let mut previous = vec![0.0f32; bands];
    let mut current = vec![0.0f32; bands];
    let mut values = Vec::with_capacity(frames);
    for t in 0..frames {
        if t % 256 == 0 {
            check(stop)?;
        }
        let start = (t * hop) as isize - (frame / 2) as isize;
        for (i, b) in buf.iter_mut().enumerate() {
            let pos = start + i as isize;
            *b = if pos >= 0 && (pos as usize) < x.len() {
                x[pos as usize] * window[i]
            } else {
                0.0
            };
        }
        // The sizes are fixed, so this cannot fail.
        let _ = fft.process_with_scratch(&mut buf, &mut spectrum, &mut scratch);
        for b in 0..bands {
            let (from, to) = (edges[b], edges[b + 1]);
            let sum: f32 = spectrum[from..to].iter().map(|c| c.norm()).sum();
            let mean = sum / (to - from) as f32 * norm;
            current[b] = (1000.0 * mean).ln_1p();
        }
        let mut flux = 0.0f32;
        for b in 0..bands {
            let reference = previous[b.saturating_sub(1)..(b + 2).min(bands)]
                .iter()
                .fold(0.0f32, |m, &v| m.max(v));
            flux += (current[b] - reference).max(0.0);
        }
        values.push(flux / bands as f32);
        std::mem::swap(&mut previous, &mut current);
    }
    Ok(Envelope { values, fps })
}

/// Moving average with a box of `2 * radius + 1` values (shorter at the edges).
fn moving_average(x: &[f32], radius: usize) -> Vec<f32> {
    let mut prefix = Vec::with_capacity(x.len() + 1);
    let mut sum = 0.0f64;
    prefix.push(0.0);
    for &v in x {
        sum += f64::from(v);
        prefix.push(sum);
    }
    (0..x.len())
        .map(|i| {
            let (a, b) = (i.saturating_sub(radius), (i + radius + 1).min(x.len()));
            ((prefix[b] - prefix[a]) / (b - a) as f64) as f32
        })
        .collect()
}

fn std_dev(x: &[f32]) -> f32 {
    if x.is_empty() {
        return 0.0;
    }
    let mean = x.iter().map(|&v| f64::from(v)).sum::<f64>() / x.len() as f64;
    let var = x
        .iter()
        .map(|&v| (f64::from(v) - mean).powi(2))
        .sum::<f64>()
        / x.len() as f64;
    var.sqrt() as f32
}

/// The envelope with its slow trend taken out (so a loud passage does not hide the beat),
/// rectified, lightly smoothed, and scaled to unit standard deviation. All zeros for a flat one.
fn condition(env: &Envelope) -> Vec<f32> {
    let radius = (env.fps * 0.5) as usize;
    let trend = moving_average(&env.values, radius);
    let mut o: Vec<f32> = env
        .values
        .iter()
        .zip(&trend)
        .map(|(&v, &m)| (v - m).max(0.0))
        .collect();
    // [1 2 1] / 4 smoothing spreads a hit that falls between two frames.
    let copy = o.clone();
    for i in 1..o.len().saturating_sub(1) {
        o[i] = 0.25 * copy[i - 1] + 0.5 * copy[i] + 0.25 * copy[i + 1];
    }
    let sd = std_dev(&o);
    if sd > 1e-9 {
        for v in &mut o {
            *v /= sd;
        }
    } else {
        o.iter_mut().for_each(|v| *v = 0.0);
    }
    o
}

fn rms(x: &[f32]) -> f32 {
    if x.is_empty() {
        return 0.0;
    }
    (x.iter().map(|&v| f64::from(v).powi(2)).sum::<f64>() / x.len() as f64).sqrt() as f32
}

// ---------------------------------------------------------------------------------------------
// Tempo from the autocorrelation
// ---------------------------------------------------------------------------------------------

/// Normalised autocorrelation of the mean-free envelope for lags `0..=max_lag`: 1 at lag 0,
/// near 1 at the period of a perfectly regular pulse, near 0 for noise.
fn autocorrelation(o: &[f32], max_lag: usize) -> Vec<f32> {
    let n = o.len();
    let mean = o.iter().sum::<f32>() / n.max(1) as f32;
    let c: Vec<f32> = o.iter().map(|&v| v - mean).collect();
    let energy: f32 = c.iter().map(|v| v * v).sum::<f32>() / n.max(1) as f32;
    let max_lag = max_lag.min(n.saturating_sub(1));
    let mut acf = vec![0.0f32; max_lag + 1];
    if energy <= 1e-12 {
        return acf;
    }
    for (lag, slot) in acf.iter_mut().enumerate() {
        let m = n - lag;
        if m < n / 4 {
            break;
        }
        let dot: f32 = c[..m].iter().zip(&c[lag..]).map(|(a, b)| a * b).sum();
        *slot = dot / m as f32 / energy;
    }
    acf
}

fn prior(bpm: f64) -> f64 {
    let d = (bpm / PRIOR_CENTRE).log2() / PRIOR_SIGMA_OCTAVES;
    (-0.5 * d * d).exp()
}

/// A tempo peak of the autocorrelation.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Candidate {
    bpm: f64,
    /// Score including the prior; the best candidate has the highest.
    score: f32,
    /// The autocorrelation at the period itself, 0 to 1.
    periodicity: f32,
}

fn lag_range(fps: f64) -> (usize, usize) {
    (
        (fps * 60.0 / MAX_BPM).floor().max(2.0) as usize,
        (fps * 60.0 / MIN_BPM).ceil() as usize,
    )
}

/// The tempo peaks of `o`, best first. `multiples` is how many multiples of the period are
/// added (1 = only the period, 2 = also twice, 4 = also four times).
fn candidates(o: &[f32], fps: f64, multiples: usize) -> Vec<Candidate> {
    let (lo, hi) = lag_range(fps);
    let max_lag = hi * multiples;
    let acf = autocorrelation(o, max_lag);
    if acf.len() <= lo + 2 {
        return Vec::new();
    }
    let hi = hi.min(acf.len() - 2);
    let at = |lag: usize| acf.get(lag).copied().unwrap_or(0.0);
    // Each fundamental sums the period and the available longer multiples.
    let raw: Vec<f32> = (lo - 1..=hi + 1)
        .map(|lag| {
            let mut s = at(lag) + SUBDIVISION_WEIGHT * 0.5 * (at(lag / 2) + at(lag.div_ceil(2)));
            if multiples >= 2 {
                s += 0.5 * at(lag * 2);
            }
            if multiples >= 4 {
                s += 0.25 * at(lag * 4);
            }
            s
        })
        .collect();
    let mut peaks: Vec<Candidate> = Vec::new();
    for lag in lo..=hi {
        let i = lag - (lo - 1);
        if !(raw[i] > raw[i - 1] && raw[i] >= raw[i + 1]) || raw[i] <= 0.0 {
            continue;
        }
        // Parabolic interpolation of the peak position.
        let (a, b, c) = (raw[i - 1], raw[i], raw[i + 1]);
        let denom = a - 2.0 * b + c;
        let shift = if denom.abs() > 1e-9 {
            (0.5 * (a - c) / denom).clamp(-0.5, 0.5)
        } else {
            0.0
        };
        let bpm = 60.0 * fps / (lag as f64 + f64::from(shift));
        peaks.push(Candidate {
            bpm,
            score: (f64::from(raw[i]) * prior(bpm)) as f32,
            periodicity: at(lag).clamp(0.0, 1.0),
        });
    }
    peaks.sort_by(|a, b| b.score.total_cmp(&a.score));
    peaks
}

// ---------------------------------------------------------------------------------------------
// Beat tracking
// ---------------------------------------------------------------------------------------------

/// Beat frames of `o` for a tempo given as a period in frames (Ellis 2007).
fn track_beats(o: &[f32], period: f64, stop: Cancel) -> Result<Vec<usize>, Stopped> {
    let n = o.len();
    if n == 0 || period < 2.0 {
        return Ok(Vec::new());
    }
    let lo = ((period / 2.0).floor() as usize).max(1);
    let hi = (period * 2.0).ceil() as usize;
    let penalty: Vec<f32> = (lo..=hi)
        .map(|tau| -TIGHTNESS * ((tau as f64 / period).ln() as f32).powi(2))
        .collect();
    let mut score = vec![0.0f32; n];
    let mut back = vec![usize::MAX; n];
    for t in 0..n {
        if t % 4096 == 0 {
            check(stop)?;
        }
        let mut best = f32::NEG_INFINITY;
        let mut arg = usize::MAX;
        if t >= lo {
            for tau in lo..=hi.min(t) {
                let v = score[t - tau] + penalty[tau - lo];
                if v > best {
                    best = v;
                    arg = t - tau;
                }
            }
        }
        if best > 0.0 {
            score[t] = o[t] + best;
            back[t] = arg;
        } else {
            score[t] = o[t];
        }
    }
    // The chain may end anywhere in the last two beats.
    let tail_from = n.saturating_sub((period * 2.0) as usize);
    let mut end = tail_from;
    for t in tail_from..n {
        if score[t] > score[end] {
            end = t;
        }
    }
    let mut beats = vec![end];
    while back[*beats.last().unwrap_or(&end)] != usize::MAX {
        let prev = back[*beats.last().unwrap_or(&end)];
        beats.push(prev);
    }
    beats.reverse();
    Ok(beats)
}

fn median(values: &mut [f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(f64::total_cmp);
    let mid = values.len() / 2;
    if values.len() % 2 == 1 {
        values[mid]
    } else {
        0.5 * (values[mid - 1] + values[mid])
    }
}

/// The period (frames per beat) of the beats: the median over spans of half the beats, which
/// is robust to a few wrong beats and much finer than one frame.
fn fit_period(beats: &[usize]) -> Option<f64> {
    if beats.len() < 4 {
        return None;
    }
    let span = beats.len() / 2;
    let mut slopes: Vec<f64> = (0..beats.len() - span)
        .map(|k| (beats[k + span] as f64 - beats[k] as f64) / span as f64)
        .collect();
    Some(median(&mut slopes))
}

/// Where the grid with `period` sits: the median offset of the first beats, in frames, folded
/// into `[0, period)`.
fn grid_phase(beats: &[usize], period: f64) -> f64 {
    let mut offsets: Vec<f64> = beats
        .iter()
        .take(16)
        .enumerate()
        .map(|(k, &b)| b as f64 - k as f64 * period)
        .collect();
    median(&mut offsets).rem_euclid(period)
}

/// What one stretch of onset strength says about its tempo.
#[derive(Debug, Clone)]
struct Estimate {
    bpm: f64,
    period: f64,
    beats: Vec<usize>,
    /// Autocorrelation at the final period (0 to 1).
    periodicity: f32,
    candidates: Vec<Candidate>,
}

impl Estimate {
    /// 0 to 1. Mostly the periodicity (white noise gives about 0.01, real songs 0.2 to 0.6, a
    /// click track nearly 1), lowered when another pulse that is not an octave of this one
    /// scores almost as high (the song could be felt at either).
    fn confidence(&self) -> f64 {
        let clear = 1.0 - (-f64::from(self.periodicity) / 0.15).exp();
        let best = self.candidates.first().map_or(0.0, |c| f64::from(c.score));
        let rival = self
            .candidates
            .iter()
            .skip(1)
            .filter(|c| !is_octave(c.bpm, self.bpm) && (c.bpm / self.bpm - 1.0).abs() > 0.04)
            .map(|c| f64::from(c.score))
            .fold(0.0, f64::max);
        let ambiguity = if best > 0.0 {
            (rival / best).min(1.0)
        } else {
            0.0
        };
        (clear * (1.0 - 0.4 * ambiguity)).clamp(0.0, 1.0)
    }
}

/// Whether `a` is `b` times 1/2, 1 or 2 (within 4 %).
fn is_octave(a: f64, b: f64) -> bool {
    [0.5, 1.0, 2.0]
        .iter()
        .any(|k| (a / (b * k) - 1.0).abs() < 0.04)
}

/// Tempo, beats and confidence of `o`. `None` when there is no pulse to find.
fn estimate(
    o: &[f32],
    fps: f64,
    multiples: usize,
    stop: Cancel,
) -> Result<Option<Estimate>, Stopped> {
    let found = candidates(o, fps, multiples);
    let Some(best) = found.first().copied() else {
        return Ok(None);
    };
    // Two passes: the second follows the tempo the first measured.
    let mut period = 60.0 * fps / best.bpm;
    let mut beats = track_beats(o, period, stop)?;
    if let Some(p) = fit_period(&beats).filter(|p| (p / period - 1.0).abs() < 0.06) {
        period = p;
        beats = track_beats(o, period, stop)?;
        if let Some(p) = fit_period(&beats).filter(|p| (p / period - 1.0).abs() < 0.03) {
            period = p;
        }
    }
    if beats.len() < 4 {
        return Ok(None);
    }
    let bpm = 60.0 * fps / period;
    let acf = autocorrelation(o, (period * 1.1).ceil() as usize + 1);
    let slack = (period * 0.03).ceil() as usize;
    let centre = period.round() as usize;
    let periodicity = (centre.saturating_sub(slack)..=(centre + slack).min(acf.len() - 1))
        .map(|l| acf[l])
        .fold(0.0f32, f32::max)
        .clamp(0.0, 1.0);
    Ok(Some(Estimate {
        bpm,
        period,
        beats,
        periodicity,
        candidates: found,
    }))
}

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------

/// A window's tempo, after folding octave errors toward the global tempo.
#[derive(Debug, Clone, Copy)]
struct WindowTempo {
    /// First and last frame of the window's own span (the part it decides when windows are
    /// attributed to a section: one hop in its middle).
    vote_from: usize,
    vote_to: usize,
    bpm: Option<f64>,
}

/// `bpm` or its half or double, whichever lies within [`RUN_TOLERANCE`] of `reference`; `bpm`
/// itself when none does.
fn fold_octave(bpm: f64, reference: f64) -> f64 {
    for candidate in [bpm, bpm * 2.0, bpm / 2.0] {
        if (candidate / reference - 1.0).abs() <= RUN_TOLERANCE {
            return candidate;
        }
    }
    bpm
}

/// The tempo of a window: among its strong peaks the one that agrees with the global tempo (a
/// window that merely feels another pulse of the same song is not a new tempo), else its best.
fn window_choice(found: &[Candidate], global: f64) -> Option<f64> {
    let best = found.first()?;
    if best.periodicity < WINDOW_MIN_PERIODICITY {
        return None;
    }
    let strong = found
        .iter()
        .filter(|c| c.score >= 0.6 * best.score && c.periodicity >= WINDOW_MIN_PERIODICITY);
    let folded = strong.map(|c| fold_octave(c.bpm, global));
    let nearest = folded
        .clone()
        .min_by(|a, b| (a / global).ln().abs().total_cmp(&(b / global).ln().abs()))?;
    if (nearest / global - 1.0).abs() <= RUN_TOLERANCE {
        Some(nearest)
    } else {
        Some(fold_octave(best.bpm, global))
    }
}

fn window_tempos(
    o: &[f32],
    fps: f64,
    global: f64,
    stop: Cancel,
) -> Result<Vec<WindowTempo>, Stopped> {
    let (window, hop) = (
        (WINDOW_SEC * fps) as usize,
        ((HOP_SEC * fps) as usize).max(1),
    );
    let mut out = Vec::new();
    let mut start = 0;
    while start + window <= o.len() {
        check(stop)?;
        let slice = &o[start..start + window];
        let bpm = window_choice(&candidates(slice, fps, 2), global);
        let centre = start + window / 2;
        out.push(WindowTempo {
            vote_from: centre.saturating_sub(hop / 2),
            vote_to: centre + hop - hop / 2,
            bpm,
        });
        start += hop;
    }
    // The first window decides the beginning and the last one the end.
    if let Some(first) = out.first_mut() {
        first.vote_from = 0;
    }
    if let Some(last) = out.last_mut() {
        last.vote_to = o.len();
    }
    Ok(out)
}

/// A stretch of consecutive windows with one tempo.
#[derive(Debug, Clone)]
struct Run {
    /// Window indices.
    windows: Vec<usize>,
    bpm: f64,
}

fn run_median(bpms: impl Iterator<Item = f64>) -> f64 {
    let mut v: Vec<f64> = bpms.collect();
    median(&mut v)
}

/// Groups the windows into runs of one tempo, drops runs shorter than [`MIN_RUN_WINDOWS`]
/// (the mixed windows around a change) and merges neighbours closer than [`SECTION_CHANGE`].
fn build_runs(windows: &[WindowTempo]) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();
    for (i, w) in windows.iter().enumerate() {
        let Some(bpm) = w.bpm else { continue };
        match runs.last_mut() {
            Some(run)
                if (bpm / run.bpm - 1.0).abs() <= RUN_TOLERANCE
                    && run.windows.last().is_some_and(|&l| i - l <= 2) =>
            {
                run.windows.push(i);
                run.bpm = run_median(run.windows.iter().filter_map(|&k| windows[k].bpm));
            }
            _ => runs.push(Run {
                windows: vec![i],
                bpm,
            }),
        }
    }
    runs.retain(|r| r.windows.len() >= MIN_RUN_WINDOWS);
    // Merge runs that are not really different (also across a dropped short run).
    let mut merged: Vec<Run> = Vec::new();
    for run in runs {
        match merged.last_mut() {
            Some(last) if (run.bpm / last.bpm - 1.0).abs() < SECTION_CHANGE => {
                last.windows.extend(run.windows);
                last.bpm = run_median(last.windows.iter().filter_map(|&k| windows[k].bpm));
            }
            _ => merged.push(run),
        }
    }
    merged
}

/// Periodicity of `o` at `period` per frame: how much each frame agrees with the one a period
/// later (the neighbours of that frame count too, since the tempo is only approximate).
fn periodicity_track(o: &[f32], period: f64) -> Vec<f32> {
    let p = period.round() as usize;
    (0..o.len())
        .map(|t| {
            let a = (t + p).saturating_sub(1);
            let b = (t + p + 2).min(o.len());
            if a >= b {
                return 0.0;
            }
            o[t] * o[a..b].iter().fold(0.0f32, |m, &v| m.max(v))
        })
        .collect()
}

/// Moves a boundary guessed from the windows to where the tempo really changes: the change
/// point (CUSUM) of "fits the tempo before" against "fits the tempo after", searched within
/// `reach` frames, then snapped to the strongest onset within half a beat.
fn refine_boundary(
    o: &[f32],
    fps: f64,
    guess: usize,
    before: f64,
    after: f64,
    limits: (usize, usize),
) -> usize {
    let reach = (HOP_SEC * fps) as usize;
    let span = (WINDOW_SEC * 0.75 * fps) as usize;
    let from = limits.0.max(guess.saturating_sub(span));
    let to = limits.1.min(guess + span).min(o.len());
    if to <= from + 4 {
        return guess;
    }
    let (pa, pb) = (
        periodicity_track(&o[from..to], 60.0 * fps / before),
        periodicity_track(&o[from..to], 60.0 * fps / after),
    );
    let mean = |v: &[f32]| (v.iter().sum::<f32>() / v.len() as f32).max(1e-9);
    let (ma, mb) = (mean(&pa), mean(&pb));
    let d: Vec<f32> = pa.iter().zip(&pb).map(|(a, b)| a / ma - b / mb).collect();
    let total: f32 = d.iter().sum();
    let (lo, hi) = (
        guess.saturating_sub(reach).max(from) - from,
        (guess + reach).min(to) - from,
    );
    // score(c) = sum(d[..c]) - sum(d[c..]) = 2 * prefix(c) - total.
    let mut prefix: f32 = d[..lo].iter().sum();
    let mut best = (f32::NEG_INFINITY, lo);
    for c in lo..=hi.min(d.len()) {
        let score = 2.0 * prefix - total;
        if score > best.0 {
            best = (score, c);
        }
        if c < d.len() {
            prefix += d[c];
        }
    }
    let boundary = from + best.1;
    // A section starts on an onset: take the strongest one within half a beat.
    let half = (0.5 * fps * 60.0 / after) as usize;
    let (a, b) = (
        boundary.saturating_sub(half),
        (boundary + half).min(o.len()),
    );
    (a..b)
        .max_by(|&x, &y| o[x].total_cmp(&o[y]))
        .filter(|&i| o[i] > 0.0)
        .unwrap_or(boundary)
}

/// Joins neighbouring spans whose tempos differ by less than [`SECTION_CHANGE`]; the tempo of
/// the joined one is the mean of both weighted by their lengths.
fn merge_similar(spans: &mut Vec<(usize, usize, f64)>) {
    let mut i = 1;
    while i < spans.len() {
        let (prev, next) = (spans[i - 1], spans[i]);
        if (next.2 / prev.2 - 1.0).abs() < SECTION_CHANGE {
            let (wa, wb) = ((prev.1 - prev.0) as f64, (next.1 - next.0) as f64);
            let bpm = (prev.2 * wa + next.2 * wb) / (wa + wb).max(1.0);
            spans[i - 1] = (prev.0, next.1, bpm);
            spans.remove(i);
        } else {
            i += 1;
        }
    }
}

/// The sections of the song, or empty when the tempo does not change for good.
fn sections(o: &[f32], fps: f64, global: f64, stop: Cancel) -> Result<Vec<Section>, Stopped> {
    if (o.len() as f64) < MIN_SECTION_SECONDS * fps {
        return Ok(Vec::new());
    }
    let windows = window_tempos(o, fps, global, stop)?;
    let runs = build_runs(&windows);
    if runs.len() < 2 {
        return Ok(Vec::new());
    }
    // Where each run begins: halfway between the last vote of the run before and its first.
    let mut bounds: Vec<usize> = vec![0];
    for pair in runs.windows(2) {
        let end = windows[*pair[0].windows.last().unwrap_or(&0)].vote_to;
        let start = windows[*pair[1].windows.first().unwrap_or(&0)].vote_from;
        let guess = (end + start) / 2;
        let limits = (*bounds.last().unwrap_or(&0), o.len());
        bounds.push(refine_boundary(
            o,
            fps,
            guess,
            pair[0].bpm,
            pair[1].bpm,
            limits,
        ));
    }
    bounds.push(o.len());
    // Stretches shorter than MIN_SECTION_SEC after the boundaries moved do not count: the
    // neighbour takes them over, and neighbours that now agree become one again.
    let mut spans: Vec<(usize, usize, f64)> = runs
        .iter()
        .enumerate()
        .map(|(i, run)| (bounds[i], bounds[i + 1].max(bounds[i]), run.bpm))
        .collect();
    let min_frames = (MIN_SECTION_SEC * fps) as usize;
    while spans.len() > 1 {
        let Some(short) = spans.iter().position(|&(a, b, _)| b - a < min_frames) else {
            break;
        };
        let (a, b, _) = spans.remove(short);
        if short > 0 {
            spans[short - 1].1 = b;
        } else {
            spans[0].0 = a;
        }
        merge_similar(&mut spans);
    }
    merge_similar(&mut spans);
    if spans.len() < 2 {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for &(a, b, run_bpm) in &spans {
        let mut bpm = run_bpm;
        // A finer tempo from the beats of the section itself, when it agrees with the windows.
        if b - a >= (8.0 * fps) as usize
            && let Some(e) = estimate(&o[a..b], fps, 2, stop)?
            && (e.bpm / run_bpm - 1.0).abs() < 0.04
        {
            bpm = e.bpm;
        }
        out.push(Section {
            start_sec: a as f64 / fps,
            end_sec: b as f64 / fps,
            bpm,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// The whole analysis
// ---------------------------------------------------------------------------------------------

fn round(x: f64, decimals: i32) -> f64 {
    let f = 10f64.powi(decimals);
    (x * f).round() / f
}

/// Half and double time first, then the next autocorrelation peaks, without anything within
/// 4 % of the tempo or of an earlier entry.
fn alternatives(bpm: f64, found: &[Candidate], extra: &[f64]) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::new();
    let mut offer = |x: f64| {
        if (MIN_BPM..=MAX_BPM).contains(&x)
            && (x / bpm - 1.0).abs() > 0.04
            && out.iter().all(|&y| (x / y - 1.0).abs() > 0.04)
        {
            out.push(x);
        }
    };
    // The octave the prior likes less comes second.
    let (half, double) = (bpm / 2.0, bpm * 2.0);
    if prior(half) >= prior(double) {
        offer(half);
        offer(double);
    } else {
        offer(double);
        offer(half);
    }
    extra.iter().for_each(|&x| offer(x));
    for c in found.iter().take(8) {
        offer(c.bpm);
    }
    out.truncate(4);
    out.iter().map(|&x| round(x, 1)).collect()
}

/// Detects the tempo of a song. `mix` is the whole song as mono; `drums` the drums stem as
/// mono, when there is one (it makes the onsets cleaner and is ignored when it is nearly empty).
/// Both at `rate` Hz and equally long. `stop` is polled during the work.
pub fn analyse(
    mix: &[f32],
    drums: Option<&[f32]>,
    rate: u32,
    stop: Cancel,
) -> Result<Analysis, Stopped> {
    let none = Analysis {
        tempo: Tempo::none(),
        beats: Vec::new(),
    };
    if rate < 8_000 || (mix.len() as f64) < MIN_SECONDS * f64::from(rate) {
        return Ok(none);
    }
    let mix_rms = rms(mix);
    if mix_rms < 1e-4 {
        return Ok(none);
    }
    let envelope = onset_envelope(mix, rate, stop)?;
    let fps = envelope.fps;
    let mut o = condition(&envelope);
    // The drums stem counts when it is not almost silent next to the mix (-34 dB).
    if let Some(d) = drums.filter(|d| d.len() == mix.len() && rms(d) > 0.02 * mix_rms) {
        let drums_env = condition(&onset_envelope(d, rate, stop)?);
        for (a, b) in o.iter_mut().zip(&drums_env) {
            *a += *b;
        }
    }
    check(stop)?;

    let Some(global) = estimate(&o, fps, 4, stop)? else {
        return Ok(none);
    };
    let found = sections(&o, fps, global.bpm, stop)?;
    let steady = found.len() < 2;

    // The tempo is the one of the longest section; the grid starts where the first beats are.
    let (bpm, period, beats, confidence, extra) = if steady {
        (
            global.bpm,
            global.period,
            global.beats.clone(),
            global.confidence(),
            Vec::new(),
        )
    } else {
        let longest = found
            .iter()
            .max_by(|a, b| (a.end_sec - a.start_sec).total_cmp(&(b.end_sec - b.start_sec)))
            .map_or(global.bpm, |s| s.bpm);
        let first = &found[0];
        let (a, b) = (
            (first.start_sec * fps) as usize,
            ((first.end_sec * fps) as usize).min(o.len()),
        );
        let period = 60.0 * fps / first.bpm;
        let beats: Vec<usize> = track_beats(&o[a..b], period, stop)?
            .into_iter()
            .map(|x| x + a)
            .collect();
        let others: Vec<f64> = found.iter().map(|s| s.bpm).collect();
        (longest, period, beats, global.confidence(), others)
    };
    let first_beat = grid_phase(&beats, period) / fps;
    let alternatives = alternatives(bpm, &global.candidates, &extra);
    let tempo = Tempo {
        bpm: round(bpm, 2),
        confidence: round(confidence, 3),
        first_beat_sec: round(first_beat, 3),
        alternatives,
        steady,
        sections: if steady {
            Vec::new()
        } else {
            found
                .iter()
                .map(|s| Section {
                    start_sec: round(s.start_sec, 2),
                    end_sec: round(s.end_sec, 2),
                    bpm: round(s.bpm, 2),
                })
                .collect()
        },
    };
    Ok(Analysis {
        tempo,
        beats: global.beats.iter().map(|&b| b as f64 / fps).collect(),
    })
}

/// Average of the two channels.
pub fn to_mono(left: &[f32], right: &[f32]) -> Vec<f32> {
    left.iter().zip(right).map(|(l, r)| 0.5 * (l + r)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::separation::synth::Noise;
    use std::f32::consts::TAU;

    const RATE: u32 = 44_100;

    #[derive(Clone, Copy)]
    enum Hit {
        Click,
        Kick,
        Snare,
        Hat,
    }

    /// Renders hits at the given times (seconds) into a mono signal.
    fn render(hits: &[(f64, Hit)], seconds: f64, rate: u32) -> Vec<f32> {
        let mut out = vec![0.0f32; (seconds * f64::from(rate)) as usize];
        let mut noise = Noise::new(7);
        for &(time, hit) in hits {
            let start = (time * f64::from(rate)) as usize;
            let len = match hit {
                Hit::Click => 0.02,
                Hit::Kick => 0.15,
                Hit::Snare => 0.12,
                Hit::Hat => 0.04,
            };
            let len = (len * f64::from(rate)) as usize;
            let mut phase = 0.0f32;
            let mut prev_noise = 0.0f32;
            for i in 0..len {
                let Some(slot) = out.get_mut(start + i) else {
                    break;
                };
                let t = i as f32 / rate as f32;
                let n = noise.sample();
                let v = match hit {
                    Hit::Click => (TAU * 1500.0 * t).sin() * (-t * 250.0).exp() * 0.8,
                    Hit::Kick => {
                        phase += TAU * (50.0 + 90.0 * (-t * 40.0).exp()) / rate as f32;
                        phase.sin() * (-t * 22.0).exp() * 0.9
                    }
                    Hit::Snare => {
                        ((TAU * 190.0 * t).sin() * 0.4 + n * 0.6) * (-t * 30.0).exp() * 0.7
                    }
                    Hit::Hat => {
                        // High-passed noise.
                        let hp = n - prev_noise;
                        prev_noise = n;
                        hp * (-t * 120.0).exp() * 0.3
                    }
                };
                *slot += v;
            }
        }
        out
    }

    fn never() -> bool {
        false
    }

    fn click_track(bpm: f64, first: f64, seconds: f64) -> Vec<f32> {
        let period = 60.0 / bpm;
        let hits: Vec<(f64, Hit)> = (0..)
            .map(|k| (first + k as f64 * period, Hit::Click))
            .take_while(|(t, _)| *t < seconds - 0.1)
            .collect();
        render(&hits, seconds, RATE)
    }

    fn detect(mix: &[f32]) -> Tempo {
        analyse(mix, None, RATE, &never).unwrap().tempo
    }

    fn near(a: f64, b: f64, tolerance: f64) -> bool {
        (a - b).abs() <= tolerance
    }

    #[test]
    fn click_tracks_are_measured_to_a_fraction_of_a_bpm_with_the_first_beat() {
        for (bpm, first) in [(90.0, 0.3), (120.0, 0.5), (140.0, 0.12)] {
            let t = detect(&click_track(bpm, first, 40.0));
            assert!(near(t.bpm, bpm, 0.3), "{bpm}: got {}", t.bpm);
            assert!(
                near(t.first_beat_sec, first, 0.03),
                "{bpm}: first beat {} not {first}",
                t.first_beat_sec
            );
            assert!(t.confidence > 0.8, "{bpm}: confidence {}", t.confidence);
            assert!(t.steady && t.sections.is_empty());
        }
    }

    #[test]
    fn the_answer_does_not_depend_on_the_sample_rate() {
        let hits: Vec<(f64, Hit)> = (0..60)
            .map(|k| (0.4 + k as f64 * 0.5, Hit::Click))
            .collect();
        for rate in [22_050, 48_000] {
            let x = render(&hits, 30.0, rate);
            let t = analyse(&x, None, rate, &never).unwrap().tempo;
            assert!(near(t.bpm, 120.0, 0.4), "{rate}: got {}", t.bpm);
        }
    }

    #[test]
    fn a_swung_noisy_groove_is_still_found() {
        // Kick on the beat, hats on the off-beat eighths pushed late (swing), jittered by up to
        // 10 ms, over broadband noise.
        let bpm = 100.0;
        let beat = 60.0 / bpm;
        let mut noise = Noise::new(99);
        let mut hits = Vec::new();
        for k in 0..60 {
            let t = 0.2 + k as f64 * beat;
            let jitter = |n: &mut Noise| f64::from(n.sample()) * 0.010;
            hits.push((t + jitter(&mut noise), Hit::Kick));
            hits.push((t + beat * 0.62 + jitter(&mut noise), Hit::Hat));
            if k % 2 == 1 {
                hits.push((t + jitter(&mut noise), Hit::Snare));
            }
        }
        let mut x = render(&hits, 40.0, RATE);
        let mut n = Noise::new(5);
        for v in &mut x {
            *v += n.sample() * 0.03;
        }
        let t = detect(&x);
        assert!(near(t.bpm, bpm, 1.0), "got {}", t.bpm);
        assert!(t.steady);
        assert!(t.confidence > 0.5, "confidence {}", t.confidence);
    }

    #[test]
    fn a_step_from_100_to_140_gives_two_sections() {
        // 100 BPM for 30 s, then 140 BPM for 40 s.
        let mut hits = Vec::new();
        let mut t = 0.4;
        while t < 30.0 {
            hits.push((t, Hit::Click));
            t += 0.6;
        }
        let mut t = 30.0;
        while t < 70.0 {
            hits.push((t, Hit::Click));
            t += 60.0 / 140.0;
        }
        let a = analyse(&render(&hits, 70.0, RATE), None, RATE, &never).unwrap();
        let tempo = a.tempo;
        assert!(!tempo.steady);
        assert_eq!(tempo.sections.len(), 2, "{:?}", tempo.sections);
        let (s1, s2) = (&tempo.sections[0], &tempo.sections[1]);
        assert!(
            near(s1.bpm, 100.0, 1.0) && near(s2.bpm, 140.0, 1.0),
            "{s1:?} {s2:?}"
        );
        assert!(near(s1.start_sec, 0.0, 0.01));
        assert!(near(s1.end_sec, 30.0, 1.0), "boundary {}", s1.end_sec);
        assert!(near(s2.start_sec, s1.end_sec, 0.01));
        assert!(near(s2.end_sec, 70.0, 0.1));
        // The headline tempo is the longer section's.
        assert!(near(tempo.bpm, 140.0, 1.0));
    }

    #[test]
    fn a_drummer_drifting_from_100_to_104_is_steady_with_no_sections() {
        // The tempo rises linearly: 100 BPM at the start, 104 BPM after 90 s.
        let mut hits = Vec::new();
        let mut t = 0.3;
        while t < 90.0 {
            hits.push((t, Hit::Click));
            let bpm = 100.0 + 4.0 * t / 90.0;
            t += 60.0 / bpm;
        }
        let x = render(&hits, 90.0, RATE);
        let tempo = detect(&x);
        assert!(tempo.steady, "{:?}", tempo.sections);
        assert!(tempo.sections.is_empty());
        assert!(tempo.bpm > 100.0 && tempo.bpm < 104.0, "got {}", tempo.bpm);
    }

    #[test]
    fn silence_and_noise_have_no_confidence_and_do_not_panic() {
        let silence = vec![0.0f32; RATE as usize * 20];
        let t = detect(&silence);
        assert_eq!((t.bpm, t.confidence), (0.0, 0.0));
        assert!(t.steady && t.sections.is_empty() && t.alternatives.is_empty());

        let mut n = Noise::new(3);
        let noise: Vec<f32> = (0..RATE as usize * 30).map(|_| n.sample() * 0.3).collect();
        let t = detect(&noise);
        assert!(t.confidence < 0.3, "noise confidence {}", t.confidence);
        assert!(t.bpm == 0.0 || (MIN_BPM..=MAX_BPM).contains(&t.bpm));

        // Too short, empty, and a constant tone.
        assert_eq!(detect(&noise[..1000]).bpm, 0.0);
        assert_eq!(detect(&[]).bpm, 0.0);
        let tone: Vec<f32> = (0..RATE as usize * 20)
            .map(|i| (TAU * 440.0 * i as f32 / RATE as f32).sin() * 0.5)
            .collect();
        assert!(detect(&tone).confidence < 0.3);
    }

    #[test]
    fn half_time_snare_over_four_on_the_floor_is_not_halved() {
        // Kick on every beat at 120 BPM, snare only on beat 3 of each bar (half-time feel,
        // a snare every 2 s), eighth hats.
        let beat = 0.5;
        let mut hits = Vec::new();
        for k in 0..80 {
            let t = 0.25 + k as f64 * beat;
            hits.push((t, Hit::Kick));
            hits.push((t, Hit::Hat));
            hits.push((t + beat / 2.0, Hit::Hat));
            if k % 4 == 2 {
                hits.push((t, Hit::Snare));
            }
        }
        let t = detect(&render(&hits, 40.0, RATE));
        assert!(near(t.bpm, 120.0, 0.5), "got {}", t.bpm);
        assert!(
            t.alternatives.iter().any(|&a| near(a, 60.0, 1.0)),
            "{:?}",
            t.alternatives
        );
    }

    #[test]
    fn the_drums_stem_helps_when_the_mix_is_dominated_by_a_sustained_part() {
        let drums = click_track(128.0, 0.2, 30.0);
        let mix: Vec<f32> = drums
            .iter()
            .enumerate()
            .map(|(i, d)| d * 0.3 + 0.5 * (TAU * 220.0 * i as f32 / RATE as f32).sin() * 0.5)
            .collect();
        let t = analyse(&mix, Some(&drums), RATE, &never).unwrap().tempo;
        assert!(near(t.bpm, 128.0, 0.5), "got {}", t.bpm);
        // A silent drums stem is ignored, not divided by.
        let silent = vec![0.0f32; mix.len()];
        let t = analyse(&mix, Some(&silent), RATE, &never).unwrap().tempo;
        assert!(t.bpm.is_finite());
    }

    #[test]
    fn the_beat_grid_follows_the_clicks() {
        let a = analyse(&click_track(120.0, 0.5, 30.0), None, RATE, &never).unwrap();
        assert!(a.beats.len() > 50);
        for pair in a.beats.windows(2) {
            assert!(near(pair[1] - pair[0], 0.5, 0.03), "{pair:?}");
        }
        assert!(near(a.beats[0], 0.5, 0.03));
    }

    #[test]
    fn alternatives_hold_the_octaves_and_stay_in_range() {
        let t = detect(&click_track(120.0, 0.5, 30.0));
        assert!(t.alternatives.contains(&60.0), "{:?}", t.alternatives);
        assert!(t.alternatives.contains(&240.0), "{:?}", t.alternatives);
        assert!(t.alternatives.len() <= 4);
        assert!(
            t.alternatives
                .iter()
                .all(|a| (MIN_BPM..=MAX_BPM).contains(a))
        );
    }

    #[test]
    fn a_stop_request_cancels() {
        let x = click_track(120.0, 0.5, 20.0);
        assert_eq!(analyse(&x, None, RATE, &|| true).unwrap_err(), Stopped);
    }

    #[test]
    fn the_result_serialises_with_the_names_the_page_expects() {
        let t = Tempo {
            bpm: 120.0,
            confidence: 0.9,
            first_beat_sec: 0.5,
            alternatives: vec![60.0],
            steady: false,
            sections: vec![Section {
                start_sec: 0.0,
                end_sec: 10.0,
                bpm: 120.0,
            }],
        };
        let json = serde_json::to_value(&t).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "bpm": 120.0, "confidence": 0.9, "firstBeatSec": 0.5,
                "alternatives": [60.0], "steady": false,
                "sections": [{ "startSec": 0.0, "endSec": 10.0, "bpm": 120.0 }],
            })
        );
        let back: Tempo = serde_json::from_value(json).unwrap();
        assert_eq!(back, t);
    }
}
