//! Bass by pitch: YIN (de Cheveigné and Kawahara, 2002) finds the bass note of every frame in
//! 30 to 250 Hz, and a soft comb mask keeps that note's harmonics. Run on the signal with the
//! drums already taken out, so a kick does not read as a bass note.
//!
//! The pitch analysis works on a decimated copy; the mask is applied to the full-rate
//! spectrogram, so nothing is low-passed: the bass keeps its upper harmonics (the part that
//! makes a bass audible on small speakers), and nothing but the bass's own harmonics leaves the
//! mix.

use super::stft::{BINS, FRAME, HOP};

pub const MIN_HZ: f32 = 30.0;
pub const MAX_HZ: f32 = 250.0;
/// Harmonics above this are left alone (guitars and vocals own that range).
pub const MAX_HARMONIC_HZ: f32 = 1_500.0;
const ANALYSIS_RATE: f32 = 5_512.5;
const WINDOW: usize = 256;
const THRESHOLD: f32 = 0.2;

/// The bass note of one frame. `voiced` is 0 (no note) to 1 (clear note).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pitch {
    pub hz: f32,
    pub voiced: f32,
}

const NONE: Pitch = Pitch {
    hz: 0.0,
    voiced: 0.0,
};

/// A decimated copy of `x` (block averages) and the decimation factor, for the pitch analysis only.
fn decimate(x: &[f32], rate: f32) -> (Vec<f32>, usize) {
    let factor = ((rate / ANALYSIS_RATE).round() as usize).max(1);
    let out = x
        .chunks(factor)
        .map(|c| c.iter().sum::<f32>() / c.len() as f32)
        .collect();
    (out, factor)
}

/// One pitch per spectrogram frame (frame `t` is centred on sample `t * HOP`).
pub fn track(x: &[f32], rate: f32, frames: usize) -> Vec<Pitch> {
    let (y, factor) = decimate(x, rate);
    let eff = rate / factor as f32;
    let tau_min = (eff / MAX_HZ).floor().max(2.0) as usize;
    let tau_max = (eff / MIN_HZ).ceil() as usize;
    let mut diff = vec![0.0f32; tau_max + 2];
    let mut norm = vec![0.0f32; tau_max + 2];
    (0..frames)
        .map(|t| {
            let centre = t * HOP / factor;
            let start = centre.saturating_sub(WINDOW / 2);
            if start + WINDOW + tau_max + 1 >= y.len() {
                return NONE;
            }
            let w = &y[start..start + WINDOW + tau_max + 1];
            let energy = w[..WINDOW].iter().map(|v| v * v).sum::<f32>() / WINDOW as f32;
            if energy < 1e-7 {
                return NONE;
            }
            // Difference function and its cumulative mean normalisation.
            for tau in 1..=tau_max {
                let mut d = 0.0f32;
                for j in 0..WINDOW {
                    let e = w[j] - w[j + tau];
                    d += e * e;
                }
                diff[tau] = d;
            }
            let mut running = 0.0f32;
            norm[0] = 1.0;
            for tau in 1..=tau_max {
                running += diff[tau];
                norm[tau] = if running > 0.0 {
                    diff[tau] * tau as f32 / running
                } else {
                    1.0
                };
            }
            // The first dip below the threshold, followed down to its minimum; else the deepest.
            let mut best = None;
            let mut tau = tau_min;
            while tau < tau_max {
                if norm[tau] < THRESHOLD {
                    while tau + 1 < tau_max && norm[tau + 1] < norm[tau] {
                        tau += 1;
                    }
                    best = Some(tau);
                    break;
                }
                tau += 1;
            }
            let tau = best.unwrap_or_else(|| {
                (tau_min..tau_max)
                    .min_by(|&a, &b| norm[a].total_cmp(&norm[b]))
                    .unwrap_or(tau_min)
            });
            if norm[tau] > 0.5 {
                return NONE;
            }
            let voiced = (1.0 - norm[tau]).clamp(0.0, 1.0);
            // Parabolic refinement of the lag.
            let refined = if tau > 1 && tau < tau_max {
                let (a, b, c) = (norm[tau - 1], norm[tau], norm[tau + 1]);
                let denom = a - 2.0 * b + c;
                if denom.abs() > 1e-9 {
                    tau as f32 + 0.5 * (a - c) / denom
                } else {
                    tau as f32
                }
            } else {
                tau as f32
            };
            let hz = eff / refined;
            if !(MIN_HZ..=MAX_HZ).contains(&hz) {
                return NONE;
            }
            Pitch { hz, voiced }
        })
        .collect()
}

/// Drops notes whose fundamental is missing from the spectrum. A pitch tracker given a vocal at
/// 300 Hz may answer 150 Hz (its sub-octave); a real bass note has energy at its fundamental,
/// the vocal has none there. `mag` is the magnitude spectrogram (frames x [`BINS`]).
pub fn validate(pitches: &mut [Pitch], mag: &[f32], rate: f32) {
    let hz_per_bin = rate / FRAME as f32;
    for (t, p) in pitches.iter_mut().enumerate() {
        if p.voiced <= 0.0 {
            continue;
        }
        let row = &mag[t * BINS..(t + 1) * BINS];
        let around = |hz: f32| {
            let c = (hz / hz_per_bin).round() as usize;
            (c.saturating_sub(1)..=(c + 1).min(BINS - 1))
                .map(|f| row[f])
                .fold(0.0f32, f32::max)
        };
        let fundamental = around(p.hz);
        let upper = around(2.0 * p.hz).max(around(3.0 * p.hz));
        if fundamental < FUNDAMENTAL_RATIO * upper {
            *p = NONE;
        }
    }
}

/// Fills short gaps in the note track (the attack of a note, a pick noise) with the pitch around
/// them, so the comb does not blink off for a few frames at every note change.
pub fn bridge_gaps(pitches: &mut [Pitch], max_gap: usize) {
    let n = pitches.len();
    let mut t = 0;
    while t < n {
        if pitches[t].voiced > 0.0 {
            t += 1;
            continue;
        }
        let start = t;
        while t < n && pitches[t].voiced <= 0.0 {
            t += 1;
        }
        if start == 0 || t >= n || t - start > max_gap {
            continue;
        }
        let (a, b) = (pitches[start - 1], pitches[t]);
        // Same note on both sides (within a semitone): bridge it; a new note starts at its attack.
        let same = (a.hz / b.hz - 1.0).abs() < 0.06;
        for (k, p) in pitches[start..t].iter_mut().enumerate() {
            let src = if same || k < (t - start) / 2 { a } else { b };
            *p = Pitch {
                hz: src.hz,
                voiced: src.voiced * 0.8,
            };
        }
    }
}

/// A fundamental weaker than this share of its 2nd or 3rd harmonic is not a bass note.
const FUNDAMENTAL_RATIO: f32 = 0.2;

/// Soft comb mask: 1 on the harmonics of each frame's bass note, falling off smoothly between
/// them, scaled by how clear the note is. 0 in frames without a note.
pub fn comb_mask(pitches: &[Pitch], rate: f32) -> Vec<f32> {
    let hz_per_bin = rate / FRAME as f32;
    let mut mask = vec![0.0f32; pitches.len() * BINS];
    for (t, p) in pitches.iter().enumerate() {
        if p.voiced <= 0.0 || p.hz <= 0.0 {
            continue;
        }
        let row = &mut mask[t * BINS..(t + 1) * BINS];
        let mut k = 1.0f32;
        while k * p.hz < MAX_HARMONIC_HZ {
            let centre = k * p.hz / hz_per_bin;
            // Wide enough for tuning drift and the smear of a distorted note.
            let sigma = (p.hz * 0.03 / hz_per_bin).max(1.2);
            let lo = ((centre - 3.0 * sigma).floor().max(0.0)) as usize;
            let hi = ((centre + 3.0 * sigma).ceil() as usize).min(BINS - 1);
            // Higher harmonics are shared with other instruments more often.
            let share = (1.0 / (1.0 + (k * p.hz / 800.0).powi(2))).max(0.25);
            for (f, cell) in row.iter_mut().enumerate().take(hi + 1).skip(lo) {
                let d = (f as f32 - centre) / sigma;
                let w = (-0.5 * d * d).exp() * p.voiced * share;
                if w > *cell {
                    *cell = w;
                }
            }
            k += 1.0;
        }
    }
    mask
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::separation::stft::Stft;

    fn bass_note(hz: f32, len: usize, rate: f32) -> Vec<f32> {
        (0..len)
            .map(|i| {
                let ph = std::f32::consts::TAU * hz * i as f32 / rate;
                ph.sin() + 0.5 * (2.0 * ph).sin() + 0.3 * (3.0 * ph).sin()
            })
            .collect()
    }

    #[test]
    fn yin_finds_a_bass_note() {
        let rate = 44_100.0;
        for hz in [41.2f32, 55.0, 82.4, 110.0, 196.0] {
            let x = bass_note(hz, 44_100, rate);
            let frames = Stft::frame_count(x.len());
            let pitches = track(&x, rate, frames);
            let p = pitches[frames / 2];
            assert!(p.voiced > 0.7, "{hz}: {p:?}");
            assert!((p.hz - hz).abs() / hz < 0.03, "{hz}: {p:?}");
        }
    }

    #[test]
    fn silence_has_no_bass_note() {
        let rate = 44_100.0;
        let silent = vec![0.0f32; 44_100];
        let frames = Stft::frame_count(silent.len());
        assert!(track(&silent, rate, frames).iter().all(|p| p.voiced == 0.0));
    }

    #[test]
    fn the_comb_keeps_harmonics_and_not_the_gaps() {
        let rate = 44_100.0;
        let mask = comb_mask(
            &[Pitch {
                hz: 200.0,
                voiced: 1.0,
            }],
            rate,
        );
        let bin = |hz: f32| (hz * FRAME as f32 / rate).round() as usize;
        assert!(mask[bin(200.0)] > 0.9);
        assert!(mask[bin(400.0)] > 0.5);
        assert!(mask[bin(300.0)] < 0.1, "between the harmonics");
        assert!(mask[bin(3_000.0)] == 0.0, "above the harmonic limit");
    }
}
