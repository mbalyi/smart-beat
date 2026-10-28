//! Quality numbers for the tests and the benchmark.

/// Sum of squares.
pub fn energy(x: &[f32]) -> f64 {
    x.iter().map(|&v| (v as f64) * (v as f64)).sum()
}

pub fn rms(x: &[f32]) -> f32 {
    if x.is_empty() {
        0.0
    } else {
        (energy(x) / x.len() as f64).sqrt() as f32
    }
}

/// Signal-to-distortion ratio of `estimate` against `reference`, in dB (higher is better; 0 dB
/// means the error is as loud as the reference).
pub fn sdr_db(reference: &[f32], estimate: &[f32]) -> f32 {
    let signal = energy(reference);
    let error: f64 = reference
        .iter()
        .zip(estimate)
        .map(|(&r, &e)| ((r - e) as f64).powi(2))
        .sum();
    10.0 * ((signal + 1e-12) / (error + 1e-12)).log10() as f32
}

/// Energy of `x` that is in the direction of `target` (its projection).
fn projected_energy(target: &[f32], x: &[f32]) -> f64 {
    let dot: f64 = target
        .iter()
        .zip(x)
        .map(|(&t, &v)| t as f64 * v as f64)
        .sum();
    let tt = energy(target);
    if tt <= 0.0 { 0.0 } else { dot * dot / tt }
}

/// How much of `target` (as an amplitude factor) is found in `x`: 1 when `x` holds all of it,
/// 0 when none. The rows of the benchmark's confusion table; a row adds up to about 1.
pub fn share_of(target: &[f32], x: &[f32]) -> f32 {
    let tt = energy(target);
    if tt <= 0.0 {
        return 0.0;
    }
    let dot: f64 = target
        .iter()
        .zip(x)
        .map(|(&t, &v)| t as f64 * v as f64)
        .sum();
    (dot / tt) as f32
}

/// How much quieter `target` became after the separation, in dB: the part of the original mix
/// that is `target`, against the part of what is left that is `target`. 20 dB means a tenth of
/// the amplitude is left. This is the number the "mute" button is judged by.
pub fn reduction_db(target: &[f32], mix: &[f32], remaining: &[f32]) -> f32 {
    let before = projected_energy(target, mix);
    let after = projected_energy(target, remaining);
    10.0 * ((before + 1e-12) / (after + 1e-12)).log10() as f32
}

/// Fraction of cells whose mask value is far from 0 and 1 and jumps between neighbouring frames:
/// the "musical noise" of a mask (a lower value is a calmer mask).
pub fn mask_flicker(mask: &[f32], bins: usize) -> f32 {
    let frames = mask.len() / bins;
    if frames < 2 {
        return 0.0;
    }
    let mut jumps = 0.0f64;
    for t in 1..frames {
        for f in 0..bins {
            jumps += (mask[t * bins + f] - mask[(t - 1) * bins + f]).abs() as f64;
        }
    }
    (jumps / ((frames - 1) * bins) as f64) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sdr_is_high_for_a_close_estimate_and_zero_for_silence() {
        let r: Vec<f32> = (0..1000).map(|i| (i as f32 * 0.1).sin()).collect();
        assert!(sdr_db(&r, &r) > 100.0);
        assert!(sdr_db(&r, &vec![0.0; r.len()]).abs() < 0.01);
    }

    #[test]
    fn reduction_counts_only_the_target_direction() {
        let t: Vec<f32> = (0..1000).map(|i| (i as f32 * 0.1).sin()).collect();
        let other: Vec<f32> = (0..1000).map(|i| (i as f32 * 0.37).cos()).collect();
        let mix: Vec<f32> = t.iter().zip(&other).map(|(a, b)| a + b).collect();
        let half: Vec<f32> = t.iter().zip(&other).map(|(a, b)| 0.1 * a + b).collect();
        let r = reduction_db(&t, &mix, &half);
        assert!((r - 20.0).abs() < 1.5, "{r}");
    }
}
