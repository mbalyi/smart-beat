//! Effect-parameter automation on a lane: the chain's settings at each point along the song,
//! worked out off the audio thread, so the audio thread only switches between ready-made slot
//! lists (`Chain::update`, no allocation).

use crate::audio::chain::EffectSlot;
use crate::audio_lanes::EffectAutomation;

/// The most settings frames a lane keeps (points plus ramp steps).
const MAX_FRAMES: usize = 4_096;
/// Ramp steps between two automation points.
const RAMP_STEPS: usize = 8;

/// One automated parameter: (slot, parameter name, (tick, value) points).
type Curve<'a> = (usize, &'a str, Vec<(f64, f64)>);

/// (song seconds, the chain's slots from then on), in time order.
#[derive(Default)]
pub struct AutomationFrames {
    frames: Vec<(f64, Vec<EffectSlot>)>,
}

/// `slots` with one numeric parameter set by name; unknown names leave the slot as it is.
fn with_param(slots: &[EffectSlot], slot: usize, param: &str, value: f64) -> Vec<EffectSlot> {
    let mut out = slots.to_vec();
    let Some(target) = out.get_mut(slot) else {
        return out;
    };
    let Ok(mut json) = serde_json::to_value(&*target) else {
        return out;
    };
    let field = json.get_mut(param).filter(|v| v.is_number());
    if let Some(field) = field
        && let Some(number) = serde_json::Number::from_f64(value)
    {
        *field = serde_json::Value::Number(number);
        if let Ok(updated) = serde_json::from_value::<EffectSlot>(json) {
            *target = updated;
        }
    }
    out
}

/// The value of an automation at `tick`: linear between points, held outside them.
fn value_at(points: &[(f64, f64)], tick: f64) -> Option<f64> {
    let first = points.first()?;
    if tick <= first.0 {
        return Some(first.1);
    }
    let i = points.partition_point(|p| p.0 <= tick);
    let a = points[i - 1];
    Some(match points.get(i) {
        Some(b) if b.0 > a.0 => a.1 + (b.1 - a.1) * (tick - a.0) / (b.0 - a.0),
        _ => a.1,
    })
}

impl AutomationFrames {
    /// Frames for every automation of a lane. `seconds_at` turns score ticks into song seconds.
    pub fn build(
        slots: &[EffectSlot],
        automation: &[EffectAutomation],
        seconds_at: &dyn Fn(f64) -> f64,
    ) -> Self {
        let curves: Vec<Curve> = automation
            .iter()
            .filter(|a| !a.points.is_empty())
            .map(|a| {
                let mut points: Vec<(f64, f64)> =
                    a.points.iter().map(|p| (p.tick, p.value)).collect();
                points.sort_by(|x, y| x.0.total_cmp(&y.0));
                (a.slot, a.param.as_str(), points)
            })
            .collect();
        if curves.is_empty() {
            return Self::default();
        }
        let mut ticks: Vec<f64> = curves
            .iter()
            .flat_map(|(_, _, points)| {
                points
                    .windows(2)
                    .flat_map(|w| {
                        (0..RAMP_STEPS)
                            .map(move |k| w[0].0 + (w[1].0 - w[0].0) * k as f64 / RAMP_STEPS as f64)
                    })
                    .chain(points.last().map(|p| p.0))
            })
            .collect();
        ticks.sort_by(f64::total_cmp);
        ticks.dedup();
        ticks.truncate(MAX_FRAMES);
        let frames = ticks
            .into_iter()
            .map(|tick| {
                let slots = curves
                    .iter()
                    .fold(slots.to_vec(), |acc, (slot, param, points)| {
                        value_at(points, tick)
                            .map_or(acc.clone(), |v| with_param(&acc, *slot, param, v))
                    });
                (seconds_at(tick), slots)
            })
            .collect();
        Self { frames }
    }

    /// The frame in force at `song` seconds, with its index (none before the first point).
    pub fn at(&self, song: f64) -> Option<(usize, &[EffectSlot])> {
        let i = self.frames.partition_point(|f| f.0 <= song);
        let index = i
            .checked_sub(1)
            .or((!self.frames.is_empty()).then_some(0))?;
        self.frames.get(index).map(|f| (index, f.1.as_slice()))
    }

    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }
}
