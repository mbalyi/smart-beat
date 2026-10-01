//! Effect chains: the ordered blocks of a track (up to [`MAX_TRACK_EFFECTS`])
//! or of the master bus (up to [`MAX_MASTER_EFFECTS`]), as data that presets
//! and score files store, and as the running processors built from it.
//!
//! A new chain never replaces the running one abruptly: [`ChainPlayer`]
//! crossfades from the old to the new one, so switching an effect on or off or
//! turning a knob does not click.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::dsp::compressor::{Compressor, CompressorParams};
use super::dsp::convolver::{Convolver, IrSpectrum};
use super::dsp::drive::{Drive, DriveParams};
use super::dsp::eq::{Band, Eq};
use super::dsp::gate::{Gate, GateParams};
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
    pub problems: Vec<BlockProblem>,
}

impl Chain {
    pub fn empty() -> Self {
        Self {
            blocks: Vec::new(),
            problems: Vec::new(),
        }
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
                Ok(block) => blocks.push(block),
                Err(message) => problems.push(BlockProblem { index, message }),
            }
        }
        Self { blocks, problems }
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
