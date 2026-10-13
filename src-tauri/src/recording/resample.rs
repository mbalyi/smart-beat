//! Sample rate conversion for a recorded take: a windowed-sinc low-pass filter, evaluated at
//! each output sample's position in the input. A kernel table with linear interpolation keeps
//! any pair of rates cheap, so the rates need no common factor.

use std::f64::consts::PI;

/// Zero crossings of the sinc on each side of the centre. More crossings give a sharper
/// transition band and cost more taps.
const ZEROS: f64 = 14.0;
/// Kaiser window shape. About 90 dB of stop band attenuation.
const KAISER_BETA: f64 = 8.6;
/// Kernel table entries per input sample.
const TABLE_RES: usize = 512;
/// Cutoff as a fraction of the lower Nyquist rate, so the transition band stays below it.
const CUTOFF: f64 = 0.96;

/// Zeroth-order modified Bessel function of the first kind.
fn bessel_i0(x: f64) -> f64 {
    let (mut sum, mut term) = (1.0, 1.0);
    let quarter = x * x / 4.0;
    for k in 1..64 {
        term *= quarter / f64::from(k * k);
        sum += term;
        if term < sum * 1e-17 {
            break;
        }
    }
    sum
}

fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-12 {
        1.0
    } else {
        (PI * x).sin() / (PI * x)
    }
}

/// The low-pass kernel sampled finely from the centre outwards.
struct Kernel {
    table: Vec<f32>,
    /// Half width in input samples.
    half: f64,
}
impl Kernel {
    /// `cutoff` is the filter's cutoff in cycles per input sample (at most 0.5).
    fn new(cutoff: f64) -> Self {
        let half = ZEROS / (2.0 * cutoff);
        let size = (half * TABLE_RES as f64).ceil() as usize + 2;
        let norm = bessel_i0(KAISER_BETA);
        let table = (0..size)
            .map(|k| {
                let x = k as f64 / TABLE_RES as f64;
                let u = x / half;
                let window = if u >= 1.0 {
                    0.0
                } else {
                    bessel_i0(KAISER_BETA * (1.0 - u * u).sqrt()) / norm
                };
                (2.0 * cutoff * sinc(2.0 * cutoff * x) * window) as f32
            })
            .collect();
        Self { table, half }
    }
    /// The kernel at distance `x` input samples from the centre.
    fn at(&self, x: f64) -> f32 {
        let position = x.abs() * TABLE_RES as f64;
        let index = position as usize;
        match self.table.get(index + 1) {
            Some(&next) => {
                let fraction = (position - index as f64) as f32;
                self.table[index] * (1.0 - fraction) + next * fraction
            }
            None => 0.0,
        }
    }
}

/// Converts mono audio from `from` Hz to `to` Hz. Samples outside the recording count as
/// silence. The output has `len * to / from` samples, rounded down.
pub fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() || from == 0 || to == 0 {
        return input.to_vec();
    }
    let ratio = f64::from(from) / f64::from(to);
    let out_len = (input.len() as u64 * u64::from(to) / u64::from(from)) as usize;
    // Lower the cutoff when shrinking the rate, so nothing above the new Nyquist aliases.
    let cutoff = 0.5 * CUTOFF * (1.0 / ratio).min(1.0);
    let kernel = Kernel::new(cutoff);
    let reach = kernel.half.ceil() as i64;
    let mut output = Vec::with_capacity(out_len);
    for n in 0..out_len {
        let centre = n as f64 * ratio;
        let base = centre.floor() as i64;
        let first = (base - reach + 1).max(0);
        let last = (base + reach).min(input.len() as i64 - 1);
        let mut sum = 0.0f32;
        for j in first..=last {
            sum += input[j as usize] * kernel.at(centre - j as f64);
        }
        output.push(sum);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f64, rate: u32, seconds: f64) -> Vec<f32> {
        (0..(f64::from(rate) * seconds) as usize)
            .map(|n| (2.0 * PI * freq * n as f64 / f64::from(rate)).sin() as f32)
            .collect()
    }
    fn rms(samples: &[f32]) -> f64 {
        (samples.iter().map(|&s| f64::from(s).powi(2)).sum::<f64>() / samples.len() as f64).sqrt()
    }
    /// Zero crossings per second of the middle half of a signal.
    fn frequency(samples: &[f32], rate: u32) -> f64 {
        let middle = &samples[samples.len() / 4..samples.len() * 3 / 4];
        let crossings = middle
            .windows(2)
            .filter(|pair| pair[0] <= 0.0 && pair[1] > 0.0)
            .count();
        crossings as f64 / (middle.len() as f64 / f64::from(rate))
    }

    #[test]
    fn same_rate_is_a_copy() {
        let input = sine(440.0, 22_050, 0.1);
        assert_eq!(resample(&input, 22_050, 22_050), input);
    }

    #[test]
    fn output_length_follows_the_rates() {
        assert_eq!(resample(&vec![0.0; 48_000], 48_000, 22_050).len(), 22_050);
        assert_eq!(resample(&vec![0.0; 44_100], 44_100, 22_050).len(), 22_050);
        assert_eq!(resample(&vec![0.0; 8_000], 8_000, 22_050).len(), 22_050);
        assert!(resample(&[], 48_000, 22_050).is_empty());
    }

    #[test]
    fn keeps_the_pitch_and_level_of_a_tone() {
        for rate in [44_100, 48_000, 96_000, 16_000] {
            let output = resample(&sine(220.0, rate, 2.0), rate, 22_050);
            let middle = &output[output.len() / 4..output.len() * 3 / 4];
            assert!((frequency(&output, 22_050) - 220.0).abs() < 2.0, "{rate}");
            assert!(
                (rms(middle) - std::f64::consts::FRAC_1_SQRT_2).abs() < 0.01,
                "{rate}"
            );
        }
    }

    #[test]
    fn keeps_a_constant_level() {
        let output = resample(&vec![0.5; 48_000], 48_000, 22_050);
        for &sample in &output[2_000..output.len() - 2_000] {
            assert!((sample - 0.5).abs() < 0.005, "{sample}");
        }
    }

    #[test]
    fn removes_content_above_the_new_nyquist() {
        // 15 kHz at 48 kHz would alias to 7 kHz at 22.05 kHz without the low-pass.
        let output = resample(&sine(15_000.0, 48_000, 1.0), 48_000, 22_050);
        assert!(rms(&output[1_000..output.len() - 1_000]) < 0.01);
    }

    #[test]
    fn upsampling_keeps_the_pitch() {
        let output = resample(&sine(440.0, 8_000, 2.0), 8_000, 22_050);
        assert!((frequency(&output, 22_050) - 440.0).abs() < 2.0);
    }
}
