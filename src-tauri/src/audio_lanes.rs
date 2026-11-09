//! Audio lanes: clips of audio files next to the tab tracks (settings version 3).
//!
//! Mirrored by `AudioLanesSettings` and its parts in `src/lib/tauri.ts`; the pure edits live in
//! `src/lib/audio-lanes/`. Clips sit on an audio timeline in milliseconds, which the song's sync
//! points map onto the score, so the speed trainer and tempo changes keep them on the bar grid.
//! An old single audio track (versions 1 and 2) is read once and becomes one lane with one clip.

use serde::{Deserialize, Serialize};

use crate::audio::backing::BackingParams;
use crate::audio::chain::{EffectSlot, MAX_TRACK_EFFECTS};
use crate::mixer::{AudioTrack, SyncPoint};

/// The most lanes a song can have.
pub const MAX_LANES: usize = 16;
/// The most buses lane sends can feed.
pub const MAX_BUSES: usize = 4;
/// Upper bounds that keep a damaged file from exhausting memory.
pub const MAX_CLIPS: usize = 2_000;
pub const MAX_TAKES: usize = 64;
pub const MAX_SOURCES: usize = 512;
pub const MAX_POINTS: usize = 4_096;
/// The longest timeline position or clip, in ms (a day).
const MAX_MS: f64 = 86_400_000.0;
/// A clip of an old audio track plays its whole file: no file the decoder accepts is longer.
const LEGACY_CLIP_MS: f64 = 30.0 * 60.0 * 1_000.0;

/// The curve of a clip fade.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FadeShape {
    #[default]
    Linear,
    EqualPower,
    SCurve,
}

impl FadeShape {
    /// The gain at `x` (0 … 1) along a fade in.
    pub fn gain(self, x: f32) -> f32 {
        let x = x.clamp(0.0, 1.0);
        match self {
            Self::Linear => x,
            Self::EqualPower => (x * std::f32::consts::FRAC_PI_2).sin(),
            Self::SCurve => x * x * (3.0 - 2.0 * x),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipFade {
    pub ms: f64,
    pub shape: FadeShape,
}

/// A point of a clip's gain envelope: `at` 0 … 1 along the clip, gain in dB.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GainPoint {
    pub at: f64,
    pub db: f64,
}

/// Source time `source_ms` plays at `clip_ms` into the clip.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StretchMarker {
    pub source_ms: f64,
    pub clip_ms: f64,
}

/// One recorded pass of a clip.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTake {
    pub name: String,
    pub source_id: String,
    pub offset_ms: f64,
}

/// A piece of a source on a lane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioClip {
    pub id: String,
    pub takes: Vec<AudioTake>,
    #[serde(default)]
    pub take: usize,
    pub start_ms: f64,
    pub length_ms: f64,
    #[serde(default)]
    pub gain_db: f64,
    #[serde(default)]
    pub mute: bool,
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub reversed: bool,
    #[serde(default)]
    pub semitones: i32,
    #[serde(default)]
    pub cents: i32,
    #[serde(default = "one")]
    pub playrate: f64,
    #[serde(default = "yes")]
    pub preserve_pitch: bool,
    #[serde(default)]
    pub fade_in: ClipFade,
    #[serde(default)]
    pub fade_out: ClipFade,
    #[serde(default)]
    pub envelope: Vec<GainPoint>,
    #[serde(default)]
    pub stretch: Vec<StretchMarker>,
}

fn one() -> f64 {
    1.0
}
fn yes() -> bool {
    true
}

impl AudioClip {
    /// The take the clip plays.
    pub fn active_take(&self) -> &AudioTake {
        self.takes.get(self.take).unwrap_or(&self.takes[0])
    }
    /// Where the clip ends on the timeline.
    pub fn end_ms(&self) -> f64 {
        self.start_ms + self.length_ms / self.playrate
    }
    /// Source speed against the timeline when it keeps its pitch: the pitch ratio of semitones
    /// and cents (the stretcher keeps the playrate from changing it).
    pub fn pitch_ratio(&self, extra_semitones: i32) -> f64 {
        let cents = (self.semitones + extra_semitones) as f64 * 100.0 + self.cents as f64;
        2f64.powf(cents / 1_200.0)
    }
}

/// An audio file that clips play.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSource {
    /// SHA-256 of the file (hex), or `legacy-…` for an old audio track's file.
    pub id: String,
    pub name: String,
    pub ext: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub embedded: bool,
    /// The entry name an old audio track used inside the song file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_entry: Option<String>,
}

impl AudioSource {
    /// The entry of an embedded source inside a `.gp` file, under `SmartBeat/audio/`.
    pub fn entry_name(&self) -> String {
        format!("{}.{}", self.id, self.ext)
    }
}

/// One effect parameter changed along the song.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectAutomation {
    pub slot: usize,
    pub param: String,
    pub points: Vec<AutomationValue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationValue {
    pub tick: f64,
    pub value: f64,
}

/// Part of a lane sent to a bus.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneSend {
    pub bus: String,
    pub level: f32,
}

/// A lane of audio clips.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLane {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(flatten)]
    pub params: BackingParams,
    #[serde(default = "yes")]
    pub follow_transposition: bool,
    #[serde(default)]
    pub effects: Vec<EffectSlot>,
    #[serde(default)]
    pub auto_bypass: bool,
    #[serde(default)]
    pub automation: Vec<EffectAutomation>,
    #[serde(default)]
    pub sends: Vec<LaneSend>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(default)]
    pub folder: bool,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub group: u32,
    #[serde(default)]
    pub clips: Vec<AudioClip>,
}

/// A bus that lane sends feed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioBus {
    pub id: String,
    pub name: String,
    pub volume: f32,
    #[serde(default)]
    pub mute: bool,
    #[serde(default)]
    pub effects: Vec<EffectSlot>,
}

/// The play zone brackets, in bars.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Zone {
    pub start: u32,
    pub end: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RippleMode {
    #[default]
    Off,
    Lane,
    All,
}

/// The audio side of a song.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioLanes {
    pub lanes: Vec<AudioLane>,
    pub sources: Vec<AudioSource>,
    pub buses: Vec<AudioBus>,
    pub sync: Vec<SyncPoint>,
    pub zone: Zone,
    pub ripple: RippleMode,
}

fn finite_in(value: f64, min: f64, max: f64) -> bool {
    value.is_finite() && (min..=max).contains(&value)
}

fn check_id(id: &str, what: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!("invalid {what} id"))
    }
}

impl AudioClip {
    fn validate(&self, sources: &[AudioSource]) -> Result<(), String> {
        check_id(&self.id, "clip")?;
        if self.takes.is_empty() || self.takes.len() > MAX_TAKES || self.take >= self.takes.len() {
            return Err("a clip needs one to 64 takes".into());
        }
        if self.takes.iter().any(|t| {
            !sources.iter().any(|s| s.id == t.source_id) || !finite_in(t.offset_ms, 0.0, MAX_MS)
        }) {
            return Err("a clip plays an unknown source".into());
        }
        if !finite_in(self.start_ms, 0.0, MAX_MS) || !finite_in(self.length_ms, 1.0, MAX_MS) {
            return Err("clip position out of range".into());
        }
        if !finite_in(self.playrate, 0.25, 4.0) || !finite_in(self.gain_db, -60.0, 24.0) {
            return Err("clip playrate or gain out of range".into());
        }
        if !(-24..=24).contains(&self.semitones) || !(-100..=100).contains(&self.cents) {
            return Err("clip transposition out of range".into());
        }
        if !finite_in(self.fade_in.ms, 0.0, self.length_ms)
            || !finite_in(self.fade_out.ms, 0.0, self.length_ms)
        {
            return Err("clip fade longer than the clip".into());
        }
        if self.envelope.len() > MAX_POINTS || self.stretch.len() > MAX_POINTS {
            return Err("too many clip points".into());
        }
        if self
            .envelope
            .iter()
            .any(|p| !finite_in(p.at, 0.0, 1.0) || !finite_in(p.db, -60.0, 24.0))
        {
            return Err("clip envelope out of range".into());
        }
        if self
            .stretch
            .iter()
            .any(|m| !finite_in(m.source_ms, 0.0, MAX_MS) || !finite_in(m.clip_ms, 0.0, MAX_MS))
        {
            return Err("clip stretch marker out of range".into());
        }
        Ok(())
    }
}

impl AudioLane {
    fn validate(&self, sources: &[AudioSource], buses: &[AudioBus]) -> Result<(), String> {
        check_id(&self.id, "lane")?;
        if self.name.chars().count() > 200 {
            return Err("lane name too long".into());
        }
        if let Some(color) = &self.color {
            let hex = color.len() == 7
                && color.starts_with('#')
                && color[1..].chars().all(|c| c.is_ascii_hexdigit());
            if !hex {
                return Err("lane colour must be #rrggbb".into());
            }
        }
        self.params.validate()?;
        if self.effects.len() > MAX_TRACK_EFFECTS {
            return Err(format!("lane: more than {MAX_TRACK_EFFECTS} effects"));
        }
        if self.clips.len() > MAX_CLIPS || self.automation.len() > MAX_POINTS {
            return Err("too many clips or automations on a lane".into());
        }
        if self
            .automation
            .iter()
            .any(|a| a.slot >= MAX_TRACK_EFFECTS || a.points.len() > MAX_POINTS)
        {
            return Err("invalid lane automation".into());
        }
        if self
            .sends
            .iter()
            .any(|s| !buses.iter().any(|b| b.id == s.bus) || !(0.0..=1.0).contains(&s.level))
        {
            return Err("invalid lane send".into());
        }
        self.clips.iter().try_for_each(|c| c.validate(sources))
    }
}

impl AudioLanes {
    /// Checks every value is in range and every reference points at something.
    pub fn validate(&self) -> Result<(), String> {
        if self.lanes.len() > MAX_LANES
            || self.buses.len() > MAX_BUSES
            || self.sources.len() > MAX_SOURCES
        {
            return Err("too many lanes, buses or audio files".into());
        }
        if self.sync.len() > 10_000 || self.sync.iter().any(|p| !finite_in(p.ms, 0.0, 1.0e9)) {
            return Err("invalid audio sync points".into());
        }
        for source in &self.sources {
            if !source.id.starts_with("legacy-")
                && (source.id.len() != 64 || !source.id.chars().all(|c| c.is_ascii_hexdigit()))
            {
                return Err("invalid audio file id".into());
            }
            let ext_ok = !source.ext.is_empty()
                && source.ext.len() <= 5
                && source.ext.chars().all(|c| c.is_ascii_alphanumeric());
            if !ext_ok || source.name.chars().count() > 255 {
                return Err("invalid audio file name".into());
            }
        }
        for bus in &self.buses {
            check_id(&bus.id, "bus")?;
            if !(0.0..=1.0).contains(&bus.volume) || bus.effects.len() > MAX_TRACK_EFFECTS {
                return Err("invalid bus".into());
            }
        }
        for lane in &self.lanes {
            lane.validate(&self.sources, &self.buses)?;
            if let Some(parent) = &lane.parent
                && !self
                    .lanes
                    .iter()
                    .any(|l| &l.id == parent && l.folder && l.id != lane.id)
            {
                return Err("a lane sits in a missing folder".into());
            }
        }
        Ok(())
    }

    /// The sources a clip plays: the only ones a save keeps.
    pub fn used_sources(&self) -> impl Iterator<Item = &AudioSource> {
        self.sources.iter().filter(|s| {
            self.lanes
                .iter()
                .flat_map(|l| &l.clips)
                .flat_map(|c| &c.takes)
                .any(|t| t.source_id == s.id)
        })
    }
}

/// The source id an old audio track's file gets (FNV-1a of its name, as the frontend does).
pub fn legacy_source_id(name: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for c in name.chars() {
        hash = (hash ^ c as u32).wrapping_mul(0x0100_0193);
    }
    format!("legacy-{hash:08x}")
}

/// One lane with one clip for an old single audio track (one way: saves write lanes only).
pub fn migrate_audio_track(track: &AudioTrack) -> AudioLanes {
    let source_id = legacy_source_id(&track.name);
    let ext = track
        .name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .filter(|e| !e.is_empty() && e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or_else(|| "wav".into());
    let lane_id = format!("{source_id}-lane");
    let clip = AudioClip {
        id: format!("{source_id}-clip"),
        takes: vec![AudioTake {
            name: track.name.clone(),
            source_id: source_id.clone(),
            offset_ms: 0.0,
        }],
        take: 0,
        start_ms: 0.0,
        length_ms: LEGACY_CLIP_MS,
        gain_db: 0.0,
        mute: false,
        locked: false,
        reversed: false,
        semitones: 0,
        cents: 0,
        playrate: 1.0,
        preserve_pitch: true,
        fade_in: ClipFade::default(),
        fade_out: ClipFade::default(),
        envelope: Vec::new(),
        stretch: Vec::new(),
    };
    let lane = AudioLane {
        id: lane_id,
        name: track.name.clone(),
        color: None,
        params: track.params.clone(),
        follow_transposition: true,
        effects: Vec::new(),
        auto_bypass: false,
        automation: Vec::new(),
        sends: Vec::new(),
        parent: None,
        folder: false,
        collapsed: false,
        group: 0,
        clips: vec![clip],
    };
    let mut sync = track.sync.clone();
    sync.sort_by_key(|p| p.bar);
    sync.dedup_by_key(|p| p.bar);
    AudioLanes {
        lanes: vec![lane],
        sources: vec![AudioSource {
            id: source_id,
            name: track.name.clone(),
            ext,
            path: track.path.clone(),
            embedded: track.embedded,
            legacy_entry: track.embedded.then(|| track.name.clone()),
        }],
        buses: Vec::new(),
        sync,
        zone: Zone::default(),
        ripple: RippleMode::Off,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track() -> AudioTrack {
        AudioTrack {
            name: "Backing.mp3".into(),
            path: Some("/music/Backing.mp3".into()),
            embedded: true,
            params: BackingParams {
                volume: 0.5,
                semitones: -3,
                ..Default::default()
            },
            sync: vec![
                SyncPoint {
                    bar: 4,
                    ms: 9_000.0,
                    beat: None,
                },
                SyncPoint {
                    bar: 0,
                    ms: 1_000.0,
                    beat: None,
                },
            ],
        }
    }

    #[test]
    fn migrates_the_old_track_to_one_lane_with_one_clip() {
        let audio = migrate_audio_track(&track());
        assert_eq!(audio.lanes.len(), 1);
        let lane = &audio.lanes[0];
        assert_eq!(lane.params.volume, 0.5);
        assert_eq!(lane.params.semitones, -3);
        assert_eq!(lane.clips.len(), 1);
        assert_eq!(audio.sync.iter().map(|p| p.bar).collect::<Vec<_>>(), [0, 4]);
        assert_eq!(
            audio.sources[0].legacy_entry.as_deref(),
            Some("Backing.mp3")
        );
        assert_eq!(audio.sources[0].ext, "mp3");
        assert_eq!(audio.validate(), Ok(()));
    }

    #[test]
    fn version_two_settings_migrate_once_and_never_write_the_old_field() {
        use crate::mixer::{MixerSettings, VERSION};
        let json = r#"{"version":2,"master":1,"tracks":[],"audioTrack":{"name":"a.wav","embedded":true,
            "enabled":true,"volume":0.7,"pan":0,"mute":false,"solo":false,
            "eq":{"lowDb":0,"midDb":0,"midHz":1000,"highDb":0},"semitones":2,"cents":0,"filter":"off",
            "sync":[{"bar":1,"ms":2000}]}}"#;
        let settings: MixerSettings = serde_json::from_str(json).unwrap();
        settings.validate().unwrap();
        let migrated = settings.migrate();
        assert_eq!(migrated.version, VERSION);
        assert!(migrated.audio_track.is_none());
        let audio = migrated.audio.as_ref().unwrap();
        assert_eq!(audio.lanes[0].params.semitones, 2);
        assert_eq!(audio.sync[0].ms, 2_000.0);
        let written = serde_json::to_value(&migrated).unwrap();
        assert!(written.get("audioTrack").is_none());
        assert_eq!(written["audio"]["lanes"][0]["volume"], 0.7f32 as f64);
        migrated.validate().unwrap();
    }

    #[test]
    fn a_song_without_audio_gets_no_lanes() {
        let settings: crate::mixer::MixerSettings =
            serde_json::from_str(r#"{"version":1,"master":1,"tracks":[]}"#).unwrap();
        assert!(settings.migrate().audio.is_none());
    }

    #[test]
    fn legacy_ids_match_the_frontend() {
        // `legacySourceId("x.wav")` in src/lib/audio-lanes/model.ts.
        assert_eq!(legacy_source_id("x.wav"), legacy_source_id("x.wav"));
        assert_ne!(legacy_source_id("x.wav"), legacy_source_id("y.wav"));
        assert!(legacy_source_id("x.wav").starts_with("legacy-"));
    }

    #[test]
    fn rejects_dangling_references_and_bad_values() {
        let mut audio = migrate_audio_track(&track());
        audio.lanes[0].clips[0].takes[0].source_id = "missing".into();
        assert!(audio.validate().is_err());
        let mut audio = migrate_audio_track(&track());
        audio.lanes[0].parent = Some("nope".into());
        assert!(audio.validate().is_err());
        let mut audio = migrate_audio_track(&track());
        audio.lanes[0].clips[0].playrate = 9.0;
        assert!(audio.validate().is_err());
        let mut audio = migrate_audio_track(&track());
        audio.sources[0].id = "../../etc".into();
        assert!(audio.validate().is_err());
        let mut audio = migrate_audio_track(&track());
        audio.lanes[0].color = Some("red".into());
        assert!(audio.validate().is_err());
    }

    #[test]
    fn keeps_only_sources_a_clip_plays() {
        let mut audio = migrate_audio_track(&track());
        let mut unused = audio.sources[0].clone();
        unused.id = "a".repeat(64);
        audio.sources.push(unused);
        assert_eq!(audio.used_sources().count(), 1);
    }

    #[test]
    fn fade_shapes_start_silent_and_end_full() {
        for shape in [FadeShape::Linear, FadeShape::EqualPower, FadeShape::SCurve] {
            assert_eq!(shape.gain(0.0), 0.0);
            assert!((shape.gain(1.0) - 1.0).abs() < 1e-6);
        }
        assert!(FadeShape::EqualPower.gain(0.5) > FadeShape::Linear.gain(0.5));
    }
}
