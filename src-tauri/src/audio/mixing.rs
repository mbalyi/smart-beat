//! Mixer maths shared by the track buses, the drum elements and the audio
//! track: constant-power pan, click-free gain ramps, the channel-strip EQ and
//! automation lanes (volume, pan and mute along the timeline).

use std::f32::consts::{FRAC_PI_4, SQRT_2};

use serde::{Deserialize, Serialize};

use super::dsp::biquad::FilterKind;
use super::dsp::eq::{Band, graphic_bands};

/// Left and right gains of a constant-power pan law, normalised so the centre
/// is unity on both sides (the level of an unpanned track does not change).
pub fn pan_gains(gain: f32, pan: f32) -> (f32, f32) {
    let angle = (pan.clamp(-1.0, 1.0) + 1.0) * FRAC_PI_4;
    (gain * angle.cos() * SQRT_2, gain * angle.sin() * SQRT_2)
}

/// Adds `src` into `out`, ramping the gains linearly from `from` to `to` over
/// the block (so mutes, faders and automation never click). Returns the peak
/// of what was added.
pub fn mix_into(
    src: (&[f32], &[f32]),
    out: (&mut [f32], &mut [f32]),
    from: (f32, f32),
    to: (f32, f32),
) -> f32 {
    let n = src.0.len();
    let step = 1.0 / n.max(1) as f32;
    let mut peak = 0.0f32;
    for i in 0..n {
        let t = (i + 1) as f32 * step;
        let gl = from.0 + (to.0 - from.0) * t;
        let gr = from.1 + (to.1 - from.1) * t;
        let (a, b) = (src.0[i] * gl, src.1[i] * gr);
        peak = peak.max(a.abs()).max(b.abs());
        out.0[i] += a;
        out.1[i] += b;
    }
    peak
}

/// Mixer channel EQ: low shelf, mid peak and high shelf, or a 10-band
/// graphic EQ when `graphic` holds ten gains. Mirrored by `TrackEq` in
/// `src/lib/tauri.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrackEq {
    pub low_db: f32,
    pub mid_db: f32,
    pub mid_hz: f32,
    pub high_db: f32,
    /// Ten gains (31 Hz … 16 kHz) or empty for the three-band EQ.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub graphic: Vec<f32>,
}

impl Default for TrackEq {
    fn default() -> Self {
        Self {
            low_db: 0.0,
            mid_db: 0.0,
            mid_hz: 1_000.0,
            high_db: 0.0,
            graphic: Vec::new(),
        }
    }
}

pub const EQ_LOW_HZ: f32 = 120.0;
pub const EQ_HIGH_HZ: f32 = 6_000.0;
pub const EQ_MAX_DB: f32 = 15.0;

impl TrackEq {
    pub fn is_graphic(&self) -> bool {
        self.graphic.len() == 10
    }

    /// True when the EQ does nothing (the engine then skips it).
    pub fn is_flat(&self) -> bool {
        if self.is_graphic() {
            self.graphic.iter().all(|g| *g == 0.0)
        } else {
            self.low_db == 0.0 && self.mid_db == 0.0 && self.high_db == 0.0
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        let gain_ok = |g: f32| g.is_finite() && g.abs() <= EQ_MAX_DB;
        if !gain_ok(self.low_db) || !gain_ok(self.mid_db) || !gain_ok(self.high_db) {
            return Err(format!("EQ gains must be within ±{EQ_MAX_DB} dB"));
        }
        if !(self.mid_hz.is_finite() && (200.0..=5_000.0).contains(&self.mid_hz)) {
            return Err("the EQ mid frequency must be between 200 Hz and 5 kHz".into());
        }
        if !self.graphic.is_empty()
            && (!self.is_graphic() || !self.graphic.iter().all(|g| gain_ok(*g)))
        {
            return Err("the graphic EQ needs ten gains within range".into());
        }
        Ok(())
    }

    pub fn bands(&self) -> Vec<Band> {
        let clamp = |g: f32| {
            if g.is_finite() {
                g.clamp(-EQ_MAX_DB, EQ_MAX_DB)
            } else {
                0.0
            }
        };
        if self.is_graphic() {
            let mut bands = graphic_bands();
            for (band, gain) in bands.iter_mut().zip(&self.graphic) {
                band.gain_db = clamp(*gain);
            }
            return bands;
        }
        vec![
            Band {
                kind: FilterKind::LowShelf,
                freq: EQ_LOW_HZ,
                q: 0.707,
                gain_db: clamp(self.low_db),
            },
            Band {
                kind: FilterKind::Peak,
                freq: if self.mid_hz.is_finite() {
                    self.mid_hz.clamp(200.0, 5_000.0)
                } else {
                    1_000.0
                },
                q: 0.9,
                gain_db: clamp(self.mid_db),
            },
            Band {
                kind: FilterKind::HighShelf,
                freq: EQ_HIGH_HZ,
                q: 0.707,
                gain_db: clamp(self.high_db),
            },
        ]
    }
}

/// One automation point as the UI sends it: a song position (ticks) and a value.
pub type TickPoint = (u32, f32);

/// The automation of one track, in ticks (as sent by the UI). Volume is
/// 0…1, pan -1…1 and mute 0 or 1.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutomationData {
    pub enabled: bool,
    pub volume: Vec<TickPoint>,
    pub pan: Vec<TickPoint>,
    pub mute: Vec<TickPoint>,
}

/// Upper bound on points per lane.
pub const MAX_AUTOMATION_POINTS: usize = 4_096;

impl AutomationData {
    pub fn validate(&self) -> Result<(), String> {
        for (lane, min, max) in [
            (&self.volume, 0.0, 1.0),
            (&self.pan, -1.0, 1.0),
            (&self.mute, 0.0, 1.0),
        ] {
            if lane.len() > MAX_AUTOMATION_POINTS {
                return Err("too many automation points".into());
            }
            if lane
                .iter()
                .any(|(_, v)| !(v.is_finite() && (min..=max).contains(v)))
            {
                return Err("automation value out of range".into());
            }
        }
        Ok(())
    }
}

/// A lane in seconds, sorted.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Lane {
    points: Vec<(f64, f32)>,
}

impl Lane {
    pub fn new(mut points: Vec<(f64, f32)>) -> Self {
        points.retain(|(t, v)| t.is_finite() && v.is_finite());
        points.sort_by(|a, b| a.0.total_cmp(&b.0));
        Self { points }
    }

    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    /// Linear between points, flat before the first and after the last.
    pub fn value_at(&self, time: f64) -> Option<f32> {
        let first = self.points.first()?;
        let i = self.points.partition_point(|p| p.0 <= time);
        if i == 0 {
            return Some(first.1);
        }
        let (t0, v0) = self.points[i - 1];
        match self.points.get(i) {
            None => Some(v0),
            Some(&(t1, v1)) if t1 > t0 => {
                let t = ((time - t0) / (t1 - t0)) as f32;
                Some(v0 + (v1 - v0) * t)
            }
            Some(_) => Some(v0),
        }
    }

    /// The value of the last point at or before `time` (for on/off lanes).
    pub fn step_at(&self, time: f64) -> Option<f32> {
        let first = self.points.first()?;
        let i = self.points.partition_point(|p| p.0 <= time);
        Some(if i == 0 {
            first.1
        } else {
            self.points[i - 1].1
        })
    }
}

/// A track's automation in seconds.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Automation {
    pub volume: Lane,
    pub pan: Lane,
    pub mute: Lane,
}

impl Automation {
    pub fn from_ticks(data: &AutomationData, seconds_at: impl Fn(u32) -> f64) -> Self {
        if !data.enabled {
            return Self::default();
        }
        let lane = |points: &[TickPoint]| {
            Lane::new(
                points
                    .iter()
                    .map(|&(tick, v)| (seconds_at(tick), v))
                    .collect(),
            )
        };
        Self {
            volume: lane(&data.volume),
            pan: lane(&data.pan),
            mute: lane(&data.mute),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.volume.is_empty() && self.pan.is_empty() && self.mute.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pan_is_constant_power_and_unity_in_the_centre() {
        let (l, r) = pan_gains(1.0, 0.0);
        assert!((l - 1.0).abs() < 1e-6 && (r - 1.0).abs() < 1e-6);
        let (l, r) = pan_gains(1.0, -1.0);
        assert!((l - SQRT_2).abs() < 1e-6 && r.abs() < 1e-6);
        // Power is the same anywhere.
        for pan in [-0.7, -0.2, 0.3, 0.9] {
            let (l, r) = pan_gains(1.0, pan);
            assert!((l * l + r * r - 2.0).abs() < 1e-5, "pan {pan}");
        }
        // Out-of-range pans are clamped.
        assert_eq!(pan_gains(0.5, 9.0), pan_gains(0.5, 1.0));
    }

    #[test]
    fn gain_ramps_reach_the_target_without_jumps() {
        let src = vec![1.0f32; 64];
        let (mut l, mut r) = (vec![0.0; 64], vec![0.0; 64]);
        let peak = mix_into((&src, &src), (&mut l, &mut r), (0.0, 0.0), (1.0, 0.5));
        assert!((l[63] - 1.0).abs() < 1e-6 && (r[63] - 0.5).abs() < 1e-6);
        assert!(l.windows(2).all(|w| w[1] - w[0] < 0.02));
        assert!((peak - 1.0).abs() < 1e-6);
    }

    #[test]
    fn eq_has_three_bands_or_ten() {
        let eq = TrackEq::default();
        assert!(eq.is_flat());
        assert_eq!(eq.bands().len(), 3);
        let graphic = TrackEq {
            graphic: vec![0.0, 3.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -2.0],
            ..Default::default()
        };
        assert!(!graphic.is_flat());
        assert_eq!(graphic.bands().len(), 10);
        assert_eq!(graphic.bands()[1].gain_db, 3.0);
        assert!(graphic.validate().is_ok());
        let bad = TrackEq {
            graphic: vec![0.0; 4],
            ..Default::default()
        };
        assert!(bad.validate().is_err());
        let loud = TrackEq {
            low_db: 40.0,
            ..Default::default()
        };
        assert!(loud.validate().is_err());
        assert_eq!(loud.bands()[0].gain_db, EQ_MAX_DB);
    }

    #[test]
    fn lanes_interpolate_and_hold_their_ends() {
        let lane = Lane::new(vec![(2.0, 1.0), (0.0, 0.0), (4.0, 1.0)]);
        assert_eq!(lane.value_at(-1.0), Some(0.0));
        assert_eq!(lane.value_at(1.0), Some(0.5));
        assert_eq!(lane.value_at(3.0), Some(1.0));
        assert_eq!(lane.value_at(10.0), Some(1.0));
        assert_eq!(lane.step_at(1.9), Some(0.0));
        assert_eq!(lane.step_at(2.0), Some(1.0));
        assert_eq!(Lane::default().value_at(1.0), None);
        // NaN points are dropped.
        assert_eq!(Lane::new(vec![(f64::NAN, 1.0)]).value_at(0.0), None);
    }

    #[test]
    fn automation_converts_ticks_and_is_off_when_disabled() {
        let data = AutomationData {
            enabled: true,
            volume: vec![(0, 1.0), (960, 0.0)],
            pan: vec![],
            mute: vec![(1920, 1.0)],
        };
        assert!(data.validate().is_ok());
        let a = Automation::from_ticks(&data, |t| t as f64 / 960.0 * 0.5);
        assert_eq!(a.volume.value_at(0.25), Some(0.5));
        assert_eq!(a.mute.step_at(1.0), Some(1.0));
        let off = Automation::from_ticks(
            &AutomationData {
                enabled: false,
                ..data.clone()
            },
            |t| t as f64,
        );
        assert!(off.is_empty());
        let bad = AutomationData {
            pan: vec![(0, 2.0)],
            ..data
        };
        assert!(bad.validate().is_err());
    }
}
