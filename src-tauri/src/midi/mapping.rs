//! Per-device settings for MIDI input (ADR 0006), kept in the app data folder, never in a song:
//! a name of your own, a time offset, a channel filter, a pad map (which drum or sample each pad
//! of a pad controller plays), and controls (knobs and buttons that run app actions).
//!
//! A device is matched by its port name, then by that name without a trailing number, so a
//! controller plugged into another USB socket keeps its settings.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::midi::message::{MidiMessage, Transport};

/// The most devices remembered, pads per map and controls per device.
pub const MAX_DEVICES: usize = 64;
pub const MAX_PAD_MAP: usize = 128;
pub const MAX_CONTROLS: usize = 64;

/// What a mapped control does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ControlAction {
    PlayPause,
    Stop,
    Record,
    Metronome,
    Loop,
    /// The armed lane's volume (a knob).
    LaneVolume,
    LanePan,
    MasterVolume,
    /// The speed trainer's speed (a knob).
    Speed,
}

/// What a control listens to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ControlSource {
    Cc,
    Note,
}

/// A knob, fader or button mapped to an action.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlMap {
    pub source: ControlSource,
    pub chan: u8,
    pub number: u8,
    pub action: ControlAction,
    /// A knob that sends +/- steps (64 ± n) instead of positions.
    #[serde(default)]
    pub relative: bool,
}

/// One pad of a pad controller: the note it sends, and the note it plays.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PadRoute {
    /// The note the pad sends.
    pub from: u8,
    /// The note it plays (a General MIDI drum, or a pad of a pad bank).
    pub to: u8,
}

/// How a pad controller lays out its pads in the app's pad grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PadLayout {
    #[default]
    Grid16,
    Grid8,
}

/// Everything remembered about one device.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSettings {
    /// The port name as the system reports it.
    pub name: String,
    #[serde(default)]
    pub alias: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Added to every note's time when recording, in ms (a device that is late is negative).
    #[serde(default)]
    pub offset_ms: f64,
    /// Only controls (knobs, transport): its notes play nothing.
    #[serde(default)]
    pub control_only: bool,
    /// Only this channel (0 … 15) is listened to; none: every channel.
    #[serde(default)]
    pub channel: Option<u8>,
    /// Notes moved by this many semitones (keyboards; pads use the pad map).
    #[serde(default)]
    pub transpose: i8,
    /// Fixed velocity for every note (pads without touch response); none: as played.
    #[serde(default)]
    pub fixed_velocity: Option<u8>,
    #[serde(default)]
    pub pad_layout: PadLayout,
    #[serde(default)]
    pub pads: Vec<PadRoute>,
    #[serde(default)]
    pub controls: Vec<ControlMap>,
}

fn yes() -> bool {
    true
}

impl DeviceSettings {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            alias: String::new(),
            enabled: true,
            offset_ms: 0.0,
            control_only: false,
            channel: None,
            transpose: 0,
            fixed_velocity: None,
            pad_layout: PadLayout::Grid16,
            pads: Vec::new(),
            controls: Vec::new(),
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.name.is_empty()
            || self.name.chars().count() > 200
            || self.alias.chars().count() > 80
        {
            return Err("invalid MIDI device name".into());
        }
        if !self.offset_ms.is_finite() || self.offset_ms.abs() > 500.0 {
            return Err("MIDI device offset out of range".into());
        }
        if self.channel.is_some_and(|c| c > 15)
            || !(-48..=48).contains(&self.transpose)
            || self.fixed_velocity.is_some_and(|v| !(1..=127).contains(&v))
        {
            return Err("MIDI device setting out of range".into());
        }
        if self.pads.len() > MAX_PAD_MAP
            || self.pads.iter().any(|p| p.from > 127 || p.to > 127)
            || self.controls.len() > MAX_CONTROLS
            || self.controls.iter().any(|c| c.chan > 15 || c.number > 127)
        {
            return Err("invalid MIDI pad map or controls".into());
        }
        Ok(())
    }

    /// What the device's message becomes: a note or controller for the armed lane, an app
    /// action, or nothing (filtered out).
    pub fn route(&self, message: MidiMessage) -> Routed {
        if let MidiMessage::Transport(t) = message {
            return Routed::Action(
                match t {
                    Transport::Play => ControlAction::PlayPause,
                    Transport::Stop | Transport::Pause => ControlAction::Stop,
                    Transport::Record => ControlAction::Record,
                },
                None,
            );
        }
        if let Some(chan) = message.channel()
            && self.channel.is_some_and(|c| c != chan)
        {
            return Routed::Ignored;
        }
        if let Some(action) = self.control_for(message) {
            return action;
        }
        if self.control_only {
            return Routed::Ignored;
        }
        Routed::Play(match message {
            MidiMessage::NoteOn { chan, key, vel } => MidiMessage::NoteOn {
                chan,
                key: self.note_for(key),
                vel: self.fixed_velocity.unwrap_or(vel),
            },
            MidiMessage::NoteOff { chan, key } => MidiMessage::NoteOff {
                chan,
                key: self.note_for(key),
            },
            MidiMessage::PolyPressure { chan, key, value } => MidiMessage::PolyPressure {
                chan,
                key: self.note_for(key),
                value,
            },
            other => other,
        })
    }

    /// The note a key plays: the pad map's target, or the key moved by the transposition.
    pub fn note_for(&self, key: u8) -> u8 {
        if let Some(route) = self.pads.iter().find(|p| p.from == key) {
            return route.to;
        }
        (key as i16 + self.transpose as i16).clamp(0, 127) as u8
    }

    fn control_for(&self, message: MidiMessage) -> Option<Routed> {
        let (source, chan, number, value) = match message {
            MidiMessage::Cc { chan, cc, value } => (ControlSource::Cc, chan, cc, value),
            MidiMessage::NoteOn { chan, key, vel } => (ControlSource::Note, chan, key, vel),
            // A mapped button's release does nothing.
            MidiMessage::NoteOff { chan, key } => {
                return self
                    .controls
                    .iter()
                    .any(|c| c.source == ControlSource::Note && c.chan == chan && c.number == key)
                    .then_some(Routed::Ignored);
            }
            _ => return None,
        };
        let control = self
            .controls
            .iter()
            .find(|c| c.source == source && c.chan == chan && c.number == number)?;
        let amount = if control.relative {
            // 64 + n turns up by n, 64 - n down by n (the common "binary offset" knobs).
            Some((value as f32 - 64.0) / 64.0)
        } else {
            Some(value as f32 / 127.0)
        };
        Some(Routed::Action(
            control.action,
            amount
                .filter(|_| is_knob(control.action))
                .map(|a| (a, control.relative)),
        ))
    }
}

/// Actions that take a value (knobs and faders); the others are buttons.
fn is_knob(action: ControlAction) -> bool {
    matches!(
        action,
        ControlAction::LaneVolume
            | ControlAction::LanePan
            | ControlAction::MasterVolume
            | ControlAction::Speed
    )
}

/// Where a device's message goes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Routed {
    /// Played on the armed lane and recorded.
    Play(MidiMessage),
    /// An app action, with the knob's value (0 … 1, or a relative step -1 … 1 with `true`).
    Action(ControlAction, Option<(f32, bool)>),
    Ignored,
}

/// A port name without a trailing instance number ("Pads 2", "Pads #2", "Pads (2)").
pub fn base_name(name: &str) -> &str {
    let trimmed = name.trim_end();
    let without = trimmed
        .trim_end_matches(')')
        .trim_end_matches(|c: char| c.is_ascii_digit());
    if without.len() == trimmed.trim_end_matches(')').len() {
        return trimmed;
    }
    without.trim_end_matches(['#', '(', ' ']).trim_end()
}

/// The settings for a port: its own, or those of the same device under another number.
pub fn settings_for<'a>(all: &'a [DeviceSettings], name: &str) -> Option<&'a DeviceSettings> {
    all.iter()
        .find(|d| d.name == name)
        .or_else(|| all.iter().find(|d| base_name(&d.name) == base_name(name)))
}

/// Ready-made pad maps for pads that send notes 36 and up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PadPreset {
    /// Each pad plays the note it sends (pads already in General MIDI drum order).
    Thru,
    /// 16 pads from note 36, bottom left first, onto a useful kit.
    GmKit,
    /// 16 pads from note 36 onto pads 36 … 51 of a pad bank.
    Chromatic,
}

/// The pad map of a preset, for pads that send `first`, `first + 1`, … .
pub fn preset_pads(preset: PadPreset, first: u8, count: usize) -> Vec<PadRoute> {
    // Kick, snare, closed hat, open hat; side stick, clap, pedal hat, crash;
    // three toms, ride; low and high floor tom, ride bell, splash.
    const KIT: [u8; 16] = [
        36, 38, 42, 46, 37, 39, 44, 49, 45, 47, 50, 51, 41, 43, 53, 55,
    ];
    (0..count.min(MAX_PAD_MAP))
        .filter_map(|i| {
            let from = first.checked_add(i as u8).filter(|n| *n <= 127)?;
            let to = match preset {
                PadPreset::Thru => from,
                PadPreset::GmKit => *KIT.get(i)?,
                PadPreset::Chromatic => 36u8.checked_add(i as u8)?,
            };
            Some(PadRoute { from, to })
        })
        .collect()
}

/// The remembered devices, in `<app data>/midi/devices.json`.
pub struct DeviceStore {
    path: PathBuf,
}

impl DeviceStore {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join("devices.json"),
        }
    }

    /// Reads the file (a missing or damaged file is no settings).
    pub fn load(&self) -> Vec<DeviceSettings> {
        fs::read_to_string(&self.path)
            .ok()
            .and_then(|json| serde_json::from_str::<Vec<DeviceSettings>>(&json).ok())
            .map(|all| {
                all.into_iter()
                    .filter(|d| d.validate().is_ok())
                    .take(MAX_DEVICES)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Writes the file atomically.
    pub fn save(&self, all: &[DeviceSettings]) -> Result<(), String> {
        let dir = self.path.parent().ok_or("no folder")?;
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
        serde_json::to_writer_pretty(&mut file, all).map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())?;
        file.persist(&self.path).map_err(|e| e.error.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on(chan: u8, key: u8, vel: u8) -> MidiMessage {
        MidiMessage::NoteOn { chan, key, vel }
    }

    #[test]
    fn pads_play_the_drum_they_are_mapped_to() {
        let mut pads = DeviceSettings::new("Pad Controller");
        pads.pads = preset_pads(PadPreset::GmKit, 36, 16);
        assert_eq!(
            pads.route(on(9, 37, 90)),
            Routed::Play(on(9, 38, 90)),
            "pad 2: snare"
        );
        assert_eq!(
            pads.route(on(9, 38, 90)),
            Routed::Play(on(9, 42, 90)),
            "pad 3: closed hat"
        );
        assert_eq!(
            pads.route(MidiMessage::NoteOff { chan: 9, key: 37 }),
            Routed::Play(MidiMessage::NoteOff { chan: 9, key: 38 }),
            "the release goes to the same drum"
        );
        assert_eq!(
            pads.route(on(9, 100, 90)),
            Routed::Play(on(9, 100, 90)),
            "unmapped notes pass"
        );
        pads.fixed_velocity = Some(127);
        assert_eq!(pads.route(on(9, 36, 5)), Routed::Play(on(9, 36, 127)));
    }

    #[test]
    fn channel_filter_transposition_and_control_only() {
        let mut keys = DeviceSettings::new("Keys");
        keys.channel = Some(0);
        keys.transpose = 12;
        assert_eq!(keys.route(on(1, 60, 90)), Routed::Ignored);
        assert_eq!(keys.route(on(0, 60, 90)), Routed::Play(on(0, 72, 90)));
        keys.control_only = true;
        assert_eq!(keys.route(on(0, 60, 90)), Routed::Ignored);
    }

    #[test]
    fn knobs_and_buttons_run_actions() {
        let mut board = DeviceSettings::new("Board");
        board.controls = vec![
            ControlMap {
                source: ControlSource::Cc,
                chan: 0,
                number: 20,
                action: ControlAction::LaneVolume,
                relative: false,
            },
            ControlMap {
                source: ControlSource::Note,
                chan: 0,
                number: 60,
                action: ControlAction::Record,
                relative: false,
            },
            ControlMap {
                source: ControlSource::Cc,
                chan: 0,
                number: 21,
                action: ControlAction::Speed,
                relative: true,
            },
        ];
        let cc = |number, value| MidiMessage::Cc {
            chan: 0,
            cc: number,
            value,
        };
        assert_eq!(
            board.route(cc(20, 127)),
            Routed::Action(ControlAction::LaneVolume, Some((1.0, false)))
        );
        assert_eq!(
            board.route(cc(21, 66)),
            Routed::Action(ControlAction::Speed, Some((2.0 / 64.0, true)))
        );
        assert_eq!(
            board.route(on(0, 60, 100)),
            Routed::Action(ControlAction::Record, None)
        );
        assert_eq!(
            board.route(MidiMessage::NoteOff { chan: 0, key: 60 }),
            Routed::Ignored
        );
        assert_eq!(
            board.route(MidiMessage::Transport(Transport::Play)),
            Routed::Action(ControlAction::PlayPause, None)
        );
        assert_eq!(
            board.route(cc(7, 1)),
            Routed::Play(cc(7, 1)),
            "other controllers play"
        );
    }

    #[test]
    fn matches_a_device_under_another_number() {
        let all = vec![DeviceSettings::new("Pad Controller 2")];
        assert_eq!(base_name("Pad Controller 2"), "Pad Controller");
        assert_eq!(base_name("Pad Controller #3"), "Pad Controller");
        assert_eq!(base_name("Pads (2)"), "Pads");
        assert_eq!(base_name("Keys"), "Keys");
        assert!(settings_for(&all, "Pad Controller").is_some());
        assert!(settings_for(&all, "Pad Controller 5").is_some());
        assert!(settings_for(&all, "Other").is_none());
    }

    #[test]
    fn presets_and_storage() {
        assert_eq!(
            preset_pads(PadPreset::Chromatic, 36, 2),
            vec![PadRoute { from: 36, to: 36 }, PadRoute { from: 37, to: 37 }]
        );
        assert_eq!(
            preset_pads(PadPreset::GmKit, 120, 16).len(),
            8,
            "stops at note 127"
        );
        let dir = tempfile::tempdir().unwrap();
        let store = DeviceStore::new(dir.path());
        assert!(store.load().is_empty());
        let mut d = DeviceSettings::new("Kit");
        d.offset_ms = -12.0;
        store.save(std::slice::from_ref(&d)).unwrap();
        assert_eq!(store.load(), vec![d.clone()]);
        let mut bad = d;
        bad.offset_ms = 9_999.0;
        assert!(bad.validate().is_err());
    }
}
