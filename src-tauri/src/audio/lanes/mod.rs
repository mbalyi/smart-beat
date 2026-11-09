//! Audio lanes in the engine: clip voices summed per lane, then the lane's filter, channel EQ,
//! effect chain, fader and pan, sends to buses, and the buses' own chains. Everything is built
//! off the audio thread (`prepare`) and swapped in under the engine lock.

pub mod automation;
pub mod voice;

use std::collections::HashMap;
use std::sync::Arc;

use crate::audio::backing::{DecodedAudio, FilterBank, SyncMap};
use crate::audio::chain::{Chain, ChainPlayer, EffectSlot, MAX_TRACK_EFFECTS};
use crate::audio::dsp::Effect;
use crate::audio::dsp::eq::Eq;
use crate::audio::mixing::{mix_into, pan_gains};
use crate::audio_lanes::{AudioLane, AudioLanes};

pub use automation::AutomationFrames;
use voice::{ClipPlan, ClipVoice};

/// Lane input below this peak counts as silence for effect auto-bypass.
const SILENCE: f32 = 1.0e-5;
/// How long a lane is silent before its effects stop (auto-bypass), in seconds.
const BYPASS_AFTER_S: f32 = 2.0;

/// A lane's settings with its folder applied: what the mixer needs, flat.
#[derive(Debug, Clone, PartialEq)]
pub struct LaneMixParams {
    pub enabled: bool,
    pub volume: f32,
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
}

/// Effective mix settings of each non-folder lane (folder volume, mute and solo included).
pub fn effective_params(audio: &AudioLanes) -> Vec<(usize, LaneMixParams)> {
    let by_id: HashMap<&str, &AudioLane> = audio.lanes.iter().map(|l| (l.id.as_str(), l)).collect();
    audio
        .lanes
        .iter()
        .enumerate()
        .filter(|(_, l)| !l.folder)
        .map(|(i, lane)| {
            let folder = lane.parent.as_deref().and_then(|p| by_id.get(p));
            let p = &lane.params;
            let f = folder.map(|f| &f.params);
            (
                i,
                LaneMixParams {
                    enabled: p.enabled && f.is_none_or(|f| f.enabled),
                    volume: p.volume * f.map_or(1.0, |f| f.volume),
                    pan: p.pan,
                    mute: p.mute || f.is_some_and(|f| f.mute),
                    solo: p.solo || f.is_some_and(|f| f.solo),
                },
            )
        })
        .collect()
}

/// One lane as the engine plays it.
pub struct LaneBus {
    pub id: String,
    voices: Vec<ClipVoice>,
    filter: FilterBank,
    eq: Option<Eq>,
    chain: ChainPlayer,
    slots: Vec<EffectSlot>,
    automation: AutomationFrames,
    frame: Option<usize>,
    auto_bypass: bool,
    silent: usize,
    params: LaneMixParams,
    /// (bus index, level).
    sends: Vec<(usize, f32)>,
    left: Vec<f32>,
    right: Vec<f32>,
    gains: Option<(f32, f32)>,
    pub peak: f32,
}

/// A bus that lane sends feed.
pub struct BusReturn {
    chain: ChainPlayer,
    volume: f32,
    mute: bool,
    left: Vec<f32>,
    right: Vec<f32>,
}

/// Everything built for the lanes off the audio thread.
pub struct PreparedLanes {
    pub lanes: Vec<LaneBus>,
    pub buses: Vec<BusReturn>,
    pub sync: SyncMap,
    pub max_block: usize,
}

/// What `prepare` needs from the engine state.
pub struct LaneInputs<'a> {
    pub audio: &'a AudioLanes,
    /// Decoded sources by id (missing ones are skipped: the clip stays silent).
    pub sources: &'a HashMap<String, Arc<DecodedAudio>>,
    /// Reversed copies, by source id, for clips that play backwards.
    pub reversed: &'a HashMap<String, Arc<DecodedAudio>>,
    /// Song transposition in semitones (for lanes that follow it).
    pub transpose: i32,
    pub sync: SyncMap,
    pub output_rate: f32,
    pub max_block: usize,
    /// Builds an effect chain for a lane (by its index in the song's lanes) or, with `None`,
    /// for a bus (allocates; off the audio thread).
    pub build_chain: &'a dyn Fn(Option<usize>, &[EffectSlot]) -> Chain,
    /// Song seconds at a score tick (for effect automation).
    pub seconds_at: &'a dyn Fn(f64) -> f64,
}

fn lane_bus(inputs: &LaneInputs, index: usize, lane: &AudioLane, params: LaneMixParams) -> LaneBus {
    let extra_semitones = lane.params.semitones
        + if lane.follow_transposition {
            inputs.transpose
        } else {
            0
        };
    let voices = lane
        .clips
        .iter()
        .filter_map(|clip| {
            let id = &clip.active_take().source_id;
            let audio = if clip.reversed {
                inputs.reversed.get(id)
            } else {
                inputs.sources.get(id)
            }?;
            let plan = ClipPlan::from_clip(clip, extra_semitones, lane.params.cents);
            Some(ClipVoice::new(
                clip.id.clone(),
                plan,
                audio.clone(),
                inputs.output_rate,
                inputs.max_block,
            ))
        })
        .collect();
    let bus_index = |id: &str| inputs.audio.buses.iter().position(|b| b.id == id);
    LaneBus {
        id: lane.id.clone(),
        voices,
        filter: FilterBank::new(lane.params.filter, inputs.output_rate),
        eq: (!lane.params.eq.is_flat())
            .then(|| Eq::new(&lane.params.eq.bands(), inputs.output_rate)),
        chain: ChainPlayer::new(
            (inputs.build_chain)(Some(index), &lane.effects),
            inputs.output_rate,
            inputs.max_block,
        ),
        slots: lane.effects.clone(),
        automation: AutomationFrames::build(&lane.effects, &lane.automation, inputs.seconds_at),
        frame: None,
        auto_bypass: lane.auto_bypass,
        silent: 0,
        params,
        sends: lane
            .sends
            .iter()
            .filter_map(|s| Some((bus_index(&s.bus)?, s.level)))
            .collect(),
        left: vec![0.0; inputs.max_block],
        right: vec![0.0; inputs.max_block],
        gains: None,
        peak: 0.0,
    }
}

/// Builds the lanes and buses (allocates; call it off the audio thread).
pub fn prepare(inputs: &LaneInputs) -> PreparedLanes {
    let lanes = effective_params(inputs.audio)
        .into_iter()
        .map(|(i, params)| lane_bus(inputs, i, &inputs.audio.lanes[i], params))
        .collect();
    let buses = inputs
        .audio
        .buses
        .iter()
        .map(|b| BusReturn {
            chain: ChainPlayer::new(
                (inputs.build_chain)(None, &b.effects),
                inputs.output_rate,
                inputs.max_block,
            ),
            volume: b.volume,
            mute: b.mute,
            left: vec![0.0; inputs.max_block],
            right: vec![0.0; inputs.max_block],
        })
        .collect();
    PreparedLanes {
        lanes,
        buses,
        sync: inputs.sync.clone(),
        max_block: inputs.max_block,
    }
}

/// Song seconds at which the last clip of `lanes` ends, through the sync map (0 without clips).
fn end_of(lanes: &[LaneBus], sync: &SyncMap) -> f64 {
    let end = lanes
        .iter()
        .flat_map(|l| l.voices.iter().map(|v| v.plan.end))
        .fold(0.0f64, f64::max);
    if end <= 0.0 {
        return 0.0;
    }
    // The map is increasing: search the song time that reaches `end` on the timeline.
    let (mut lo, mut hi) = (-3_600.0f64, 86_400.0f64);
    for _ in 0..80 {
        let mid = 0.5 * (lo + hi);
        if sync.audio_at(mid) < end {
            lo = mid
        } else {
            hi = mid
        }
    }
    hi.max(0.0)
}

/// All lanes and buses of a song, as the engine plays them.
pub struct LaneMixer {
    lanes: Vec<LaneBus>,
    buses: Vec<BusReturn>,
    sync: SyncMap,
    times: Vec<f64>,
    output_rate: f32,
    /// Song seconds at which the last clip ends (worked out once per build).
    end: f64,
}

impl LaneMixer {
    pub fn new(prepared: PreparedLanes, output_rate: f32) -> Self {
        let end = end_of(&prepared.lanes, &prepared.sync);
        Self {
            times: vec![0.0; prepared.max_block],
            lanes: prepared.lanes,
            buses: prepared.buses,
            sync: prepared.sync,
            output_rate,
            end,
        }
    }

    /// Takes a new build, keeping running effect chains whose layout did not change (a knob
    /// turn) so edits during playback do not restart reverb tails. Returns what to drop.
    pub fn replace(&mut self, prepared: PreparedLanes) -> Vec<Box<dyn std::any::Any + Send>> {
        let mut old: Vec<Box<dyn std::any::Any + Send>> = Vec::new();
        let mut previous: HashMap<String, LaneBus> =
            self.lanes.drain(..).map(|l| (l.id.clone(), l)).collect();
        let mut lanes = prepared.lanes;
        for lane in &mut lanes {
            if let Some(mut was) = previous.remove(&lane.id) {
                if was.chain.update(&lane.slots, MAX_TRACK_EFFECTS) {
                    std::mem::swap(&mut lane.chain, &mut was.chain);
                }
                // An unchanged clip keeps its running voice (its stretcher's state): a fader move
                // or another clip's edit does not restart what is playing.
                for voice in &mut lane.voices {
                    if let Some(old) = was.voices.iter_mut().find(|v| v.same_as(voice)) {
                        std::mem::swap(voice, old);
                    }
                }
                lane.gains = was.gains;
                old.push(Box::new(was));
            }
        }
        old.extend(
            previous
                .into_values()
                .map(|l| Box::new(l) as Box<dyn std::any::Any + Send>),
        );
        old.extend(
            self.buses
                .drain(..)
                .map(|b| Box::new(b) as Box<dyn std::any::Any + Send>),
        );
        self.lanes = lanes;
        self.buses = prepared.buses;
        self.sync = prepared.sync;
        self.end = end_of(&self.lanes, &self.sync);
        if self.times.len() < prepared.max_block {
            self.times = vec![0.0; prepared.max_block];
        }
        old
    }

    /// Song seconds at which the last clip ends (through the sync map; 0 without clips).
    pub fn end_song_seconds(&self) -> f64 {
        self.end
    }

    /// A lane is soloed (it takes part in the engine's solo logic).
    pub fn any_solo(&self) -> bool {
        self.lanes.iter().any(|l| l.params.enabled && l.params.solo)
    }

    pub fn reset(&mut self) {
        for lane in &mut self.lanes {
            lane.voices.iter_mut().for_each(ClipVoice::reset);
            lane.filter.reset();
            if let Some(eq) = &mut lane.eq {
                eq.reset();
            }
            lane.chain.reset();
            lane.gains = None;
            lane.frame = None;
        }
        self.buses.iter_mut().for_each(|b| b.chain.reset());
    }

    /// Peak level of each lane since the last call, in lane order (folders left out).
    pub fn take_peaks(&mut self) -> Vec<(String, f32)> {
        self.lanes
            .iter_mut()
            .map(|l| (l.id.clone(), std::mem::take(&mut l.peak)))
            .collect()
    }

    /// Adds the lanes for the song span starting at `song_pos` (seconds, advancing `rate` song
    /// seconds per output second). `audible` is false when the practice focus mutes the lanes;
    /// `others_solo` when a track elsewhere is soloed.
    pub fn render(
        &mut self,
        song_pos: f64,
        rate: f64,
        playing: bool,
        audible: bool,
        others_solo: bool,
        out: (&mut [f32], &mut [f32]),
    ) {
        let n = out.0.len().min(self.times.len());
        if n == 0 {
            return;
        }
        let per_sample = rate / self.output_rate as f64;
        for (i, t) in self.times[..n].iter_mut().enumerate() {
            *t = self.sync.audio_at(song_pos + i as f64 * per_sample);
        }
        let any_solo = others_solo || self.any_solo();
        for bus in &mut self.buses {
            bus.left[..n].fill(0.0);
            bus.right[..n].fill(0.0);
        }
        let bypass_blocks = ((BYPASS_AFTER_S * self.output_rate) as usize / n).max(1);
        for lane in &mut self.lanes {
            let heard = playing
                && audible
                && lane.params.enabled
                && !lane.params.mute
                && (!any_solo || lane.params.solo);
            lane.render(
                &self.times[..n],
                song_pos,
                playing,
                heard,
                bypass_blocks,
                &mut self.buses,
                (&mut *out.0, &mut *out.1),
            );
        }
        for bus in &mut self.buses {
            let (l, r) = (&mut bus.left[..n], &mut bus.right[..n]);
            bus.chain.begin_render(n);
            bus.chain.process(l, r);
            let g = if bus.mute { 0.0 } else { bus.volume };
            mix_into(
                (&bus.left[..n], &bus.right[..n]),
                (&mut out.0[..n], &mut out.1[..n]),
                (g, g),
                (g, g),
            );
        }
    }
}

impl LaneBus {
    #[allow(clippy::too_many_arguments)]
    fn render(
        &mut self,
        times: &[f64],
        song_pos: f64,
        playing: bool,
        heard: bool,
        bypass_blocks: usize,
        buses: &mut [BusReturn],
        out: (&mut [f32], &mut [f32]),
    ) {
        let n = times.len();
        let (l, r) = (&mut self.left[..n], &mut self.right[..n]);
        l.fill(0.0);
        r.fill(0.0);
        if playing && self.params.enabled {
            for voice in &mut self.voices {
                voice.render(times, (&mut *l, &mut *r));
            }
        }
        let input_peak = l.iter().chain(r.iter()).fold(0.0f32, |a, s| a.max(s.abs()));
        self.silent = if input_peak < SILENCE {
            self.silent.saturating_add(1)
        } else {
            0
        };
        self.filter.process(l, r);
        if let Some(eq) = &mut self.eq {
            eq.process(l, r);
        }
        if let Some((frame, slots)) = self.automation.at(song_pos)
            && self.frame != Some(frame)
        {
            self.chain.update(slots, MAX_TRACK_EFFECTS);
            self.frame = Some(frame);
        }
        let bypassed = self.auto_bypass && self.silent > bypass_blocks;
        if !bypassed {
            self.chain.begin_render(n);
            self.chain.process(l, r);
        }
        let target = pan_gains(
            if heard { self.params.volume } else { 0.0 },
            self.params.pan,
        );
        let from = self.gains.unwrap_or(target);
        for &(bus, level) in &self.sends {
            if let Some(bus) = buses.get_mut(bus) {
                let send = (from.0 * level, from.1 * level);
                let to = (target.0 * level, target.1 * level);
                mix_into(
                    (&self.left[..n], &self.right[..n]),
                    (&mut bus.left[..n], &mut bus.right[..n]),
                    send,
                    to,
                );
            }
        }
        let peak = mix_into(
            (&self.left[..n], &self.right[..n]),
            (&mut out.0[..n], &mut out.1[..n]),
            from,
            target,
        );
        self.gains = Some(target);
        self.peak = self.peak.max(peak);
    }
}

#[cfg(test)]
mod tests;
