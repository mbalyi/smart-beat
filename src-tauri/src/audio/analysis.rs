//! Looking at the audio files of the lanes: zero crossings for clean cuts, a WAV copy for
//! "Extract audio file", a spectrogram, loudness (LUFS), tempo and beat detection, and the
//! quiet parts of a file for "Remove silence".

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

/// Loudness of part of a file: integrated (gated, LUFS), the loudest 3-second window (short-term
/// LUFS) and the sample peak (dBFS). −70 stands for silence.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loudness {
    pub integrated: f64,
    pub short_term_max: f64,
    pub peak_db: f64,
}

/// One biquad stage of the K-weighting filter (ITU-R BS.1770), designed for `rate`.
fn k_weighting(rate: f64) -> [[f64; 5]; 2] {
    // High shelf (+4 dB above ~1.5 kHz), then the RLB high-pass at ~38 Hz.
    let shelf = {
        let (f0, g, q) = (
            1_681.974_450_955_533,
            3.999_843_853_973_347,
            0.707_175_236_955_419_6,
        );
        let k = (std::f64::consts::PI * f0 / rate).tan();
        let vh = 10f64.powf(g / 20.0);
        let vb = vh.powf(0.499_666_774_154_541_6);
        let a0 = 1.0 + k / q + k * k;
        [
            (vh + vb * k / q + k * k) / a0,
            2.0 * (k * k - vh) / a0,
            (vh - vb * k / q + k * k) / a0,
            2.0 * (k * k - 1.0) / a0,
            (1.0 - k / q + k * k) / a0,
        ]
    };
    let high_pass = {
        let (f0, q) = (38.135_470_876_024_44, 0.500_327_037_323_877_3);
        let k = (std::f64::consts::PI * f0 / rate).tan();
        let a0 = 1.0 + k / q + k * k;
        [
            1.0,
            -2.0,
            1.0,
            2.0 * (k * k - 1.0) / a0,
            (1.0 - k / q + k * k) / a0,
        ]
    };
    [shelf, high_pass]
}

/// Integrated, short-term and peak loudness of `[start_ms, end_ms)` of a file.
pub fn loudness(audio: &DecodedAudio, start_ms: f64, end_ms: f64) -> Loudness {
    let rate = audio.rate.max(1) as f64;
    let start = ((start_ms.max(0.0) / 1000.0) * rate) as usize;
    let end = ((end_ms / 1000.0 * rate) as usize).min(audio.frames());
    let silent = Loudness {
        integrated: -70.0,
        short_term_max: -70.0,
        peak_db: -70.0,
    };
    if end <= start + (rate * 0.4) as usize {
        return silent;
    }
    let stages = k_weighting(rate);
    let mut weighted = [
        Vec::with_capacity(end - start),
        Vec::with_capacity(end - start),
    ];
    let mut peak = 0f32;
    for (channel, samples) in [&audio.left, &audio.right].into_iter().enumerate() {
        let mut state = [[0.0f64; 4]; 2];
        for &x in &samples[start..end] {
            peak = peak.max(x.abs());
            let mut v = x as f64;
            for (stage, s) in stages.iter().zip(state.iter_mut()) {
                let y = stage[0] * v + stage[1] * s[0] + stage[2] * s[1]
                    - stage[3] * s[2]
                    - stage[4] * s[3];
                *s = [v, s[0], y, s[2]];
                v = y;
            }
            weighted[channel].push(v * v);
        }
    }
    // 400 ms blocks every 100 ms (75 % overlap), summed over both channels.
    let block = (rate * 0.4) as usize;
    let hop = (rate * 0.1) as usize;
    let powers: Vec<f64> = (0..=(weighted[0].len() - block) / hop)
        .map(|i| {
            let r = i * hop..i * hop + block;
            (weighted[0][r.clone()].iter().sum::<f64>() + weighted[1][r].iter().sum::<f64>())
                / block as f64
        })
        .collect();
    let lufs = |p: f64| {
        if p <= 0.0 {
            -70.0
        } else {
            -0.691 + 10.0 * p.log10()
        }
    };
    let absolute: Vec<f64> = powers
        .iter()
        .copied()
        .filter(|p| lufs(*p) > -70.0)
        .collect();
    if absolute.is_empty() {
        return Loudness {
            peak_db: 20.0 * (peak.max(1e-6) as f64).log10(),
            ..silent
        };
    }
    let relative_gate = lufs(absolute.iter().sum::<f64>() / absolute.len() as f64) - 10.0;
    let gated: Vec<f64> = absolute
        .into_iter()
        .filter(|p| lufs(*p) > relative_gate)
        .collect();
    let integrated = lufs(gated.iter().sum::<f64>() / gated.len().max(1) as f64);
    // Short-term: 3 s windows (30 blocks of 100 ms hops).
    let short_term_max = powers
        .windows(27.min(powers.len()))
        .map(|w| lufs(w.iter().sum::<f64>() / w.len() as f64))
        .fold(-70.0f64, f64::max);
    Loudness {
        integrated,
        short_term_max,
        peak_db: 20.0 * (peak.max(1e-6) as f64).log10(),
    }
}

/// The length of the windows `silent_regions` measures, in ms.
const SILENCE_WINDOW_MS: f64 = 10.0;

/// A quiet part of a file, in ms of the file.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SilentRegion {
    pub start_ms: f64,
    pub end_ms: f64,
}

/// How many frames one silence window holds.
fn window_frames(audio: &DecodedAudio) -> usize {
    ((SILENCE_WINDOW_MS / 1000.0) * audio.rate.max(1) as f64)
        .round()
        .max(1.0) as usize
}

/// The level (dBFS) of each 10 ms window of a file: the RMS of both channels together.
fn window_levels(audio: &DecodedAudio) -> Vec<f64> {
    let size = window_frames(audio);
    let frames = audio.frames().min(audio.right.len());
    (0..frames.div_ceil(size))
        .map(|w| {
            let range = w * size..((w + 1) * size).min(frames);
            let count = (range.len() * 2).max(1) as f64;
            let power = audio.left[range.clone()]
                .iter()
                .chain(&audio.right[range])
                .map(|&x| (x as f64) * (x as f64))
                .sum::<f64>()
                / count;
            10.0 * power.max(1e-12).log10()
        })
        .collect()
}

/// The parts of a file quieter than `threshold_db` (RMS of both channels over 10 ms windows)
/// for at least `min_silence_ms`, each shrunk by `pad_ms` on both sides so the sound around them
/// keeps its tail and its attack. In file ms, in order.
pub fn silent_regions(
    audio: &DecodedAudio,
    threshold_db: f64,
    min_silence_ms: f64,
    pad_ms: f64,
) -> Vec<SilentRegion> {
    let duration_ms = audio.duration() * 1000.0;
    let threshold = threshold_db.clamp(-120.0, 0.0);
    let min_silence = min_silence_ms.max(SILENCE_WINDOW_MS);
    let pad = pad_ms.max(0.0);
    let window_ms = window_frames(audio) as f64 * 1000.0 / audio.rate.max(1) as f64;
    let levels = window_levels(audio);
    let mut regions = Vec::new();
    let mut start: Option<usize> = None;
    for i in 0..=levels.len() {
        let quiet = levels.get(i).is_some_and(|&db| db < threshold);
        match (quiet, start) {
            (true, None) => start = Some(i),
            (false, Some(first)) => {
                start = None;
                let from = first as f64 * window_ms;
                let to = (i as f64 * window_ms).min(duration_ms);
                if to - from >= min_silence && to - from > 2.0 * pad {
                    regions.push(SilentRegion {
                        start_ms: from + pad,
                        end_ms: to - pad,
                    });
                }
            }
            _ => {}
        }
    }
    regions
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
    fn measures_the_loudness_of_a_sine() {
        // A full-scale 1 kHz sine reads −3 LUFS per channel; both channels sum to about 0 LUFS.
        let full = audio(
            (0..RATE as usize * 4)
                .map(|i| (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / RATE as f32).sin())
                .collect(),
        );
        let l = loudness(&full, 0.0, 4_000.0);
        assert!(l.integrated.abs() < 0.3, "{} LUFS", l.integrated);
        assert!(l.peak_db.abs() < 0.1);
        let quieter = audio(full.left.iter().map(|s| s * 0.1).collect());
        assert!((loudness(&quieter, 0.0, 4_000.0).integrated - (l.integrated - 20.0)).abs() < 0.5);
        assert_eq!(
            loudness(&audio(vec![0.0; RATE as usize * 2]), 0.0, 2_000.0).integrated,
            -70.0
        );
    }

    #[test]
    fn detects_the_tempo_of_clicks() {
        let info = detect_beats(&clicks(0.5, 12.0));
        assert!((info.bpm - 120.0).abs() < 3.0, "{} bpm", info.bpm);
        assert!(info.beats.len() >= 20);
        assert!(info.beats[1] - info.beats[0] > 450.0);
    }

    /// `parts` of (seconds, loud) one after another: a 440 Hz tone at half scale, or silence.
    fn sections(parts: &[(f32, bool)]) -> DecodedAudio {
        audio(
            parts
                .iter()
                .flat_map(|&(seconds, loud)| {
                    (0..(seconds * RATE as f32) as usize).map(move |i| {
                        if loud {
                            (2.0 * std::f32::consts::PI * 440.0 * i as f32 / RATE as f32).sin()
                                * 0.5
                        } else {
                            0.0
                        }
                    })
                })
                .collect(),
        )
    }

    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() <= SILENCE_WINDOW_MS + 0.01
    }

    #[test]
    fn finds_the_silence_around_a_tone() {
        let a = sections(&[(1.0, false), (1.0, true), (1.0, false)]);
        let regions = silent_regions(&a, -45.0, 300.0, 0.0);
        assert_eq!(regions.len(), 2, "{regions:?}");
        assert!(near(regions[0].start_ms, 0.0) && near(regions[0].end_ms, 1_000.0));
        assert!(near(regions[1].start_ms, 2_000.0) && near(regions[1].end_ms, 3_000.0));
    }

    #[test]
    fn padding_shrinks_each_region_on_both_sides() {
        let a = sections(&[(1.0, false), (1.0, true), (1.0, false)]);
        let plain = silent_regions(&a, -45.0, 300.0, 0.0);
        let padded = silent_regions(&a, -45.0, 300.0, 50.0);
        assert_eq!(padded.len(), 2);
        for (p, q) in plain.iter().zip(&padded) {
            assert!((q.start_ms - p.start_ms - 50.0).abs() < 1e-6);
            assert!((p.end_ms - q.end_ms - 50.0).abs() < 1e-6);
        }
    }

    #[test]
    fn short_gaps_are_not_silence() {
        // 200 ms of silence between two tones is shorter than the minimum.
        let a = sections(&[
            (1.0, true),
            (0.2, false),
            (1.0, true),
            (0.5, false),
            (0.5, true),
        ]);
        let regions = silent_regions(&a, -45.0, 300.0, 0.0);
        assert_eq!(regions.len(), 1, "{regions:?}");
        assert!(near(regions[0].start_ms, 2_200.0) && near(regions[0].end_ms, 2_700.0));
    }

    #[test]
    fn the_threshold_decides_what_is_quiet() {
        // A tone at about −26 dBFS RMS: quiet for a −20 dB threshold, sound for −45 dB.
        let soft = audio(
            sections(&[(1.0, true)])
                .left
                .iter()
                .map(|s| s * 0.1)
                .collect(),
        );
        assert!(silent_regions(&soft, -45.0, 300.0, 0.0).is_empty());
        let all = silent_regions(&soft, -20.0, 300.0, 0.0);
        assert_eq!(all.len(), 1);
        assert!(near(all[0].start_ms, 0.0) && near(all[0].end_ms, 1_000.0));
    }

    #[test]
    fn a_tone_throughout_has_no_silence_and_padding_can_eat_a_region() {
        assert!(silent_regions(&sections(&[(2.0, true)]), -45.0, 300.0, 0.0).is_empty());
        let a = sections(&[(1.0, true), (0.4, false), (1.0, true)]);
        assert_eq!(silent_regions(&a, -45.0, 300.0, 0.0).len(), 1);
        assert!(silent_regions(&a, -45.0, 300.0, 250.0).is_empty());
        assert!(silent_regions(&audio(Vec::new()), -45.0, 300.0, 0.0).is_empty());
    }
}
