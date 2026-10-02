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
use super::dsp::modulation::{Chorus, ChorusParams, Phaser, PhaserParams, Tremolo, TremoloParams};
use super::dsp::reverb::{Reverb, ReverbParams};
use super::dsp::{Effect, db_to_gain};

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
    /// A Neural Amp Modeler capture from the user's library (amp or pedal).
    #[serde(rename_all = "camelCase")]
    Amp {
        /// Library id of the `.nam` file.
        model: String,
        #[serde(default)]
        input_db: f32,
        #[serde(default)]
        output_db: f32,
    },
    /// A cabinet impulse response from the user's library (or a built-in one).
    Cab {
        /// Library id of the IR (`builtin:<name>` for the generated ones).
        ir: String,
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
            Self::Amp { .. } => "amp",
            Self::Cab { .. } => "cab",
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

/// A NAM capture run on the mid (mono) signal, the way amps are recorded.
struct Amp {
    model: nam_rs::Model,
    input: f32,
    output: f32,
    mono: Vec<f32>,
}

impl Effect for Amp {
    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        let step = self.mono.len();
        for (l, r) in left.chunks_mut(step).zip(right.chunks_mut(step)) {
            let mono = &mut self.mono[..l.len()];
            for ((m, a), b) in mono.iter_mut().zip(l.iter()).zip(r.iter()) {
                *m = 0.5 * (a + b) * self.input;
            }
            self.model.process_buffer(mono);
            for ((m, a), b) in mono.iter().zip(l.iter_mut()).zip(r.iter_mut()) {
                let y = m * self.output;
                let y = if y.is_finite() {
                    y.clamp(-4.0, 4.0)
                } else {
                    0.0
                };
                *a = y;
                *b = y;
            }
        }
    }

    fn reset(&mut self) {
        self.model.reset();
    }
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
    pub problems: Vec<BlockProblem>,
}

impl Chain {
    pub fn empty() -> Self {
        Self {
            blocks: Vec::new(),
            layout: Vec::new(),
            problems: Vec::new(),
        }
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
    ) -> Self {
        let mut blocks: Vec<Box<dyn Effect>> = Vec::new();
        let mut layout = Vec::new();
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
                EffectConfig::Cab { ir } => assets
                    .impulse_response(ir)
                    .map(|spectrum| Box::new(Convolver::new(spectrum)) as Box<dyn Effect>)
                    .ok_or_else(|| format!("Impulse response “{ir}” is not in the library")),
                EffectConfig::Amp {
                    model,
                    input_db,
                    output_db,
                } => match assets.amp_model(model) {
                    None => Err(format!("Amp model “{model}” is not in the library")),
                    Some(nam) => {
                        let expected = nam.expected_sample_rate() as f32;
                        if (expected - sample_rate).abs() > 1.0 {
                            Err(format!(
                                "The amp model needs {expected} Hz; the audio output runs at {sample_rate} Hz"
                            ))
                        } else {
                            nam_rs::Model::from_nam(&nam)
                                .map(|model| {
                                    Box::new(Amp {
                                        model,
                                        input: db_to_gain(input_db.clamp(-24.0, 24.0)),
                                        output: db_to_gain(output_db.clamp(-24.0, 24.0)),
                                        mono: vec![0.0; max_block.max(1)],
                                    }) as Box<dyn Effect>
                                })
                                .map_err(|e| format!("The amp model cannot run: {e}"))
                        }
                    }
                },
            };
            match block {
                Ok(block) => {
                    blocks.push(block);
                    layout.push(slot.effect.clone());
                }
                Err(message) => problems.push(BlockProblem { index, message }),
            }
        }
        Self {
            blocks,
            layout,
            problems,
        }
    }

    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        for block in &mut self.blocks {
            block.process(left, right);
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
        let mut chain = Chain::build(&[], MAX_TRACK_EFFECTS, RATE, 64, &NoAssets);
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
        let chain = Chain::build(&slots, MAX_TRACK_EFFECTS, RATE, 64, &NoAssets);
        assert!(chain.is_empty());
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
        let chain = Chain::build(&slots, MAX_MASTER_EFFECTS, RATE, 64, &NoAssets);
        assert_eq!(chain.problems.len(), 3);
        assert!(chain.problems[0].message.contains("missing-0"));
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
        let mut chain = Chain::build(&slots, MAX_TRACK_EFFECTS, RATE, 64, &NoAssets);
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
        let mut chain = Chain::build(&slots, MAX_TRACK_EFFECTS, RATE, 64, &NoAssets);
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
        let mut chain = Chain::build(&basic, MAX_TRACK_EFFECTS, RATE, 64, &NoAssets);
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
        let mut chain = Chain::build(&cab, MAX_TRACK_EFFECTS, RATE, 64, &NoAssets);
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
}
