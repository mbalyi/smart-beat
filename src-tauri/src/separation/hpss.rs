//! Harmonic/percussive separation by median filtering (FitzGerald, DAFx 2010), with the margin of
//! Driedger, Müller and Disch (ISMIR 2014). A drum hit is a vertical line in the spectrogram
//! (many bins at once), a held note a horizontal one. Median filters along time and along
//! frequency keep one and suppress the other; the result is a *soft* (Wiener-style) mask, so a
//! cell is shared between the two parts instead of switching on and off ("musical noise").

/// Odd median-filter length, in frames (time) and bins (frequency).
pub const KERNEL: usize = 17;

fn median(buf: &mut [f32]) -> f32 {
    let mid = buf.len() / 2;
    buf.select_nth_unstable_by(mid, |a, b| a.total_cmp(b));
    buf[mid]
}

/// Median over time of every bin: the harmonic estimate.
pub fn harmonic_estimate(mag: &[f32], frames: usize, bins: usize) -> Vec<f32> {
    let half = KERNEL / 2;
    let mut out = vec![0.0f32; mag.len()];
    let mut buf = [0.0f32; KERNEL];
    for f in 0..bins {
        for t in 0..frames {
            for (k, b) in buf.iter_mut().enumerate() {
                let tt = (t + k).saturating_sub(half).min(frames - 1);
                *b = mag[tt * bins + f];
            }
            out[t * bins + f] = median(&mut buf);
        }
    }
    out
}

/// Median over frequency of every frame: the percussive estimate.
pub fn percussive_estimate(mag: &[f32], frames: usize, bins: usize) -> Vec<f32> {
    let half = KERNEL / 2;
    let mut out = vec![0.0f32; mag.len()];
    let mut buf = [0.0f32; KERNEL];
    for t in 0..frames {
        let row = &mag[t * bins..(t + 1) * bins];
        for f in 0..bins {
            for (k, b) in buf.iter_mut().enumerate() {
                let ff = (f + k).saturating_sub(half).min(bins - 1);
                *b = row[ff];
            }
            out[t * bins + f] = median(&mut buf);
        }
    }
    out
}

/// Share of every cell that belongs to the percussive part, 0 to 1.
///
/// `margin` of 1 is the plain Wiener mask. A margin above 1 sends ambiguous cells to the drums
/// (a cleaner drum-free rest at the price of taking some harmonic attack with it); below 1 it
/// keeps them in the rest. `power` is the Wiener exponent (2 = power ratio).
pub fn percussive_mask(
    mag: &[f32],
    frames: usize,
    bins: usize,
    margin: f32,
    power: f32,
) -> Vec<f32> {
    let h = harmonic_estimate(mag, frames, bins);
    let p = percussive_estimate(mag, frames, bins);
    let margin = margin.max(0.05);
    h.iter()
        .zip(&p)
        .map(|(&h, &p)| {
            let ph = (p * margin).powf(power);
            let hh = h.powf(power);
            if ph + hh <= 1e-20 {
                0.5
            } else {
                ph / (ph + hh)
            }
        })
        .collect()
}

/// The same mask made binary (cells above 0.5). Kept as the baseline that the soft mask is
/// measured against; the app never uses it.
pub fn binarise(mask: &[f32]) -> Vec<f32> {
    mask.iter()
        .map(|&m| if m > 0.5 { 1.0 } else { 0.0 })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::separation::stft::BINS;

    #[test]
    fn a_vertical_line_is_percussive_and_a_horizontal_line_is_harmonic() {
        let frames = 64;
        let mut mag = vec![0.01f32; frames * BINS];
        // A click at frame 32 across all bins, a held tone in bin 100 over all frames.
        for f in 0..BINS {
            mag[32 * BINS + f] = 1.0;
        }
        for t in 0..frames {
            mag[t * BINS + 100] = 1.0;
        }
        let mask = percussive_mask(&mag, frames, BINS, 1.0, 2.0);
        assert!(mask[32 * BINS + 300] > 0.9, "click bin");
        assert!(mask[10 * BINS + 100] < 0.1, "tone bin");
    }

    #[test]
    fn a_binary_mask_only_has_two_values() {
        let soft = [0.2, 0.5, 0.51, 0.9];
        assert_eq!(binarise(&soft), vec![0.0, 0.0, 1.0, 1.0]);
    }
}
