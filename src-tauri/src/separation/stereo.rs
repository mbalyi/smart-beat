//! Stereo cues: which time-frequency cells sit in the centre of the mix (a lead vocal, most
//! snares) and which are panned hard to one side (double-tracked guitars, wide keys).
//!
//! Both masks are soft: a cell is shared between the part and the rest by how centred or how
//! panned it is. Neither is a frequency cut; the low-frequency guard below only keeps kick and
//! bass remains out of the vocal estimate.

use super::stft::{BINS, FRAME, Spec};

/// Below this the centre mask is off, above [`CENTRE_FULL_HZ`] fully on, linear in between.
pub const CENTRE_START_HZ: f32 = 120.0;
pub const CENTRE_FULL_HZ: f32 = 240.0;

fn guard(f: usize, rate: f32) -> f32 {
    let hz = f as f32 * rate / FRAME as f32;
    ((hz - CENTRE_START_HZ) / (CENTRE_FULL_HZ - CENTRE_START_HZ)).clamp(0.0, 1.0)
}

/// How centred each cell is, 0 to 1: the in-phase, equal-level share of left and right.
///
/// `sharpness` raises it to a power (2 is a good start; higher keeps only the very centred).
/// A mono file is centred everywhere.
pub fn coherence_mask(l: &Spec, r: &Spec, sharpness: f32) -> Vec<f32> {
    l.data
        .iter()
        .zip(&r.data)
        .map(|(a, b)| {
            let power = a.norm_sqr() + b.norm_sqr();
            if power <= 1e-20 {
                return 0.0;
            }
            // Real part of L · conj(R): positive when in phase.
            let cross = a.re * b.re + a.im * b.im;
            (2.0 * cross / power).clamp(0.0, 1.0).powf(sharpness)
        })
        .collect()
}

/// [`coherence_mask`] with the low-frequency guard that keeps kick and bass remains out of the
/// vocal estimate.
pub fn centre_mask(l: &Spec, r: &Spec, rate: f32, sharpness: f32) -> Vec<f32> {
    let mut out = coherence_mask(l, r, sharpness);
    for (i, v) in out.iter_mut().enumerate() {
        *v *= guard(i % BINS, rate);
    }
    out
}

/// Pan position of a cell, -1 (left) to 1 (right).
fn pan(a: f32, b: f32) -> f32 {
    let sum = a + b;
    if sum <= 1e-10 { 0.0 } else { (b - a) / sum }
}

/// How hard each cell is panned, 0 (centre) to 1 (one side only). Cells below `from` count as
/// centred, above `to` as fully panned, linear in between.
pub fn panned_mask(l: &Spec, r: &Spec, from: f32, to: f32) -> Vec<f32> {
    let span = (to - from).max(1e-3);
    l.data
        .iter()
        .zip(&r.data)
        .map(|(a, b)| ((pan(a.norm(), b.norm()).abs() - from) / span).clamp(0.0, 1.0))
        .collect()
}

/// Share of the energy above 150 Hz that sits in hard-panned cells (pan beyond 0.6 either way).
/// A mono file gives 0; a mix with double-tracked guitars gives a clear value.
pub fn panned_share(l: &Spec, r: &Spec, rate: f32) -> f32 {
    let (mut panned, mut total) = (0.0f64, 0.0f64);
    for (i, (a, b)) in l.data.iter().zip(&r.data).enumerate() {
        let hz = (i % BINS) as f32 * rate / FRAME as f32;
        if hz < 150.0 {
            continue;
        }
        let e = (a.norm_sqr() + b.norm_sqr()) as f64;
        total += e;
        if pan(a.norm(), b.norm()).abs() > 0.6 {
            panned += e;
        }
    }
    if total <= 0.0 {
        0.0
    } else {
        (panned / total) as f32
    }
}

/// Whether left and right are (nearly) the same signal.
pub fn is_mono(left: &[f32], right: &[f32]) -> bool {
    let (mut diff, mut sum) = (0.0f64, 0.0f64);
    for (a, b) in left.iter().zip(right) {
        diff += ((a - b) as f64).powi(2);
        sum += ((a + b) as f64).powi(2);
    }
    sum <= 0.0 || diff / sum < 1e-6
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::separation::stft::Stft;

    fn tone(hz: f32, len: usize, rate: f32) -> Vec<f32> {
        (0..len)
            .map(|i| (std::f32::consts::TAU * hz * i as f32 / rate).sin())
            .collect()
    }

    #[test]
    fn a_centred_tone_is_centred_and_a_hard_left_tone_is_not() {
        let rate = 44_100.0;
        let stft = Stft::new();
        let t = tone(1_000.0, 8192, rate);
        let silent = vec![0.0f32; t.len()];
        let bin = (1_000.0 / rate * FRAME as f32).round() as usize;
        let cell = |l: &[f32], r: &[f32]| {
            let (ls, rs) = (stft.analyse(l), stft.analyse(r));
            (
                centre_mask(&ls, &rs, rate, 2.0)[5 * BINS + bin],
                panned_mask(&ls, &rs, 0.3, 0.8)[5 * BINS + bin],
            )
        };
        let (centre, panned) = cell(&t, &t);
        assert!(centre > 0.95 && panned < 0.05, "{centre} {panned}");
        let (centre, panned) = cell(&t, &silent);
        assert!(centre < 0.05 && panned > 0.95, "{centre} {panned}");
    }

    #[test]
    fn a_mono_file_is_flagged_and_has_no_panned_share() {
        let rate = 44_100.0;
        let t = tone(800.0, 8192, rate);
        assert!(is_mono(&t, &t));
        let s = Stft::new().analyse(&t);
        assert_eq!(panned_share(&s, &s, rate), 0.0);
        assert!(!is_mono(&t, &vec![0.0; t.len()]));
    }
}
