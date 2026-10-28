//! Stem separation (issue #186): split a finished recording into parts (drums, bass, vocals,
//! panned guitars or keys, and the rest) with signal processing only, no neural network, on
//! this computer. The parts add up to the original, so any of them can be muted without
//! touching the others.
//!
//! The methods are published ones, written from the papers: median-filter HPSS with soft
//! Wiener masks (FitzGerald 2010; Driedger et al. 2014), YIN pitch tracking (de Cheveigné and
//! Kawahara 2002) with a harmonic comb mask for the bass, a stereo coherence mask for centred
//! parts and a pan mask for hard-panned ones. No instrument is removed by a plain frequency
//! cut: every mask follows the part's own structure in time and frequency.

pub mod bass;
pub mod detect;
pub mod hpss;
pub mod metrics;
pub mod pipeline;
pub mod stereo;
pub mod stft;
pub mod synth;
pub mod torch_legacy;
pub mod umx;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub use pipeline::{Options, Report, separate};

/// What the user sees when a job is cancelled.
pub const STOPPED: &str = "Stem separation stopped.";

/// One part of the song.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StemKind {
    Drums,
    Bass,
    Vocals,
    /// Everything hard-panned to one side after the parts above were taken out: double-tracked
    /// guitars, wide keys. Not an instrument name, because the signal does not tell which.
    Panned,
    /// What is left. Labelled "not separated" in the app.
    Other,
}

impl StemKind {
    pub const ALL: [StemKind; 5] = [
        StemKind::Drums,
        StemKind::Bass,
        StemKind::Vocals,
        StemKind::Panned,
        StemKind::Other,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Self::Drums => "drums",
            Self::Bass => "bass",
            Self::Vocals => "vocals",
            Self::Panned => "panned",
            Self::Other => "other",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.id() == id)
    }
}

/// Receives the finished stems, one time range at a time, in song order.
pub trait StemSink {
    fn write(&mut self, kind: StemKind, left: &[f32], right: &[f32]) -> Result<(), String>;
}

/// Keeps every stem in memory (tests, the benchmark).
#[derive(Debug, Default)]
pub struct MemorySink {
    pub stems: BTreeMap<StemKind, (Vec<f32>, Vec<f32>)>,
}

impl StemSink for MemorySink {
    fn write(&mut self, kind: StemKind, left: &[f32], right: &[f32]) -> Result<(), String> {
        let entry = self.stems.entry(kind).or_default();
        entry.0.extend_from_slice(left);
        entry.1.extend_from_slice(right);
        Ok(())
    }
}
