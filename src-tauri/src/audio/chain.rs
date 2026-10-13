//! Effect chains: the ordered blocks of a track (up to [`MAX_TRACK_EFFECTS`])
//! or of the master bus (up to [`MAX_MASTER_EFFECTS`]), as data that presets
//! and score files store, and as the running processors built from it.
//!
//! A new chain never replaces the running one abruptly: [`ChainPlayer`]
//! crossfades from the old to the new one, so switching an effect on or off or
//! turning a knob does not click.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::dsp::amp_sim::{AmpSim, AmpSimParams};
use super::dsp::compressor::{Compressor, CompressorParams};
use super::dsp::convolver::{Convolver, IrSpectrum};
use super::dsp::delay::{Delay, DelayParams};
use super::dsp::drive::{Drive, DriveParams};
use super::dsp::eq::{Band, Eq};
use super::dsp::gate::{Gate, GateParams};
use super::dsp::limiter::{Limiter, LimiterParams};
use super::dsp::modulation::{Chorus, ChorusParams, Phaser, PhaserParams, Tremolo, TremoloParams};
use super::dsp::resample::StreamResampler;
use super::dsp::reverb::{Reverb, ReverbParams};
use super::dsp::{Effect, db_to_gain, flush_denormal};
use super::plugin::{PluginPool, PluginSpec};

pub const MAX_TRACK_EFFECTS: usize = 6;
pub const MAX_MASTER_EFFECTS: usize = 3;
/// Crossfade between an old and a new chain.
const CROSSFADE_MS: f32 = 20.0;

/// One block of a chain, as stored in presets and files.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EffectConfig {
    Gate(GateParams),
    Compressor(CompressorParams),
    Eq {
        bands: Vec<Band>,
    },
    Drive(DriveParams),
    /// The built-in amp (no capture file needed).
    AmpSim(AmpSimParams),
    Chorus(ChorusParams),
    Phaser(PhaserParams),
    Tremolo(TremoloParams),
    Delay(DelayParams),
    Reverb(ReverbParams),
    /// Lookahead brickwall limiter (mastering, #39).
    Limiter(LimiterParams),
    /// A Neural Amp Modeler capture from the user's library (amp or pedal).
    #[serde(rename_all = "camelCase")]
    Amp {
        /// Library id of the `.nam` file.
        model: String,
        #[serde(default)]
        input_db: f32,
        #[serde(default)]
        output_db: f32,
        /// Brings the capture to a common loudness (when the file records it),
        /// so swapping amps does not jump in level.
        #[serde(default)]
        match_loudness: bool,
    },
    /// A cabinet impulse response from the user's library (or a built-in one).
    Cab {
        /// Library id of the IR (`builtin:<name>` for the generated ones).
        ir: String,
    },
    /// A third-party plugin (VST3 or CLAP) running in the out-of-process
    /// helper (#80). `state` is the plugin's own preset bytes (base64).
    #[serde(rename_all = "camelCase")]
    Plugin {
        format: super::plugin::PluginFormat,
        /// Bundle path, as listed by the plugin scan.
        path: String,
        /// Display name, as listed by the scan (the file stem when unknown).
        #[serde(default)]
        name: String,
        /// The plugin's preset bytes (base64, empty for the default preset).
        #[serde(default)]
        state: String,
    },
}

impl EffectConfig {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Gate(_) => "gate",
            Self::Compressor(_) => "compressor",
            Self::Eq { .. } => "eq",
            Self::Drive(_) => "drive",
            Self::AmpSim(_) => "ampSim",
            Self::Chorus(_) => "chorus",
            Self::Phaser(_) => "phaser",
            Self::Tremolo(_) => "tremolo",
            Self::Delay(_) => "delay",
            Self::Reverb(_) => "reverb",
            Self::Limiter(_) => "limiter",
            Self::Amp { .. } => "amp",
            Self::Cab { .. } => "cab",
            Self::Plugin { .. } => "plugin",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectSlot {
    pub enabled: bool,
    #[serde(flatten)]
    pub effect: EffectConfig,
}

/// Loads the assets that amp and cab blocks refer to. The engine passes the
/// user library; tests pass a map.
pub trait AssetSource {
    fn impulse_response(&self, id: &str) -> Option<Arc<IrSpectrum>>;
    fn amp_model(&self, id: &str) -> Option<Arc<nam_rs::NamModel>>;
}

/// No assets: amp and cab blocks are skipped.
pub struct NoAssets;

impl AssetSource for NoAssets {
    fn impulse_response(&self, _: &str) -> Option<Arc<IrSpectrum>> {
        None
    }
    fn amp_model(&self, _: &str) -> Option<Arc<nam_rs::NamModel>> {
        None
    }
}

/// Loudness (dBFS RMS) that "match loudness" brings every capture to, the
/// level the Neural Amp Modeler plugin normalises to.
const LOUDNESS_TARGET_DB: f32 = -18.0;
/// Corner of the high-pass after the model that removes any DC offset
/// (the model's own output is not guaranteed to be centred).
const DC_BLOCK_HZ: f32 = 5.0;
/// Silence in front of the converted signal: covers the delay of the two
/// converters so the block that is returned never runs dry.
const BRIDGE_PREFILL: usize = 32;

/// One-pole DC blocker.
struct DcBlocker {
    coefficient: f32,
    last_in: f32,
    last_out: f32,
}

impl DcBlocker {
    fn new(sample_rate: f32) -> Self {
        Self {
            coefficient: 1.0 - std::f32::consts::TAU * DC_BLOCK_HZ / sample_rate,
            last_in: 0.0,
            last_out: 0.0,
        }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let y = flush_denormal(x - self.last_in + self.coefficient * self.last_out);
        self.last_in = x;
        self.last_out = y;
        y
    }

    fn reset(&mut self) {
        self.last_in = 0.0;
        self.last_out = 0.0;
    }
}

/// Runs a model at its own sample rate inside a chain at another rate:
/// converts the block down (or up) to the model's rate, runs the model and
/// converts the result back.
struct RateBridge {
    to_model: StreamResampler,
    from_model: StreamResampler,
    model_block: Vec<f32>,
    back_block: Vec<f32>,
    /// Converted output waiting to be handed out in blocks of the caller's size.
    pending: Vec<f32>,
}

impl RateBridge {
    fn new(chain_rate: f32, model_rate: f32, max_block: usize) -> Self {
        let model_len = StreamResampler::max_output(chain_rate, model_rate, max_block);
        let back_len = StreamResampler::max_output(model_rate, chain_rate, model_len);
        let mut pending = Vec::with_capacity(max_block * 2 + BRIDGE_PREFILL + back_len);
        pending.resize(BRIDGE_PREFILL, 0.0);
        Self {
            to_model: StreamResampler::new(chain_rate, model_rate, max_block),
            from_model: StreamResampler::new(model_rate, chain_rate, model_len),
            model_block: vec![0.0; model_len],
            back_block: vec![0.0; back_len],
            pending,
        }
    }

    fn run(&mut self, model: &mut nam_rs::Model, block: &mut [f32]) {
        let n = self.to_model.process(block, &mut self.model_block);
        model.process_buffer(&mut self.model_block[..n]);
        let k = self
            .from_model
            .process(&self.model_block[..n], &mut self.back_block);
        self.pending.extend_from_slice(&self.back_block[..k]);
        let have = self.pending.len().min(block.len());
        block[..have].copy_from_slice(&self.pending[..have]);
        block[have..].fill(0.0);
        self.pending.drain(..have);
    }

    fn reset(&mut self) {
        self.to_model.reset();
        self.from_model.reset();
        self.pending.clear();
        self.pending.resize(BRIDGE_PREFILL, 0.0);
    }
}

/// A NAM capture run on the mid (mono) signal, the way amps are recorded.
struct Amp {
    model: nam_rs::Model,
    /// Library id of the capture (a knob turn keeps it, another capture rebuilds).
    id: String,
    input: f32,
    output: f32,
    /// The capture's loudness (dBFS RMS) when the file records it.
    loudness_db: Option<f32>,
    /// Gain that brings the capture to the reference loudness (1 when off).
    trim: f32,
    bridge: Option<RateBridge>,
    dc: DcBlocker,
    mono: Vec<f32>,
}

impl Amp {
    fn trim_for(loudness_db: Option<f32>, match_loudness: bool) -> f32 {
        match (match_loudness, loudness_db) {
            (true, Some(db)) if db.is_finite() => {
                db_to_gain((LOUDNESS_TARGET_DB - db).clamp(-24.0, 24.0))
            }
            _ => 1.0,
        }
    }
}

impl Effect for Amp {
    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        let step = self.mono.len();
        for (l, r) in left.chunks_mut(step).zip(right.chunks_mut(step)) {
            let mono = &mut self.mono[..l.len()];
            for ((m, a), b) in mono.iter_mut().zip(l.iter()).zip(r.iter()) {
                *m = 0.5 * (a + b) * self.input;
            }
            match &mut self.bridge {
                None => self.model.process_buffer(mono),
                Some(bridge) => bridge.run(&mut self.model, mono),
            }
            let gain = self.output * self.trim;
            for ((m, a), b) in mono.iter().zip(l.iter_mut()).zip(r.iter_mut()) {
                let y = self.dc.process(*m) * gain;
                let y = if y.is_finite() {
                    y.clamp(-4.0, 4.0)
                } else {
                    // A broken model must not poison the filter state either.
                    self.dc.reset();
                    0.0
                };
                *a = y;
                *b = y;
            }
        }
    }

    fn reset(&mut self) {
        self.model.reset();
        self.dc.reset();
        if let Some(bridge) = &mut self.bridge {
            bridge.reset();
        }
    }

    fn update(&mut self, config: &EffectConfig) -> bool {
        let EffectConfig::Amp {
            model,
            input_db,
            output_db,
            match_loudness,
        } = config
        else {
            return false;
        };
        if *model != self.id {
            return false;
        }
        self.input = db_to_gain(input_db.clamp(-24.0, 24.0));
        self.output = db_to_gain(output_db.clamp(-24.0, 24.0));
        self.trim = Self::trim_for(self.loudness_db, *match_loudness);
        true
    }
}

/// What the UI shows for a block whose asset is gone (removed from the
/// library, or the song came from another computer).
fn missing_asset(what: &str, id: &str) -> String {
    let short: String = id.chars().take(8).collect();
    format!(
        "This {what} is not in your sound library (it was removed, or the song came from another computer; id {short}). Choose another one."
    )
}

/// Models run at the rate they were captured at; anything else is converted.
const MODEL_RATES: std::ops::RangeInclusive<f32> = 8_000.0..=384_000.0;

fn build_amp(
    id: &str,
    nam: &nam_rs::NamModel,
    (input_db, output_db, match_loudness): (f32, f32, bool),
    sample_rate: f32,
    max_block: usize,
) -> Result<Box<dyn Effect>, String> {
    let expected = nam.expected_sample_rate() as f32;
    if !MODEL_RATES.contains(&expected) || !MODEL_RATES.contains(&sample_rate) {
        return Err(format!(
            "The amp capture asks for {expected} Hz, which the audio output ({sample_rate} Hz) cannot be converted to"
        ));
    }
    let model =
        nam_rs::Model::from_nam(nam).map_err(|e| format!("The amp capture cannot run: {e}"))?;
    let bridge = ((expected - sample_rate).abs() > 1.0)
        .then(|| RateBridge::new(sample_rate, expected, max_block.max(1)));
    let loudness_db = nam.loudness();
    Ok(Box::new(Amp {
        model,
        id: id.to_string(),
        input: db_to_gain(input_db.clamp(-24.0, 24.0)),
        output: db_to_gain(output_db.clamp(-24.0, 24.0)),
        loudness_db,
        trim: Amp::trim_for(loudness_db, match_loudness),
        bridge,
        dc: DcBlocker::new(sample_rate),
        mono: vec![0.0; max_block.max(1)],
    }))
}

/// A third-party plugin block: hands stereo blocks to the out-of-process
/// worker and plays the latest finished output. A missing answer passes
/// audio through dry — the audio thread never waits, allocates, or fails.
struct PluginEffect {
    worker: Arc<super::plugin::PluginWorker>,
    format: super::plugin::PluginFormat,
    path: String,
    state: Vec<u8>,
    seen: u64,
}

impl Effect for PluginEffect {
    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        self.worker.push(left, right);
        if let Some(seq) = self.worker.take_into(self.seen, left, right) {
            self.seen = seq;
        }
        // Else dry: the helper is behind, recovering, or gone.
    }

    fn reset(&mut self) {
        // Drop anything the helper finished before the seek: only newer
        // blocks count from here.
        if let Some(seq) = self.worker.in_seq() {
            self.seen = seq;
        }
    }

    fn update(&mut self, config: &EffectConfig) -> bool {
        let EffectConfig::Plugin {
            format,
            path,
            state,
            ..
        } = config
        else {
            return false;
        };
        if *format != self.format || *path != self.path {
            return false;
        }
        let Some(state) = decode_plugin_state(state) else {
            return false;
        };
        // The same plugin keeps its running worker; a new preset is applied
        // to it (off the audio thread — `update` never runs on it).
        match self.worker.apply_state(&state) {
            Ok(()) => {
                self.state = state;
                true
            }
            Err(_) => false,
        }
    }

    fn latency_samples(&self) -> u32 {
        self.worker.latency_samples() + super::engine::BLOCK as u32
    }
}

/// Decodes a plugin preset from its base64 form in a chain. `None` (used with
/// `?` in `update`) means the stored text is corrupt: rebuild instead.
fn decode_plugin_state(state: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    if state.is_empty() {
        return Some(Vec::new());
    }
    base64::engine::general_purpose::STANDARD.decode(state).ok()
}

/// Why a block does not run (shown next to it in the UI).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockProblem {
    pub index: usize,
    pub message: String,
}

/// The running processors of a chain.
pub struct Chain {
    blocks: Vec<Box<dyn Effect>>,
    /// The configuration each block was built from (same order as `blocks`).
    layout: Vec<EffectConfig>,
    /// The slot (position on the pedalboard) of each block.
    slots: Vec<usize>,
    /// Gain reduction of each slot's compressor or limiter since the meters
    /// were last read (dB, ≥ 0).
    reduction: [f32; MAX_TRACK_EFFECTS],
    pub problems: Vec<BlockProblem>,
}

impl Chain {
    pub fn empty() -> Self {
        Self {
            blocks: Vec::new(),
            layout: Vec::new(),
            slots: Vec::new(),
            reduction: [0.0; MAX_TRACK_EFFECTS],
            problems: Vec::new(),
        }
    }

    /// A chain of ready-made processors, for tests and custom blocks.
    #[doc(hidden)]
    pub fn from_effects(blocks: Vec<Box<dyn Effect>>) -> Self {
        let count = blocks.len();
        Self {
            blocks,
            layout: vec![EffectConfig::Gate(GateParams::default()); count],
            slots: (0..count).collect(),
            reduction: [0.0; MAX_TRACK_EFFECTS],
            problems: Vec::new(),
        }
    }

    /// Gain reduction of each slot (dB) since the last call, then starts over.
    pub fn take_reduction(&mut self) -> [f32; MAX_TRACK_EFFECTS] {
        std::mem::take(&mut self.reduction)
    }

    /// Applies new settings to the running blocks when only parameters changed
    /// (a knob turn): no rebuild, no crossfade, no allocation. Returns false
    /// when the chain must be rebuilt instead (blocks added, removed, moved,
    /// switched, or a different capture or impulse response).
    pub fn update(&mut self, slots: &[EffectSlot], limit: usize) -> bool {
        if !self.problems.is_empty() {
            return false;
        }
        let enabled = slots.iter().take(limit).filter(|s| s.enabled);
        if enabled.clone().count() != self.layout.len() {
            return false;
        }
        let same_kinds = enabled
            .clone()
            .zip(&self.layout)
            .all(|(slot, old)| slot.effect.kind() == old.kind());
        if !same_kinds {
            return false;
        }
        for ((slot, old), block) in enabled.zip(self.layout.iter_mut()).zip(&mut self.blocks) {
            if slot.effect == *old {
                continue;
            }
            if !block.update(&slot.effect) {
                return false;
            }
            old.clone_from(&slot.effect);
        }
        true
    }

    /// Builds the enabled blocks (at most `limit`). Missing or unusable assets
    /// are reported, never fatal. Allocates: call it off the audio thread.
    pub fn build(
        slots: &[EffectSlot],
        limit: usize,
        sample_rate: f32,
        max_block: usize,
        assets: &dyn AssetSource,
        plugins: &PluginPool,
    ) -> Self {
        let mut blocks: Vec<Box<dyn Effect>> = Vec::new();
        let mut layout = Vec::new();
        let mut slot_indexes = Vec::new();
        let mut problems = Vec::new();
        for (index, slot) in slots.iter().take(limit).enumerate() {
            if !slot.enabled {
                continue;
            }
            let block: Result<Box<dyn Effect>, String> = match &slot.effect {
                EffectConfig::Gate(p) => Ok(Box::new(Gate::new(*p, sample_rate))),
                EffectConfig::Compressor(p) => Ok(Box::new(Compressor::new(*p, sample_rate))),
                EffectConfig::Eq { bands } => Ok(Box::new(Eq::new(bands, sample_rate))),
                EffectConfig::Drive(p) => Ok(Box::new(Drive::new(*p, sample_rate))),
                EffectConfig::AmpSim(p) => Ok(Box::new(AmpSim::new(*p, sample_rate))),
                EffectConfig::Chorus(p) => Ok(Box::new(Chorus::new(*p, sample_rate))),
                EffectConfig::Phaser(p) => Ok(Box::new(Phaser::new(*p, sample_rate))),
                EffectConfig::Tremolo(p) => Ok(Box::new(Tremolo::new(*p, sample_rate))),
                EffectConfig::Delay(p) => Ok(Box::new(Delay::new(*p, sample_rate))),
                EffectConfig::Reverb(p) => Ok(Box::new(Reverb::new(*p, sample_rate))),
                EffectConfig::Limiter(p) => Ok(Box::new(Limiter::new(*p, sample_rate))),
                EffectConfig::Cab { ir } => assets
                    .impulse_response(ir)
                    .map(|spectrum| Box::new(Convolver::new(spectrum)) as Box<dyn Effect>)
                    .ok_or_else(|| missing_asset("cabinet", ir)),
                EffectConfig::Amp {
                    model,
                    input_db,
                    output_db,
                    match_loudness,
                } => match assets.amp_model(model) {
                    None => Err(missing_asset("amp capture", model)),
                    Some(nam) => build_amp(
                        model,
                        &nam,
                        (*input_db, *output_db, *match_loudness),
                        sample_rate,
                        max_block,
                    ),
                },
                EffectConfig::Plugin {
                    format,
                    path,
                    state,
                    ..
                } => match decode_plugin_state(state) {
                    None => Err("This plugin's saved settings are corrupt. Open its editor and save them again.".to_string()),
                    Some(state) => {
                        let spec = PluginSpec {
                            format: *format,
                            path: path.clone(),
                            state,
                        };
                        match plugins.get_or_load(&spec, sample_rate) {
                            Ok(worker) => Ok(Box::new(PluginEffect {
                                worker,
                                format: *format,
                                path: path.clone(),
                                state: spec.state,
                                seen: 0,
                            }) as Box<dyn Effect>),
                            Err(message) => Err(message),
                        }
                    }
                },
            };
            match block {
                Ok(block) => {
                    blocks.push(block);
                    layout.push(slot.effect.clone());
                    slot_indexes.push(index);
                }
                Err(message) => problems.push(BlockProblem { index, message }),
            }
        }
        Self {
            blocks,
            layout,
            slots: slot_indexes,
            reduction: [0.0; MAX_TRACK_EFFECTS],
            problems,
        }
    }

    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        for (block, &slot) in self.blocks.iter_mut().zip(&self.slots) {
            block.process(left, right);
            if let (Some(db), Some(held)) = (block.meter_db(), self.reduction.get_mut(slot)) {
                *held = held.max(db);
            }
        }
        // Last line of defence: a broken block must never send NaN or huge
        // values to the speakers.
        for s in left.iter_mut().chain(right.iter_mut()) {
            if !s.is_finite() {
                *s = 0.0;
            }
        }
    }

    pub fn reset(&mut self) {
        for block in &mut self.blocks {
            block.reset();
        }
    }

    pub fn is_empty(&self) -> bool {
        self.blocks.is_empty()
    }

    /// The added latency of the running blocks in samples (plugin blocks
    /// report their own latency plus the handover block; built-ins add none).
    pub fn latency_samples(&self) -> u32 {
        self.blocks.iter().map(|b| b.latency_samples()).sum()
    }
}

/// Runs a chain and crossfades to a replacement.
pub struct ChainPlayer {
    current: Chain,
    previous: Option<Chain>,
    fade_pos: usize,
    fade_len: usize,
    scratch: [Vec<f32>; 2],
}

impl ChainPlayer {
    pub fn new(chain: Chain, sample_rate: f32, max_block: usize) -> Self {
        Self {
            current: chain,
            previous: None,
            fade_pos: 0,
            fade_len: ((CROSSFADE_MS * 0.001 * sample_rate) as usize).max(1),
            scratch: [vec![0.0; max_block], vec![0.0; max_block]],
        }
    }

    /// Starts a crossfade to `chain`; returns the chain that can now be dropped
    /// (off the audio thread, if possible).
    pub fn replace(&mut self, chain: Chain) -> Option<Chain> {
        let old = std::mem::replace(&mut self.current, chain);
        self.fade_pos = 0;
        self.previous.replace(old)
    }

    pub fn current(&self) -> &Chain {
        &self.current
    }

    /// Switches every block off: the signal passes through untouched. Used
    /// when a block panicked, so the song can go on without it.
    pub fn bypass(&mut self) {
        self.current = Chain::empty();
        self.previous = None;
    }

    /// See [`Chain::take_reduction`] (of the chain that is playing).
    pub fn take_reduction(&mut self) -> [f32; MAX_TRACK_EFFECTS] {
        self.current.take_reduction()
    }

    /// See [`Chain::update`]; never during a crossfade.
    pub fn update(&mut self, slots: &[EffectSlot], limit: usize) -> bool {
        self.previous.is_none() && self.current.update(slots, limit)
    }

    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        let n = left.len();
        let Some(previous) = self
            .previous
            .as_mut()
            .filter(|_| n <= self.scratch[0].len())
        else {
            self.current.process(left, right);
            return;
        };
        let [old_l, old_r] = &mut self.scratch;
        old_l[..n].copy_from_slice(left);
        old_r[..n].copy_from_slice(right);
        previous.process(&mut old_l[..n], &mut old_r[..n]);
        self.current.process(left, right);
        for i in 0..n {
            let t = ((self.fade_pos + i) as f32 / self.fade_len as f32).min(1.0);
            left[i] = left[i] * t + old_l[i] * (1.0 - t);
            right[i] = right[i] * t + old_r[i] * (1.0 - t);
        }
        self.fade_pos += n;
        if self.fade_pos >= self.fade_len {
            self.previous = None;
        }
    }

    pub fn reset(&mut self) {
        self.current.reset();
        self.previous = None;
    }
}

#[cfg(test)]
mod tests {
    use super::super::dsp::test_signals::*;
    use super::*;

    fn slot(effect: EffectConfig) -> EffectSlot {
        EffectSlot {
            enabled: true,
            effect,
        }
    }

    #[test]
    fn empty_chain_is_bit_exact_bypass() {
        let mut chain = Chain::build(
            &[],
            MAX_TRACK_EFFECTS,
            RATE,
            64,
            &NoAssets,
            &crate::audio::plugin::PluginPool::default(),
        );
        let input = sine(440.0, 0.5, 64);
        let (mut l, mut r) = (input.clone(), input.clone());
        chain.process(&mut l, &mut r);
        assert_eq!(l, input);
        assert_eq!(r, input);
    }

    #[test]
    fn disabled_blocks_are_bypassed() {
        let slots = [EffectSlot {
            enabled: false,
            effect: EffectConfig::Drive(DriveParams {
                drive: 1.0,
                ..Default::default()
            }),
        }];
        let chain = Chain::build(
            &slots,
            MAX_TRACK_EFFECTS,
            RATE,
            64,
            &NoAssets,
            &crate::audio::plugin::PluginPool::default(),
        );
        assert!(chain.is_empty());
    }

    /// The chain plays the slots in the order the pedalboard shows (#128): a
    /// reorder is a new order of the same blocks, so the engine must follow it.
    #[test]
    fn the_chain_follows_the_slot_order_after_a_reorder() {
        let drive = slot(EffectConfig::Drive(DriveParams {
            drive: 0.8,
            ..Default::default()
        }));
        let gate = slot(EffectConfig::Gate(GateParams::default()));
        let in_order = Chain::build(
            &[drive.clone(), gate.clone()],
            MAX_TRACK_EFFECTS,
            RATE,
            64,
            &NoAssets,
        );
        assert_eq!(
            in_order.layout,
            vec![drive.effect.clone(), gate.effect.clone()]
        );
        let reordered = Chain::build(
            &[gate.clone(), drive.clone()],
            MAX_TRACK_EFFECTS,
            RATE,
            64,
            &NoAssets,
        );
        assert_eq!(reordered.layout, vec![gate.effect, drive.effect]);
        // The meter of each block still points at the slot it came from.
        assert_eq!(reordered.slots, vec![0, 1]);
    }

    #[test]
    fn keeps_at_most_the_limit_and_reports_missing_assets() {
        let slots: Vec<EffectSlot> = (0..5)
            .map(|i| {
                slot(EffectConfig::Cab {
                    ir: format!("missing-{i}"),
                })
            })
            .collect();
        let chain = Chain::build(
            &slots,
            MAX_MASTER_EFFECTS,
            RATE,
            64,
            &NoAssets,
            &crate::audio::plugin::PluginPool::default(),
        );
        assert_eq!(chain.problems.len(), 3);
        assert!(
            chain.problems[0]
                .message
                .contains("not in your sound library")
        );
        assert_eq!(chain.problems[2].index, 2);
    }

    /// Hands out one tiny amp capture under the id `amp`.
    struct OneAmp(Arc<nam_rs::NamModel>);

    impl OneAmp {
        fn new(sample_rate: Option<f64>, loudness: Option<f32>) -> Self {
            let json = super::super::test_fixtures::tiny_nam(sample_rate, loudness);
            Self(Arc::new(nam_rs::NamModel::from_json_str(&json).unwrap()))
        }
    }

    impl AssetSource for OneAmp {
        fn impulse_response(&self, _: &str) -> Option<Arc<IrSpectrum>> {
            None
        }
        fn amp_model(&self, id: &str) -> Option<Arc<nam_rs::NamModel>> {
            (id == "amp").then(|| self.0.clone())
        }
    }

    fn amp_slot(input_db: f32, output_db: f32, match_loudness: bool) -> EffectSlot {
        slot(EffectConfig::Amp {
            model: "amp".into(),
            input_db,
            output_db,
            match_loudness,
        })
    }

    /// Runs a signal through a chain in blocks of 64, like the engine.
    fn run(chain: &mut Chain, input: &[f32]) -> Vec<f32> {
        let mut out = Vec::new();
        for block in input.chunks(64) {
            let (mut l, mut r) = (block.to_vec(), block.to_vec());
            chain.process(&mut l, &mut r);
            out.extend(l);
        }
        out
    }

    fn build_one(assets: &dyn AssetSource, slots: &[EffectSlot]) -> Chain {
        Chain::build(
            slots,
            MAX_TRACK_EFFECTS,
            RATE,
            64,
            assets,
            &crate::audio::plugin::PluginPool::default(),
        )
    }

    #[test]
    fn an_amp_capture_makes_sound_and_stays_finite() {
        let assets = OneAmp::new(None, None);
        let mut chain = build_one(&assets, &[amp_slot(0.0, 0.0, false)]);
        assert!(chain.problems.is_empty(), "{:?}", chain.problems);
        let out = run(&mut chain, &sine(220.0, 0.2, 4_800));
        assert!(all_finite(&out));
        assert!(rms(&out[480..]) > 0.01, "silent: {}", rms(&out));
    }

    /// The capture's own rate and the chain's rate may differ (a 44.1 kHz
    /// capture on a 48 kHz output): the sound must be the same, not an error.
    #[test]
    fn a_capture_at_another_sample_rate_sounds_the_same() {
        let direct = OneAmp::new(Some(48_000.0), None);
        let other = OneAmp::new(Some(44_100.0), None);
        let input = sine(330.0, 0.15, 9_600);
        let mut chain = build_one(&direct, &[amp_slot(0.0, -12.0, false)]);
        let reference = run(&mut chain, &input);
        let mut chain = build_one(&other, &[amp_slot(0.0, -12.0, false)]);
        assert!(chain.problems.is_empty(), "{:?}", chain.problems);
        let converted = run(&mut chain, &input);
        assert!(all_finite(&converted));
        // The model has no memory, so the converted signal is the reference
        // shifted by the delay of the two converters: find the best shift.
        let (best_error, best_lag) = (0..80usize)
            .map(|lag| {
                let n = reference.len() - 1_000;
                let error: f32 = (500..n)
                    .map(|i| (converted[i] - reference[i - lag.min(i)]).abs())
                    .sum::<f32>()
                    / (n - 500) as f32;
                (error, lag)
            })
            .fold((f32::MAX, 0), |a, b| if b.0 < a.0 { b } else { a });
        let level = rms(&reference[500..]);
        assert!(level > 0.005, "reference is silent");
        assert!(
            best_error < level * 0.25,
            "error {best_error} (lag {best_lag}) against level {level}"
        );
        assert!(best_lag < 60, "lag {best_lag}");
        // And a 96 kHz capture on a 48 kHz chain works as well.
        let high = OneAmp::new(Some(96_000.0), None);
        let mut chain = build_one(&high, &[amp_slot(0.0, 0.0, false)]);
        assert!(chain.problems.is_empty());
        assert!(all_finite(&run(&mut chain, &input)));
    }

    #[test]
    fn a_capture_asking_for_an_impossible_rate_is_reported_not_fatal() {
        let assets = OneAmp::new(Some(1_000.0), None);
        let chain = build_one(&assets, &[amp_slot(0.0, 0.0, false)]);
        assert_eq!(chain.problems.len(), 1);
        assert!(chain.is_empty());
        assert!(chain.problems[0].message.contains("1000"));
    }

    #[test]
    fn turning_an_amp_knob_updates_in_place_but_another_capture_rebuilds() {
        let assets = OneAmp::new(None, None);
        let mut slots = vec![amp_slot(0.0, 0.0, false)];
        let mut chain = build_one(&assets, &slots);
        let quiet = run(&mut chain, &sine(220.0, 0.2, 2_400));
        slots[0] = amp_slot(6.0, -6.0, false);
        assert!(chain.update(&slots, MAX_TRACK_EFFECTS), "knob turn");
        slots[0] = amp_slot(6.0, -6.0, true);
        assert!(chain.update(&slots, MAX_TRACK_EFFECTS), "loudness switch");
        let again = run(&mut chain, &sine(220.0, 0.2, 2_400));
        assert!(all_finite(&again) && !quiet.is_empty());
        slots[0] = slot(EffectConfig::Amp {
            model: "another".into(),
            input_db: 0.0,
            output_db: 0.0,
            match_loudness: false,
        });
        assert!(!chain.update(&slots, MAX_TRACK_EFFECTS), "another capture");
    }

    #[test]
    fn matching_the_loudness_brings_quiet_and_loud_captures_together() {
        // A capture recorded 12 dB below the reference is lifted by 12 dB.
        assert!((Amp::trim_for(Some(-30.0), true) - db_to_gain(12.0)).abs() < 1e-4);
        assert!((Amp::trim_for(Some(-10.0), true) - db_to_gain(-8.0)).abs() < 1e-4);
        // Off, unknown or nonsense: untouched.
        assert_eq!(Amp::trim_for(Some(-30.0), false), 1.0);
        assert_eq!(Amp::trim_for(None, true), 1.0);
        assert_eq!(Amp::trim_for(Some(f32::NAN), true), 1.0);
        // Never more than ±24 dB.
        assert!((Amp::trim_for(Some(-90.0), true) - db_to_gain(24.0)).abs() < 1e-3);
        // End to end: the louder the file says it is, the more it is turned down.
        let input = sine(220.0, 0.2, 4_800);
        let level = |loudness| {
            let assets = OneAmp::new(None, Some(loudness));
            let mut chain = build_one(&assets, &[amp_slot(0.0, 0.0, true)]);
            rms(&run(&mut chain, &input)[480..])
        };
        assert!(level(-30.0) > level(-10.0) * 3.0);
    }

    #[test]
    fn the_dc_blocker_removes_an_offset_but_keeps_the_tone() {
        let mut dc = DcBlocker::new(RATE);
        let settled = (0..RATE as usize).map(|_| dc.process(1.0)).last().unwrap();
        assert!(settled.abs() < 1e-3, "left {settled}");
        let mut dc = DcBlocker::new(RATE);
        let tone: Vec<f32> = sine(200.0, 0.5, 4_800)
            .into_iter()
            .map(|x| dc.process(x))
            .collect();
        assert!(rms(&tone[480..]) > 0.34, "tone level {}", rms(&tone[480..]));
    }

    #[test]
    fn a_missing_asset_message_is_readable() {
        let chain = build_one(
            &NoAssets,
            &[slot(EffectConfig::Cab {
                ir: "4f3a9c0d77e1b2aa".into(),
            })],
        );
        let message = &chain.problems[0].message;
        assert!(message.contains("not in your sound library"), "{message}");
        assert!(message.contains("4f3a9c0d"), "{message}");
        assert!(
            !message.contains("4f3a9c0d77e1b2aa"),
            "full hash: {message}"
        );
    }

    #[test]
    fn effect_config_round_trips_as_tagged_json() {
        let slots = vec![
            slot(EffectConfig::Gate(GateParams::default())),
            slot(EffectConfig::Eq {
                bands: super::super::dsp::eq::graphic_bands(),
            }),
            slot(EffectConfig::Amp {
                model: "lib:abc".into(),
                input_db: 3.0,
                output_db: -2.0,
                match_loudness: true,
            }),
        ];
        let json = serde_json::to_string(&slots).unwrap();
        assert!(json.contains(r#""type":"gate""#));
        assert!(json.contains(r#""type":"amp""#));
        let back: Vec<EffectSlot> = serde_json::from_str(&json).unwrap();
        assert_eq!(back, slots);
        // Missing parameters take their defaults.
        let partial: EffectSlot =
            serde_json::from_str(r#"{"enabled":true,"type":"compressor","ratio":8}"#).unwrap();
        let EffectConfig::Compressor(p) = partial.effect else {
            panic!()
        };
        assert_eq!(p.ratio, 8.0);
        assert_eq!(p.threshold_db, CompressorParams::default().threshold_db);
    }

    fn every_kind() -> Vec<EffectSlot> {
        vec![
            slot(EffectConfig::AmpSim(AmpSimParams::default())),
            slot(EffectConfig::Chorus(ChorusParams::default())),
            slot(EffectConfig::Phaser(PhaserParams::default())),
            slot(EffectConfig::Tremolo(TremoloParams::default())),
            slot(EffectConfig::Delay(DelayParams::default())),
            slot(EffectConfig::Reverb(ReverbParams::default())),
        ]
    }

    #[test]
    fn new_blocks_round_trip_and_build() {
        let slots = every_kind();
        let json = serde_json::to_string(&slots).unwrap();
        for kind in ["ampSim", "chorus", "phaser", "tremolo", "delay", "reverb"] {
            assert!(json.contains(&format!(r#""type":"{kind}""#)), "{kind}");
        }
        assert!(json.contains(r#""pingPong":false"#));
        let back: Vec<EffectSlot> = serde_json::from_str(&json).unwrap();
        assert_eq!(back, slots);
        let mut chain = Chain::build(
            &slots,
            MAX_TRACK_EFFECTS,
            RATE,
            64,
            &NoAssets,
            &crate::audio::plugin::PluginPool::default(),
        );
        assert!(chain.problems.is_empty());
        let mut l = sine(220.0, 0.5, 4_800);
        let mut r = l.clone();
        for (a, b) in l.chunks_mut(64).zip(r.chunks_mut(64)) {
            chain.process(a, b);
        }
        assert!(all_finite(&l) && peak(&l) > 0.01);
    }

    #[test]
    fn parameter_changes_update_in_place_and_structure_changes_do_not() {
        let mut slots = every_kind();
        let mut chain = Chain::build(
            &slots,
            MAX_TRACK_EFFECTS,
            RATE,
            64,
            &NoAssets,
            &crate::audio::plugin::PluginPool::default(),
        );
        // A knob turn on every block.
        slots[0].effect = EffectConfig::AmpSim(AmpSimParams {
            gain: 0.9,
            ..Default::default()
        });
        slots[4].effect = EffectConfig::Delay(DelayParams {
            time_ms: 100.0,
            ..Default::default()
        });
        assert!(chain.update(&slots, MAX_TRACK_EFFECTS));
        assert_eq!(chain.layout[4], slots[4].effect);
        // Switching a block off, reordering or replacing one needs a rebuild.
        let mut off = slots.clone();
        off[1].enabled = false;
        assert!(!chain.update(&off, MAX_TRACK_EFFECTS));
        let mut moved = slots.clone();
        moved.swap(0, 1);
        assert!(!chain.update(&moved, MAX_TRACK_EFFECTS));
        // Gate, compressor, EQ and drive update too; cabs never do.
        let mut basic = vec![
            slot(EffectConfig::Gate(GateParams::default())),
            slot(EffectConfig::Compressor(CompressorParams::default())),
            slot(EffectConfig::Eq {
                bands: super::super::dsp::eq::graphic_bands(),
            }),
            slot(EffectConfig::Drive(DriveParams::default())),
        ];
        let mut chain = Chain::build(
            &basic,
            MAX_TRACK_EFFECTS,
            RATE,
            64,
            &NoAssets,
            &crate::audio::plugin::PluginPool::default(),
        );
        basic[0].effect = EffectConfig::Gate(GateParams {
            threshold_db: -30.0,
            ..Default::default()
        });
        basic[1].effect = EffectConfig::Compressor(CompressorParams {
            ratio: 10.0,
            ..Default::default()
        });
        let mut bands = super::super::dsp::eq::graphic_bands();
        bands[3].gain_db = 6.0;
        basic[2].effect = EffectConfig::Eq {
            bands: bands.clone(),
        };
        basic[3].effect = EffectConfig::Drive(DriveParams {
            drive: 0.9,
            ..Default::default()
        });
        assert!(chain.update(&basic, MAX_TRACK_EFFECTS));
        bands.pop();
        basic[2].effect = EffectConfig::Eq { bands };
        assert!(
            !chain.update(&basic, MAX_TRACK_EFFECTS),
            "band count changed"
        );
        let cab = [slot(EffectConfig::Cab { ir: "x".into() })];
        let mut chain = Chain::build(
            &cab,
            MAX_TRACK_EFFECTS,
            RATE,
            64,
            &NoAssets,
            &crate::audio::plugin::PluginPool::default(),
        );
        assert!(
            !chain.update(&cab, MAX_TRACK_EFFECTS),
            "missing assets rebuild"
        );
    }

    #[test]
    fn crossfade_is_continuous() {
        let gain_chain = |db: f32| {
            Chain::build(
                &[slot(EffectConfig::Compressor(CompressorParams {
                    ratio: 1.0,
                    makeup_db: db,
                    ..Default::default()
                }))],
                MAX_TRACK_EFFECTS,
                RATE,
                64,
                &NoAssets,
                &crate::audio::plugin::PluginPool::default(),
            )
        };
        let mut player = ChainPlayer::new(gain_chain(0.0), RATE, 64);
        let mut out = Vec::new();
        for block in 0..40 {
            if block == 10 {
                assert!(player.replace(gain_chain(12.0)).is_none());
            }
            let (mut l, mut r) = (vec![0.25; 64], vec![0.25; 64]);
            player.process(&mut l, &mut r);
            out.extend(l);
        }
        // DC input: the output must ramp, never jump by more than a small step.
        let max_step = out
            .windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0, f32::max);
        assert!(max_step < 0.01, "step {max_step}");
        assert!((out.last().unwrap() - 0.25 * db_to_gain(12.0)).abs() < 1e-3);
    }

    /// Bypassing a compressor that is reducing hard (#39) must not click.
    #[test]
    fn bypassing_a_compressor_in_heavy_reduction_is_continuous() {
        let squash = EffectSlot {
            enabled: true,
            effect: EffectConfig::Compressor(CompressorParams {
                threshold_db: -30.0,
                ratio: 10.0,
                attack_ms: 1.0,
                ..Default::default()
            }),
        };
        let bypassed = EffectSlot {
            enabled: false,
            ..squash.clone()
        };
        let build = |slot: &EffectSlot| {
            Chain::build(
                std::slice::from_ref(slot),
                MAX_TRACK_EFFECTS,
                RATE,
                64,
                &NoAssets,
                &crate::audio::plugin::PluginPool::default(),
            )
        };
        let mut player = ChainPlayer::new(build(&squash), RATE, 64);
        let mut out = Vec::new();
        for block in 0..60 {
            if block == 30 {
                player.replace(build(&bypassed));
            }
            // A slow 50 Hz tone: any jump bigger than its own steps is a click.
            let (mut l, mut r): (Vec<f32>, Vec<f32>) = (0..64)
                .map(|i| {
                    let t = (block * 64 + i) as f32 / RATE;
                    let v = 0.8 * (std::f32::consts::TAU * 50.0 * t).sin();
                    (v, v)
                })
                .unzip();
            player.process(&mut l, &mut r);
            out.extend(l);
        }
        let max_step = out
            .windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0, f32::max);
        // The tone itself moves at most 2π·50/48000·0.8 ≈ 0.005 per sample.
        assert!(max_step < 0.02, "step {max_step}");
        assert!(out.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn reports_the_gain_reduction_of_each_slot() {
        let slots = [
            EffectSlot {
                enabled: false,
                effect: EffectConfig::Reverb(ReverbParams::default()),
            },
            slot(EffectConfig::Compressor(CompressorParams {
                threshold_db: -20.0,
                ratio: 4.0,
                knee_db: 0.0,
                ..Default::default()
            })),
            slot(EffectConfig::Limiter(LimiterParams {
                ceiling_db: -1.0,
                ..Default::default()
            })),
        ];
        let mut chain = Chain::build(
            &slots,
            MAX_TRACK_EFFECTS,
            RATE,
            4_800,
            &NoAssets,
            &crate::audio::plugin::PluginPool::default(),
        );
        let (mut l, mut r) = (vec![1.0f32; 4_800], vec![1.0f32; 4_800]);
        chain.process(&mut l, &mut r);
        let meters = chain.take_reduction();
        assert_eq!(meters[0], 0.0, "the bypassed reverb has no meter");
        assert!(meters[1] > 10.0, "compressor: {}", meters[1]);
        // The limiter only catches the compressor's attack transient.
        assert!((0.0..3.0).contains(&meters[2]), "limiter: {}", meters[2]);
        assert_eq!(
            chain.take_reduction(),
            [0.0; MAX_TRACK_EFFECTS],
            "read once"
        );
    }

    #[test]
    fn limiter_blocks_round_trip_through_json() {
        let json = r#"{"enabled":true,"type":"limiter","ceilingDb":-0.3,"inputDb":6}"#;
        let slot: EffectSlot = serde_json::from_str(json).unwrap();
        let EffectConfig::Limiter(p) = slot.effect else {
            panic!("not a limiter")
        };
        assert_eq!(p.ceiling_db, -0.3);
        assert_eq!(p.input_db, 6.0);
        assert_eq!(p.lookahead_ms, LimiterParams::default().lookahead_ms);
    }

    fn plugin_slot(path: &str, state: &str) -> EffectSlot {
        slot(EffectConfig::Plugin {
            format: super::super::plugin::PluginFormat::Vst3,
            path: path.into(),
            name: "Test amp".into(),
            state: state.into(),
        })
    }

    #[test]
    fn plugin_blocks_round_trip_through_json() {
        let slots = vec![plugin_slot("/Library/Audio/Plug-Ins/VST3/Amp.vst3", "aGk=")];
        let json = serde_json::to_string(&slots).unwrap();
        assert!(json.contains(r#""type":"plugin""#), "{json}");
        assert!(json.contains(r#""format":"vst3""#), "{json}");
        let back: Vec<EffectSlot> = serde_json::from_str(&json).unwrap();
        assert_eq!(back, slots);
        // Missing fields take their defaults (songs saved before names existed).
        let partial: EffectSlot = serde_json::from_str(
            r#"{"enabled":true,"type":"plugin","format":"clap","path":"/x/Amp.clap"}"#,
        )
        .unwrap();
        let EffectConfig::Plugin {
            format,
            name,
            state,
            ..
        } = partial.effect
        else {
            panic!()
        };
        assert_eq!(format, super::super::plugin::PluginFormat::Clap);
        assert_eq!(name, "");
        assert_eq!(state, "");
    }

    #[test]
    fn plugin_blocks_stay_off_until_switched_on() {
        let pool = crate::audio::plugin::PluginPool::default();
        let chain = Chain::build(
            &[plugin_slot("/Library/Audio/Plug-Ins/VST3/Amp.vst3", "")],
            MAX_TRACK_EFFECTS,
            RATE,
            64,
            &NoAssets,
            &pool,
        );
        assert!(chain.is_empty());
        assert_eq!(chain.problems.len(), 1);
        assert!(
            chain.problems[0].message.contains("switched off"),
            "{}",
            chain.problems[0].message
        );
    }

    #[test]
    fn a_missing_plugin_is_reported_not_fatal() {
        let pool = crate::audio::plugin::PluginPool::default();
        pool.set_enabled(true);
        let chain = Chain::build(
            &[plugin_slot("/nonexistent/Amp.vst3", "")],
            MAX_TRACK_EFFECTS,
            RATE,
            64,
            &NoAssets,
            &pool,
        );
        assert!(chain.is_empty());
        assert_eq!(chain.problems.len(), 1);
        assert!(
            chain.problems[0].message.contains("not installed"),
            "{}",
            chain.problems[0].message
        );
    }

    #[test]
    fn a_corrupt_plugin_preset_is_reported_not_fatal() {
        let pool = crate::audio::plugin::PluginPool::default();
        pool.set_enabled(true);
        let chain = Chain::build(
            &[plugin_slot("/Library/Audio/Plug-Ins/VST3/Amp.vst3", "!!!")],
            MAX_TRACK_EFFECTS,
            RATE,
            64,
            &NoAssets,
            &pool,
        );
        assert!(chain.is_empty());
        assert!(
            chain.problems[0].message.contains("corrupt"),
            "{}",
            chain.problems[0].message
        );
    }

    #[test]
    fn a_plugin_block_passes_audio_dry_without_an_answer() {
        // No helper involved: a worker whose helper never answers leaves the
        // signal untouched (this is the crash/timeout path, synchronously).
        let pool = crate::audio::plugin::PluginPool::default();
        pool.set_enabled(true);
        let mut chain = Chain::build(
            &[plugin_slot("/nonexistent/Amp.vst3", "")],
            MAX_TRACK_EFFECTS,
            RATE,
            64,
            &NoAssets,
            &pool,
        );
        assert!(chain.is_empty());
        let input = sine(220.0, 0.4, 64);
        let (mut l, mut r) = (input.clone(), input.clone());
        chain.process(&mut l, &mut r);
        assert_eq!(l, input);
        assert_eq!(r, input);
    }
}
