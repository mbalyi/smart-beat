//! Looking at the audio files of the lanes: zero crossings for clean cuts, a WAV copy for
//! "Extract audio file", a spectrogram, and tempo and beat detection from onsets.

use realfft::RealFftPlanner;
use serde::Serialize;

use super::backing::DecodedAudio;

/// How far a cut may move to land on a zero crossing.
const ZERO_CROSSING_MS: f64 = 10.0;

/// The nearest point to `ms` where the mono signal crosses zero (or `ms` when there is none
/// within 10 ms), in ms.
pub fn nearest_zero_crossing(audio: &DecodedAudio, ms: f64) -> f64 {
    let rate = audio.rate.max(1) as f64;
    let frames = audio.frames();
    if frames < 2 {
        return ms;
    }
    let centre = ((ms / 1000.0) * rate)
        .round()
        .clamp(0.0, (frames - 2) as f64) as usize;
    let reach = (ZERO_CROSSING_MS / 1000.0 * rate) as usize;
    let mono = |i: usize| audio.left[i] + audio.right[i];
    let crosses = |i: usize| {
        let (a, b) = (mono(i), mono(i + 1));
        a == 0.0 || (a < 0.0) != (b < 0.0)
    };
    for d in 0..=reach {
        for i in [centre.checked_sub(d), Some(centre + d)]
            .into_iter()
            .flatten()
        {
            if i + 1 < frames && crosses(i) {
                return i as f64 * 1000.0 / rate;
            }
        }
    }
    ms
}

/// The audio as a 16-bit stereo WAV file.
pub fn wav_bytes(audio: &DecodedAudio) -> Vec<u8> {
    let frames = audio.frames() as u32;
    let data_len = frames * 4;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&audio.rate.to_le_bytes());
    out.extend_from_slice(&(audio.rate * 4).to_le_bytes());
    out.extend_from_slice(&4u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for (l, r) in audio.left.iter().zip(&audio.right) {
        for s in [l, r] {
            out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32_767.0) as i16).to_le_bytes());
        }
    }
    out
}

/// Magnitudes in dB (−100 … 0) of `columns` slices of `[start_ms, end_ms)`, each with `bins`
/// frequency bands from 0 Hz to half the sample rate.
pub fn spectrogram(
    audio: &DecodedAudio,
    start_ms: f64,
    end_ms: f64,
    columns: usize,
    bins: usize,
) -> Vec<Vec<f32>> {
    let rate = audio.rate.max(1) as f64;
    let size = (bins * 2).next_power_of_two().max(64);
    let fft = RealFftPlanner::<f32>::new().plan_fft_forward(size);
    let mut input = fft.make_input_vec();
    let mut spectrum = fft.make_output_vec();
    let window: Vec<f32> = (0..size)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / size as f32).cos())
        .collect();
    let start = (start_ms.max(0.0) / 1000.0 * rate) as usize;
    let end = ((end_ms / 1000.0 * rate) as usize)
        .min(audio.frames())
        .max(start + 1);
    let step = (end - start) as f64 / columns.max(1) as f64;
    (0..columns)
        .map(|c| {
            let at = start + (c as f64 * step) as usize;
            for (i, x) in input.iter_mut().enumerate() {
                let j = at + i;
                let s = if j < audio.frames() {
                    0.5 * (audio.left[j] + audio.right[j])
                } else {
                    0.0
                };
                *x = s * window[i];
            }
            if fft.process(&mut input, &mut spectrum).is_err() {
                return vec![-100.0; bins];
            }
            let per = (spectrum.len() - 1) as f64 / bins as f64;
            (0..bins)
                .map(|b| {
                    let (lo, hi) = (
                        (b as f64 * per) as usize,
                        (((b + 1) as f64 * per) as usize).max(b + 1),
                    );
                    let peak = spectrum[lo..hi.min(spectrum.len())]
                        .iter()
                        .map(|z| z.norm())
                        .fold(0.0f32, f32::max);
                    (20.0 * (peak / (size as f32 / 4.0)).max(1e-5).log10()).clamp(-100.0, 0.0)
                })
                .collect()
        })
        .collect()
}

/// A detected tempo and the beats that follow it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatInfo {
    pub bpm: f64,
    /// Where each beat falls in the file, in ms.
    pub beats: Vec<f64>,
}

/// Envelope rate of the onset detector (frames per second).
const ONSET_RATE: f64 = 100.0;

/// How much louder each 10 ms of the file is than the one before (half-wave rectified).
fn onset_envelope(audio: &DecodedAudio) -> Vec<f32> {
    let hop = (audio.rate as f64 / ONSET_RATE).max(1.0) as usize;
    let energy: Vec<f32> = (0..audio.frames() / hop)
        .map(|i| {
            let s = &audio.left[i * hop..(i + 1) * hop];
            let r = &audio.right[i * hop..(i + 1) * hop];
            (s.iter().chain(r).map(|x| x * x).sum::<f32>() / (2 * hop) as f32 + 1e-9).ln()
        })
        .collect();
    std::iter::once(0.0)
        .chain(energy.windows(2).map(|w| (w[1] - w[0]).max(0.0)))
        .collect()
}

/// The tempo (60 … 200 bpm) whose beat period best matches the onsets, and the beats placed
/// on the strongest phase of that period.
pub fn detect_beats(audio: &DecodedAudio) -> BeatInfo {
    let onsets = onset_envelope(audio);
    if onsets.len() < 4 * ONSET_RATE as usize {
        return BeatInfo {
            bpm: 0.0,
            beats: Vec::new(),
        };
    }
    let score_lag =
        |lag: usize| -> f32 { onsets.iter().zip(&onsets[lag..]).map(|(a, b)| a * b).sum() };
    let (min_lag, max_lag) = (
        (ONSET_RATE * 60.0 / 200.0) as usize,
        (ONSET_RATE * 60.0 / 60.0) as usize,
    );
    let best = (min_lag..=max_lag)
        .map(|lag| {
            // Favour tempos whose double period agrees too (less octave confusion).
            let weight =
                score_lag(lag) + 0.5 * onsets.get(lag * 2..).map_or(0.0, |_| score_lag(lag * 2));
            (lag, weight)
        })
        .fold((min_lag, f32::MIN), |a, b| if b.1 > a.1 { b } else { a })
        .0;
    let phase = (0..best)
        .map(|p| (p, onsets.iter().skip(p).step_by(best).sum::<f32>()))
        .fold((0, f32::MIN), |a, b| if b.1 > a.1 { b } else { a })
        .0;
    let beats = (phase..onsets.len())
        .step_by(best)
        .map(|i| i as f64 * 1000.0 / ONSET_RATE)
        .collect();
    BeatInfo {
        bpm: 60.0 * ONSET_RATE / best as f64,
        beats,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;

    fn audio(left: Vec<f32>) -> DecodedAudio {
        DecodedAudio {
            rate: RATE,
            channels: 2,
            right: left.clone(),
            left,
        }
    }

    fn sine(freq: f32, seconds: f32) -> DecodedAudio {
        audio(
            (0..(seconds * RATE as f32) as usize)
                .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / RATE as f32).sin() * 0.5)
                .collect(),
        )
    }

    /// Short clicks every `period` seconds.
    fn clicks(period: f32, seconds: f32) -> DecodedAudio {
        let frames = (seconds * RATE as f32) as usize;
        let every = (period * RATE as f32) as usize;
        audio(
            (0..frames)
                .map(|i| if i % every < 200 { 0.8 } else { 0.0 })
                .collect(),
        )
    }

    #[test]
    fn finds_a_zero_crossing_near_the_cut() {
        let a = sine(100.0, 1.0);
        // A 100 Hz sine crosses zero every 5 ms.
        let ms = nearest_zero_crossing(&a, 7.0);
        assert!((ms - 5.0).abs() < 0.1 || (ms - 10.0).abs() < 0.1, "{ms}");
    }

    #[test]
    fn writes_a_wav_header_and_samples() {
        let bytes = wav_bytes(&sine(440.0, 0.1));
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(bytes.len(), 44 + 4_800 * 4);
    }

    #[test]
    fn the_spectrogram_peaks_at_the_tone() {
        let cols = spectrogram(&sine(6_000.0, 1.0), 0.0, 1_000.0, 4, 64);
        assert_eq!(cols.len(), 4);
        let loudest = cols[1]
            .iter()
            .enumerate()
            .fold(
                (0, f32::MIN),
                |a, (i, v)| if *v > a.1 { (i, *v) } else { a },
            )
            .0;
        // 6 kHz of 24 kHz across 64 bands: band 16.
        assert!((15..=17).contains(&loudest), "band {loudest}");
    }

    #[test]
    fn detects_the_tempo_of_clicks() {
        let info = detect_beats(&clicks(0.5, 12.0));
        assert!((info.bpm - 120.0).abs() < 3.0, "{} bpm", info.bpm);
        assert!(info.beats.len() >= 20);
        assert!(info.beats[1] - info.beats[0] > 450.0);
    }
}
