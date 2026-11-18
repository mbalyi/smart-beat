//! The sample preview: one file at a time, played by a voice of its own in the audio engine
//! (`Engine::start_sample_preview`). It never starts, stops or moves the score.

use std::sync::Arc;

use crate::audio::backing::DecodedAudio;

/// `audio` at `rate`, by linear interpolation. Good enough for auditioning; the lanes keep the
/// file's own rate and use their own resampler.
pub fn resample(audio: &DecodedAudio, rate: u32) -> DecodedAudio {
    if audio.rate == rate || audio.frames() == 0 {
        return DecodedAudio {
            rate,
            ..audio.clone()
        };
    }
    let ratio = f64::from(audio.rate) / f64::from(rate);
    let frames = (audio.frames() as f64 / ratio).floor() as usize;
    let at = |channel: &[f32], pos: f64| {
        let i = pos as usize;
        let frac = (pos - i as f64) as f32;
        let a = channel[i.min(channel.len() - 1)];
        let b = channel[(i + 1).min(channel.len() - 1)];
        a + (b - a) * frac
    };
    let mut left = Vec::with_capacity(frames);
    let mut right = Vec::with_capacity(frames);
    for n in 0..frames {
        let pos = n as f64 * ratio;
        left.push(at(&audio.left, pos));
        right.push(at(&audio.right, pos));
    }
    DecodedAudio {
        rate,
        channels: audio.channels,
        left,
        right,
    }
}

/// Reads and decodes the file at `path`, ready for an engine running at `rate`.
pub fn load(path: &std::path::Path, rate: u32) -> Result<Arc<DecodedAudio>, String> {
    let ext = super::files::extension_of(path);
    let size = std::fs::metadata(path).map_err(|e| format!("That sample cannot be read: {e}"))?;
    if size.len() > crate::audio::backing::MAX_FILE_BYTES as u64 {
        return Err("The audio file is too large".into());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("That sample cannot be read: {e}"))?;
    let audio = crate::audio::backing::decode(bytes, ext.as_deref())?;
    Ok(Arc::new(resample(&audio, rate)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp(rate: u32, frames: usize) -> DecodedAudio {
        let left: Vec<f32> = (0..frames).map(|i| i as f32 / frames as f32).collect();
        DecodedAudio {
            rate,
            channels: 1,
            right: left.clone(),
            left,
        }
    }

    #[test]
    fn resampling_keeps_the_length_in_seconds() {
        let audio = ramp(22_050, 22_050);
        let up = resample(&audio, 44_100);
        assert_eq!(up.rate, 44_100);
        assert!(up.frames().abs_diff(44_100) <= 1);
        assert!((up.duration() - 1.0).abs() < 0.001);
        let down = resample(&audio, 11_025);
        assert!(down.frames().abs_diff(11_025) <= 1);
    }

    #[test]
    fn resampling_interpolates_and_keeps_a_ramp_monotonic() {
        let up = resample(&ramp(100, 100), 400);
        assert!(up.left.windows(2).all(|w| w[1] >= w[0]));
        assert!(up.left.last().copied().unwrap() > 0.98);
    }

    #[test]
    fn the_same_rate_is_a_copy() {
        let audio = ramp(48_000, 10);
        assert_eq!(resample(&audio, 48_000), audio);
    }
}
