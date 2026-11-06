//! The rendered mix: the stems weighted by the page's gains (mute and solo are already in
//! them), added up, and slowed down without changing the pitch.

use std::collections::BTreeMap;

use super::StemSong;
use super::store::StemStore;
use super::wav::{self, Pcm16};
use crate::audio::backing::{DecodedAudio, Stretcher};
use crate::separation::StemKind;

/// Slowest and fastest speed the mix is rendered at.
pub const MIN_SPEED: f64 = 0.5;
pub const MAX_SPEED: f64 = 1.0;

const BLOCK: usize = 16_384;

pub fn validate(gains: &BTreeMap<StemKind, f32>, speed: f64) -> Result<(), String> {
    if !(speed.is_finite() && (MIN_SPEED..=MAX_SPEED).contains(&speed)) {
        return Err("The speed must be between 50 % and 100 %".into());
    }
    for (kind, gain) in gains {
        if !(gain.is_finite() && (0.0..=1.0).contains(gain)) {
            return Err(format!("The {} volume must be between 0 and 1", kind.id()));
        }
    }
    Ok(())
}

/// The sum of the stems of `song` weighted by `gains` (a stem without an entry counts as 0),
/// as the left and right channel.
fn sum_stems(
    store: &StemStore,
    song: &StemSong,
    gains: &BTreeMap<StemKind, f32>,
) -> Result<DecodedAudio, String> {
    let mut readers = Vec::new();
    for info in &song.stems {
        let pcm = Pcm16::open(&store.stem_path(&song.id, info.kind)?)?;
        readers.push((gains.get(&info.kind).copied().unwrap_or(0.0), pcm));
    }
    let rate = readers.first().map_or(song.sample_rate, |(_, p)| p.rate);
    let frames = readers.iter().map(|(_, p)| p.frames).max().unwrap_or(0) as usize;
    let (mut left, mut right) = (vec![0.0f32; frames], vec![0.0f32; frames]);
    let (mut bl, mut br) = (Vec::new(), Vec::new());
    for (gain, pcm) in &mut readers {
        if *gain <= 0.0 {
            continue;
        }
        let mut at = 0;
        loop {
            bl.clear();
            br.clear();
            let n = pcm.read_block(&mut bl, &mut br, BLOCK)?;
            if n == 0 {
                break;
            }
            for i in 0..n {
                left[at + i] += bl[i] * *gain;
                right[at + i] += br[i] * *gain;
            }
            at += n;
        }
    }
    Ok(DecodedAudio {
        rate,
        channels: 2,
        left,
        right,
    })
}

/// The mix at `speed` (0.5 to 1) as a 16-bit stereo WAV. Speed 1 skips the stretcher.
pub fn render(
    store: &StemStore,
    song: &StemSong,
    gains: &BTreeMap<StemKind, f32>,
    speed: f64,
) -> Result<Vec<u8>, String> {
    validate(gains, speed)?;
    let mix = sum_stems(store, song, gains)?;
    if (speed - 1.0).abs() < 1e-6 || mix.frames() == 0 {
        return wav::encode(mix.rate, &mix.left, &mix.right);
    }
    let (left, right) = stretch(&mix, speed);
    wav::encode(mix.rate, &left, &right)
}

/// Slows `mix` down to `speed` of its tempo, pitch unchanged. The stretcher runs at the
/// recording's own rate (`step` = source rate / output rate = 1), so only the grains' positions
/// change: output sample `i` is taken from source sample `i * speed`.
pub fn stretch(mix: &DecodedAudio, speed: f64) -> (Vec<f32>, Vec<f32>) {
    let out_len = (mix.frames() as f64 / speed).ceil() as usize;
    // The first grain only fades in. Starting half a grain early (the source is silent before
    // its start) gives the start of the song its full level.
    let lead = (mix.rate as f64 * 0.043) as usize / 2 + 64;
    let mut stretcher = Stretcher::new(mix.rate as f32, 1.0);
    let (mut left, mut right) = (Vec::with_capacity(out_len), Vec::with_capacity(out_len));
    let (mut bl, mut br) = (vec![0.0f32; BLOCK], vec![0.0f32; BLOCK]);
    let total = lead + out_len;
    let mut done = 0;
    while done < total {
        let n = BLOCK.min(total - done);
        let base = done;
        stretcher.render(mix, (&mut bl[..n], &mut br[..n]), |i| {
            ((base + i) as f64 - lead as f64) * speed
        });
        let skip = lead.saturating_sub(done).min(n);
        left.extend_from_slice(&bl[skip..n]);
        right.extend_from_slice(&br[skip..n]);
        done += n;
    }
    (left, right)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn tone(rate: u32, seconds: f64) -> DecodedAudio {
        let frames = (rate as f64 * seconds) as usize;
        let left: Vec<f32> = (0..frames)
            .map(|i| (0.5 * (2.0 * PI * 440.0 * i as f64 / rate as f64).sin()) as f32)
            .collect();
        DecodedAudio {
            rate,
            channels: 2,
            right: left.clone(),
            left,
        }
    }

    fn crossings(samples: &[f32]) -> usize {
        samples
            .windows(2)
            .filter(|w| w[0] <= 0.0 && w[1] > 0.0)
            .count()
    }

    #[test]
    fn half_speed_doubles_the_length_and_keeps_the_pitch() {
        let src = tone(44_100, 2.0);
        let (l, r) = stretch(&src, 0.5);
        assert_eq!(l.len(), r.len());
        assert_eq!(l.len(), 2 * src.frames());
        // Frequency from zero crossings, over the middle of the output.
        let mid = &l[l.len() / 4..3 * l.len() / 4];
        let hz = crossings(mid) as f64 * 44_100.0 / mid.len() as f64;
        assert!((hz - 440.0).abs() < 8.0, "{hz}");
        // The start has its full level, not a fade-in.
        let head = l[..2000].iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(head > 0.4, "{head}");
    }

    #[test]
    fn a_speed_outside_the_range_or_a_bad_gain_is_refused() {
        let ok = BTreeMap::from([(StemKind::Bass, 1.0)]);
        assert!(validate(&ok, 0.5).is_ok() && validate(&ok, 1.0).is_ok());
        for speed in [0.49, 1.01, f64::NAN, f64::INFINITY, 0.0] {
            assert!(validate(&ok, speed).is_err(), "{speed}");
        }
        for gain in [-0.1, 1.1, f32::NAN] {
            assert!(validate(&BTreeMap::from([(StemKind::Bass, gain)]), 1.0).is_err());
        }
    }
}
