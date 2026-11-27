//! MIDI lanes (ADR 0006): lanes whose clips hold notes and controller events instead of audio,
//! played by an instrument (a SoundFont program, the drum kit, an imported kit, a pad bank of
//! samples, or a VST3/CLAP instrument) through the same lane bus as audio lanes.
//!
//! Mirrored by `MidiClipData`, `LaneInstrument` and `PadSlot` in `src/lib/tauri.ts`. Event times
//! are ms from the clip start on the audio timeline, like audio clip positions, so every clip
//! edit (move, split, trim, glue) works the same for both kinds.

use serde::{Deserialize, Serialize};

/// The most notes one take of a clip may hold.
pub const MAX_NOTES_PER_TAKE: usize = 20_000;
/// The most controller events one take may hold.
pub const MAX_CC_PER_TAKE: usize = 50_000;
/// The most notes and controller events of a whole song's MIDI lanes.
pub const MAX_MIDI_EVENTS: usize = 200_000;
/// The most pads a pad bank holds (8 banks of 16).
pub const MAX_PADS: usize = 128;
/// The longest event offset or note, in ms (a day).
const MAX_MS: f64 = 86_400_000.0;

fn finite_in(value: f64, min: f64, max: f64) -> bool {
    value.is_finite() && (min..=max).contains(&value)
}

/// A lane's kind; absent in the file means audio.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LaneKind {
    Midi,
}

/// One note of a MIDI clip.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiNote {
    pub id: String,
    pub start_ms: f64,
    pub len_ms: f64,
    pub pitch: u8,
    pub vel: u8,
    #[serde(default)]
    pub chan: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_start_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_len_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub muted: bool,
}

/// What a controller event changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MidiCcKind {
    Cc,
    Bend,
    Pressure,
    Program,
}

/// A controller change, pitch bend, channel pressure or program change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiCc {
    pub at_ms: f64,
    pub kind: MidiCcKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cc: Option<u8>,
    pub value: i32,
    #[serde(default)]
    pub chan: u8,
}

/// One take of a MIDI clip.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MidiTake {
    pub notes: Vec<MidiNote>,
    pub cc: Vec<MidiCc>,
}

/// A MIDI clip's events: `takes[i]` belongs to the clip's `takes[i]` (which keeps the name).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MidiClipData {
    pub takes: Vec<MidiTake>,
}

/// How a pad plays its sample.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PadPlayback {
    #[default]
    OneShot,
    Gate,
    Loop,
}

/// A sample from the sample browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PadSample {
    pub folder_id: String,
    pub rel: String,
}

/// One pad of a pad bank.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PadSlot {
    pub key: u8,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample: Option<PadSample>,
    /// The sample in the song's pool.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    /// A drum of the General MIDI kit instead of a sample.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drum: Option<u8>,
    #[serde(default)]
    pub playback: PadPlayback,
    #[serde(default)]
    pub trim_start_ms: f64,
    #[serde(default)]
    pub trim_end_ms: f64,
    #[serde(default)]
    pub semitones: i32,
    #[serde(default)]
    pub cents: i32,
    #[serde(default = "full")]
    pub volume: f32,
    #[serde(default)]
    pub pan: f32,
    #[serde(default = "full")]
    pub vel_depth: f32,
    #[serde(default)]
    pub choke: u8,
    #[serde(default = "four")]
    pub voices: u8,
    #[serde(default)]
    pub send_a: f32,
    #[serde(default)]
    pub send_b: f32,
}

fn full() -> f32 {
    1.0
}
fn four() -> u8 {
    4
}

/// Plugin formats an instrument can be.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstrumentFormat {
    Vst3,
    Clap,
}

/// What a MIDI lane sounds with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LaneInstrument {
    Soundfont {
        #[serde(default)]
        program: u8,
        #[serde(default)]
        bank: u16,
    },
    Drums,
    Kit {
        kit_id: String,
    },
    Pads {
        #[serde(default)]
        pads: Vec<PadSlot>,
    },
    Plugin {
        format: InstrumentFormat,
        path: String,
        #[serde(default)]
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        state: Option<String>,
    },
}

impl Default for LaneInstrument {
    fn default() -> Self {
        LaneInstrument::Soundfont {
            program: 0,
            bank: 0,
        }
    }
}

impl MidiNote {
    fn validate(&self, clip_ms: f64) -> Result<(), String> {
        if self.id.is_empty() || self.id.len() > 80 {
            return Err("invalid note id".into());
        }
        if !finite_in(self.start_ms, 0.0, clip_ms.min(MAX_MS))
            || !finite_in(self.len_ms, 0.0, MAX_MS)
            || self.pitch > 127
            || !(1..=127).contains(&self.vel)
            || self.chan > 15
        {
            return Err("note out of range".into());
        }
        let raw_ok = |v: Option<f64>| v.is_none_or(|v| finite_in(v, -MAX_MS, MAX_MS));
        if !raw_ok(self.raw_start_ms) || !raw_ok(self.raw_len_ms) {
            return Err("note timing out of range".into());
        }
        Ok(())
    }
}

impl MidiCc {
    fn validate(&self, clip_ms: f64) -> Result<(), String> {
        if !finite_in(self.at_ms, 0.0, clip_ms.min(MAX_MS)) || self.chan > 15 {
            return Err("controller event out of range".into());
        }
        let value_ok = match self.kind {
            MidiCcKind::Bend => (-8192..=8191).contains(&self.value),
            _ => (0..=127).contains(&self.value),
        };
        let cc_ok = match self.kind {
            MidiCcKind::Cc => self.cc.is_some_and(|c| c <= 127),
            _ => true,
        };
        if !value_ok || !cc_ok {
            return Err("controller value out of range".into());
        }
        Ok(())
    }
}

impl MidiClipData {
    /// Checks a clip of `takes` takes and `clip_ms` length holds only events in range.
    pub fn validate(&self, takes: usize, clip_ms: f64) -> Result<(), String> {
        if self.takes.len() != takes {
            return Err("a MIDI clip needs events for every take".into());
        }
        for take in &self.takes {
            if take.notes.len() > MAX_NOTES_PER_TAKE || take.cc.len() > MAX_CC_PER_TAKE {
                return Err("too many MIDI events in a clip".into());
            }
            take.notes.iter().try_for_each(|n| n.validate(clip_ms))?;
            take.cc.iter().try_for_each(|c| c.validate(clip_ms))?;
        }
        Ok(())
    }

    /// Notes and controller events of every take.
    pub fn event_count(&self) -> usize {
        self.takes.iter().map(|t| t.notes.len() + t.cc.len()).sum()
    }
}

impl PadSlot {
    fn validate(&self, has_source: &dyn Fn(&str) -> bool) -> Result<(), String> {
        if self.key > 127 || self.name.chars().count() > 64 {
            return Err("invalid pad".into());
        }
        if let Some(sample) = &self.sample
            && (sample.folder_id.is_empty() || sample.rel.is_empty() || sample.rel.len() > 1024)
        {
            return Err("invalid pad sample".into());
        }
        if let Some(id) = &self.source_id
            && !has_source(id)
        {
            return Err("a pad plays an unknown source".into());
        }
        if self.drum.is_some_and(|d| d > 127)
            || !finite_in(self.trim_start_ms, 0.0, MAX_MS)
            || !finite_in(self.trim_end_ms, 0.0, MAX_MS)
            || !(-24..=24).contains(&self.semitones)
            || !(-100..=100).contains(&self.cents)
            || !(0.0..=1.0).contains(&self.volume)
            || !(-1.0..=1.0).contains(&self.pan)
            || !(0.0..=1.0).contains(&self.vel_depth)
            || self.choke > 16
            || !(1..=32).contains(&self.voices)
            || !(0.0..=1.0).contains(&self.send_a)
            || !(0.0..=1.0).contains(&self.send_b)
        {
            return Err("pad setting out of range".into());
        }
        Ok(())
    }
}

impl LaneInstrument {
    /// Checks every value is in range; `has_source` tells whether a pool source exists.
    pub fn validate(&self, has_source: &dyn Fn(&str) -> bool) -> Result<(), String> {
        match self {
            LaneInstrument::Soundfont { program, .. } if *program > 127 => {
                Err("instrument program out of range".into())
            }
            LaneInstrument::Kit { kit_id } if kit_id.is_empty() || kit_id.len() > 80 => {
                Err("invalid kit id".into())
            }
            LaneInstrument::Pads { pads } => {
                if pads.len() > MAX_PADS {
                    return Err("too many pads".into());
                }
                pads.iter().try_for_each(|p| p.validate(has_source))
            }
            LaneInstrument::Plugin {
                path, name, state, ..
            } => {
                if path.is_empty() || path.len() > 4096 || name.chars().count() > 200 {
                    return Err("invalid instrument plugin".into());
                }
                if state.as_ref().is_some_and(|s| s.len() > 8 * 1024 * 1024) {
                    return Err("instrument plugin state too large".into());
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// The pool sources the instrument plays (a pad bank's embedded samples).
    pub fn source_ids(&self) -> impl Iterator<Item = &str> {
        let pads: &[PadSlot] = match self {
            LaneInstrument::Pads { pads } => pads,
            _ => &[],
        };
        pads.iter().filter_map(|p| p.source_id.as_deref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(start: f64) -> MidiNote {
        MidiNote {
            id: "n1".into(),
            start_ms: start,
            len_ms: 100.0,
            pitch: 36,
            vel: 100,
            chan: 9,
            raw_start_ms: None,
            raw_len_ms: None,
            muted: false,
        }
    }

    #[test]
    fn instrument_reads_the_typescript_shape() {
        let json = r#"{"type":"pads","pads":[{"key":36,"name":"Kick","sourceId":"abc","choke":1,"sendA":0.5}]}"#;
        let inst: LaneInstrument = serde_json::from_str(json).unwrap();
        let LaneInstrument::Pads { pads } = &inst else {
            panic!("pads expected")
        };
        assert_eq!(pads[0].voices, 4, "defaults fill missing fields");
        assert_eq!(pads[0].volume, 1.0);
        assert_eq!(inst.source_ids().collect::<Vec<_>>(), vec!["abc"]);
        let back = serde_json::to_value(&inst).unwrap();
        assert_eq!(back["type"], "pads");
        assert_eq!(back["pads"][0]["sendA"], 0.5);
        let sf: LaneInstrument =
            serde_json::from_str(r#"{"type":"soundfont","program":33,"bank":0}"#).unwrap();
        assert_eq!(
            sf,
            LaneInstrument::Soundfont {
                program: 33,
                bank: 0
            }
        );
        let plugin: LaneInstrument = serde_json::from_str(
            r#"{"type":"plugin","format":"clap","path":"/a.clap","name":"Synth"}"#,
        )
        .unwrap();
        assert!(matches!(
            plugin,
            LaneInstrument::Plugin {
                format: InstrumentFormat::Clap,
                ..
            }
        ));
    }

    #[test]
    fn clip_data_checks_ranges_and_take_count() {
        let mut data = MidiClipData {
            takes: vec![MidiTake {
                notes: vec![note(10.0)],
                cc: vec![MidiCc {
                    at_ms: 0.0,
                    kind: MidiCcKind::Bend,
                    cc: None,
                    value: -8192,
                    chan: 0,
                }],
            }],
        };
        assert_eq!(data.validate(1, 1_000.0), Ok(()));
        assert!(data.validate(2, 1_000.0).is_err(), "one event set per take");
        assert!(
            data.validate(1, 5.0).is_err(),
            "a note starts inside the clip"
        );
        data.takes[0].notes[0].vel = 0;
        assert!(
            data.validate(1, 1_000.0).is_err(),
            "velocity 0 is a note-off, not a note"
        );
        data.takes[0].notes[0].vel = 1;
        data.takes[0].cc[0].kind = MidiCcKind::Cc;
        assert!(
            data.validate(1, 1_000.0).is_err(),
            "a cc names its controller"
        );
        assert_eq!(data.event_count(), 2);
    }

    #[test]
    fn pads_check_sources_and_ranges() {
        let pad: PadSlot = serde_json::from_str(r#"{"key":36,"sourceId":"x"}"#).unwrap();
        let inst = LaneInstrument::Pads {
            pads: vec![pad.clone()],
        };
        assert!(inst.validate(&|_| false).is_err());
        assert_eq!(inst.validate(&|id| id == "x"), Ok(()));
        let loud = PadSlot { choke: 17, ..pad };
        assert!(
            LaneInstrument::Pads { pads: vec![loud] }
                .validate(&|_| true)
                .is_err()
        );
    }
}
