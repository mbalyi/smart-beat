//! One clip as the engine plays it: its source read through its own stretcher, with gain,
//! fades and envelope, placed on the audio timeline.

use std::sync::Arc;

use crate::audio::backing::{DecodedAudio, Stretcher};
use crate::audio_lanes::{AudioClip, ClipFade, FadeShape};

/// Everything a voice needs from a clip, in seconds and linear gain.
#[derive(Debug, Clone, PartialEq)]
pub struct ClipPlan {
    /// Where the clip starts and ends on the audio timeline.
    pub start: f64,
    pub end: f64,
    /// Where the clip starts in its source (playing forwards).
    pub offset: f64,
    /// Source seconds played (at playrate 1).
    pub length: f64,
    pub playrate: f64,
    /// Pitch shift as a ratio (clip, lane and song transposition together).
    pub pitch: f64,
    pub preserve_pitch: bool,
    pub gain: f32,
    pub mute: bool,
    pub reversed: bool,
    /// Fades on the timeline, in seconds.
    pub fade_in: (f64, FadeShape),
    pub fade_out: (f64, FadeShape),
    /// (0 … 1 along the clip, linear gain).
    pub envelope: Vec<(f64, f32)>,
    /// (clip seconds on the timeline, source seconds from the offset), increasing.
    pub stretch: Vec<(f64, f64)>,
}

fn db_to_gain(db: f64) -> f32 {
    10f64.powf(db / 20.0) as f32
}

fn fade(f: &ClipFade, playrate: f64) -> (f64, FadeShape) {
    (f.ms / 1_000.0 / playrate, f.shape)
}

impl ClipPlan {
    /// A clip's plan; `extra_semitones` and `extra_cents` come from the lane and the song.
    pub fn from_clip(clip: &AudioClip, extra_semitones: i32, extra_cents: i32) -> Self {
        let take = clip.active_take();
        let cents =
            (clip.semitones + extra_semitones) as f64 * 100.0 + (clip.cents + extra_cents) as f64;
        let mut stretch: Vec<(f64, f64)> = clip
            .stretch
            .iter()
            .map(|m| (m.clip_ms / 1_000.0, m.source_ms / 1_000.0))
            .collect();
        stretch.sort_by(|a, b| a.0.total_cmp(&b.0));
        stretch.dedup_by(|b, a| b.0 <= a.0 || b.1 <= a.1);
        Self {
            start: clip.start_ms / 1_000.0,
            end: clip.end_ms() / 1_000.0,
            offset: take.offset_ms / 1_000.0,
            length: clip.length_ms / 1_000.0,
            playrate: clip.playrate,
            pitch: 2f64.powf(cents / 1_200.0),
            preserve_pitch: clip.preserve_pitch,
            gain: db_to_gain(clip.gain_db),
            mute: clip.mute,
            reversed: clip.reversed,
            fade_in: fade(&clip.fade_in, clip.playrate),
            fade_out: fade(&clip.fade_out, clip.playrate),
            envelope: clip
                .envelope
                .iter()
                .map(|p| (p.at, db_to_gain(p.db)))
                .collect(),
            stretch,
        }
    }

    /// Source seconds (from the clip's offset) at `t` seconds into the clip on the timeline.
    pub fn source_into(&self, t: f64) -> f64 {
        if self.stretch.is_empty() {
            return t * self.playrate;
        }
        // Piecewise linear through (0, 0), the markers and the clip end.
        let duration = self.end - self.start;
        let mut prev = (0.0, 0.0);
        for &(clip, source) in self
            .stretch
            .iter()
            .chain(std::iter::once(&(duration, self.length)))
        {
            if t <= clip {
                let span = clip - prev.0;
                return if span <= 0.0 {
                    source
                } else {
                    prev.1 + (t - prev.0) * (source - prev.1) / span
                };
            }
            prev = (clip, source);
        }
        prev.1 + (t - prev.0) * self.playrate
    }

    /// The clip's gain at `t` seconds into it (fades and envelope; 0 outside the clip).
    pub fn gain_at(&self, t: f64) -> f32 {
        let duration = self.end - self.start;
        if self.mute || t < 0.0 || t >= duration {
            return 0.0;
        }
        let mut g = self.gain;
        if self.fade_in.0 > 0.0 && t < self.fade_in.0 {
            g *= self.fade_in.1.gain((t / self.fade_in.0) as f32);
        }
        let left = duration - t;
        if self.fade_out.0 > 0.0 && left < self.fade_out.0 {
            g *= self.fade_out.1.gain((left / self.fade_out.0) as f32);
        }
        if let Some(e) = self.envelope_at(t / duration) {
            g *= e;
        }
        g
    }

    fn envelope_at(&self, x: f64) -> Option<f32> {
        let points = &self.envelope;
        let first = points.first()?;
        if x <= first.0 {
            return Some(first.1);
        }
        let i = points.partition_point(|p| p.0 <= x);
        let a = points[i - 1];
        Some(match points.get(i) {
            Some(b) if b.0 > a.0 => a.1 + (b.1 - a.1) * ((x - a.0) / (b.0 - a.0)) as f32,
            _ => a.1,
        })
    }
}

/// A clip playing: its plan, its source and its own stretcher.
pub struct ClipVoice {
    pub plan: ClipPlan,
    audio: Arc<DecodedAudio>,
    stretcher: Stretcher,
    left: Vec<f32>,
    right: Vec<f32>,
    active: bool,
}

impl ClipVoice {
    /// `audio` is the source, already reversed when the clip plays backwards. Allocates: build it
    /// off the audio thread.
    pub fn new(
        plan: ClipPlan,
        audio: Arc<DecodedAudio>,
        output_rate: f32,
        max_block: usize,
    ) -> Self {
        let speed = if plan.preserve_pitch {
            1.0
        } else {
            plan.playrate
        };
        let step = plan.pitch * speed * audio.rate as f64 / output_rate as f64;
        Self {
            plan,
            stretcher: Stretcher::new(output_rate, step),
            audio,
            left: vec![0.0; max_block],
            right: vec![0.0; max_block],
            active: false,
        }
    }

    /// Adds the clip into `out` for the timeline positions `times` (seconds, one per sample).
    pub fn render(&mut self, times: &[f64], out: (&mut [f32], &mut [f32])) -> bool {
        let n = times.len();
        let (first, last) = (times[0], times[n - 1]);
        if last < self.plan.start || first >= self.plan.end {
            if self.active {
                self.stretcher.reset();
                self.active = false;
            }
            return false;
        }
        self.active = true;
        let rate = self.audio.rate as f64;
        let start = self.plan.start;
        let (l, r) = (&mut self.left[..n], &mut self.right[..n]);
        let plan = &self.plan;
        let duration = self.audio.duration();
        let (offset, length, reversed) = (plan.offset, plan.length, plan.reversed);
        self.stretcher.render(&self.audio, (l, r), |i| {
            let into = plan.source_into(times[i] - start);
            let s = if reversed {
                duration - (offset + length) + into
            } else {
                offset + into
            };
            s * rate
        });
        for (i, t) in times.iter().enumerate() {
            let g = plan.gain_at(t - start);
            if g != 0.0 {
                out.0[i] += self.left[i] * g;
                out.1[i] += self.right[i] * g;
            }
        }
        true
    }

    pub fn reset(&mut self) {
        self.stretcher.reset();
        self.active = false;
    }

    /// Source position (in source seconds) for a point `t` seconds into the clip.
    #[cfg(test)]
    pub(crate) fn source_at(&self, t: f64) -> f64 {
        let into = self.plan.source_into(t);
        if self.plan.reversed {
            self.audio.duration() - (self.plan.offset + self.plan.length) + into
        } else {
            self.plan.offset + into
        }
    }
}

/// A copy of `audio` played backwards (for reversed clips). Allocates.
pub fn reversed(audio: &DecodedAudio) -> DecodedAudio {
    DecodedAudio {
        rate: audio.rate,
        channels: audio.channels,
        left: audio.left.iter().rev().copied().collect(),
        right: audio.right.iter().rev().copied().collect(),
    }
}
