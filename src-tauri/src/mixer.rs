//! Per-song mixer settings: volume, pan, mute and solo, effect chains and
//! sounds, channel EQ, automation, the drum mixer, the audio track and chain
//! presets.
//!
//! Saved `.gp` files carry them inside (see `project.rs`). They are also
//! stored as JSON files in the app data folder, keyed by the SHA-256 of the
//! song file's content, so songs in other formats keep their mix too.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::audio::backing::BackingParams;
use crate::audio::chain::{EffectSlot, MAX_MASTER_EFFECTS, MAX_TRACK_EFFECTS};
use crate::audio::engine::MAX_SOUNDS;
use crate::audio::mixing::TrackEq;
use crate::error::{CommandError, ErrorKind};

/// Current settings format. Version 1 files (before sounds, EQ, automation,
/// the drum mixer and the audio track) still load; other versions are ignored.
pub const VERSION: u32 = 2;
/// Oldest version still read.
pub const MIN_VERSION: u32 = 1;
/// Upper bounds that keep a damaged file from exhausting memory.
pub const MAX_AUTOMATION_POINTS: usize = 4_096;
pub const MAX_PRESETS: usize = 200;
pub const MAX_DRUM_ELEMENTS: usize = 24;
const MAX_NAME: usize = 120;

/// Upper bound on tracks per song, well above what Guitar Pro allows.
pub const MAX_TRACKS: usize = 256;

/// The mixer state of one song. Mirrored by `MixerSettings` in `src/lib/tauri.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixerSettings {
    pub version: u32,
    /// Master volume, 0.0 (silent) to 1.0 (full).
    pub master: f64,
    /// One entry per track, in score order.
    pub tracks: Vec<TrackMix>,
    /// Effect chain of each track, in score order (missing: no effects).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<Vec<EffectSlot>>,
    /// Effect chain of the master bus.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub master_effects: Vec<EffectSlot>,
    /// How each track is played back (style, palm mute, accents, let ring, brush).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub interpretation: Vec<Interpretation>,
    /// Master pan, -1…1.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub master_pan: f64,
    /// Sounds of each track (several effect chains switched by automation).
    /// Empty for a track with one sound (its chain is `effects`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sounds: Vec<TrackSounds>,
    /// Channel EQ of each track.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub eq: Vec<TrackEq>,
    /// Volume, pan and mute automation of each track.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub automation: Vec<TrackAutomation>,
    /// The track in focus (the others are turned down).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<usize>,
    /// Drum mixer of each track (`null` for tracks that are not drums or not split).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub drums: Vec<Option<DrumMixer>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_track: Option<AudioTrack>,
    /// Effect chain presets saved with the song.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub presets: Vec<ChainPreset>,
}

fn is_zero(value: &f64) -> bool {
    *value == 0.0
}

/// One sound of a track: a named effect chain.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sound {
    pub name: String,
    pub effects: Vec<EffectSlot>,
}

/// "From bar `bar` (0-based) on, play sound `sound`."
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundSwitch {
    pub bar: u32,
    pub sound: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackSounds {
    pub sounds: Vec<Sound>,
    #[serde(default)]
    pub switches: Vec<SoundSwitch>,
}

/// An automation point: a position in bars (0-based, fractional) and a value.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationPoint {
    pub bar: f64,
    pub value: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrackAutomation {
    pub enabled: bool,
    /// 0…1.
    pub volume: Vec<AutomationPoint>,
    /// -1…1.
    pub pan: Vec<AutomationPoint>,
    /// 0 (on) or 1 (muted).
    pub mute: Vec<AutomationPoint>,
}

/// Mix of one drum kit element (snare, hi-hat, kick, …).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrumElementMix {
    pub id: String,
    pub volume: f64,
    pub pan: f64,
    pub mute: bool,
    pub solo: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrumMixer {
    pub stereo: bool,
    pub elements: Vec<DrumElementMix>,
}

/// A sync point: bar `bar` (0-based) starts at `ms` in the recording.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPoint {
    pub bar: u32,
    pub ms: f64,
}

/// The audio track of a song.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrack {
    /// File name of the recording.
    pub name: String,
    /// Where the recording is on disk (when it is not embedded).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// The recording is stored inside the song file.
    #[serde(default)]
    pub embedded: bool,
    #[serde(flatten)]
    pub params: BackingParams,
    #[serde(default)]
    pub sync: Vec<SyncPoint>,
}

/// An effect chain preset stored in the song.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainPreset {
    pub name: String,
    /// "guitar", "bass", "drums" or "master".
    pub target: String,
    pub effects: Vec<EffectSlot>,
}

fn check_name(name: &str, what: &str) -> Result<(), String> {
    if name.chars().count() > MAX_NAME {
        return Err(format!("{what} name is too long"));
    }
    Ok(())
}

/// Playing style of a track. Mirrored by `PlayingStyle` in `src/lib/score/interpretation.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlayingStyle {
    Pick,
    Fingers,
    Slap,
}

/// How a track is played back. Mirrored by `Interpretation` in `src/lib/score/interpretation.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Interpretation {
    pub style: PlayingStyle,
    /// 0.0 … 1.0.
    pub palm_mute: f64,
    /// 0.0 … 1.0.
    pub accent: f64,
    pub let_ring: bool,
    pub brush: bool,
}

/// Mixer state of one track.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMix {
    /// 0.0 (silent) to 1.0 (full).
    pub volume: f64,
    /// -1.0 (left) to 1.0 (right), 0.0 is centre.
    pub pan: f64,
    pub mute: bool,
    pub solo: bool,
}

impl MixerSettings {
    /// Checks the version and that every value is in range.
    pub fn validate(&self) -> Result<(), String> {
        if !(MIN_VERSION..=VERSION).contains(&self.version) {
            return Err(format!("unsupported settings version {}", self.version));
        }
        self.validate_v2()?;
        if self.tracks.len() > MAX_TRACKS {
            return Err(format!("more than {MAX_TRACKS} tracks"));
        }
        if !in_range(self.master, 0.0, 1.0) {
            return Err("master volume must be between 0 and 1".into());
        }
        if self.effects.len() > self.tracks.len() {
            return Err("more effect chains than tracks".into());
        }
        if let Some(index) = self
            .effects
            .iter()
            .position(|c| c.len() > MAX_TRACK_EFFECTS)
        {
            return Err(format!(
                "track {index}: more than {MAX_TRACK_EFFECTS} effects"
            ));
        }
        if self.master_effects.len() > MAX_MASTER_EFFECTS {
            return Err(format!("more than {MAX_MASTER_EFFECTS} master effects"));
        }
        if self.interpretation.len() > self.tracks.len() {
            return Err("more interpretations than tracks".into());
        }
        for (index, i) in self.interpretation.iter().enumerate() {
            if !in_range(i.palm_mute, 0.0, 1.0) || !in_range(i.accent, 0.0, 1.0) {
                return Err(format!("track {index}: interpretation out of range"));
            }
        }
        for (index, track) in self.tracks.iter().enumerate() {
            if !in_range(track.volume, 0.0, 1.0) {
                return Err(format!("track {index}: volume must be between 0 and 1"));
            }
            if !in_range(track.pan, -1.0, 1.0) {
                return Err(format!("track {index}: pan must be between -1 and 1"));
            }
        }
        Ok(())
    }
}

impl MixerSettings {
    fn validate_v2(&self) -> Result<(), String> {
        let tracks = self.tracks.len();
        if !in_range(self.master_pan, -1.0, 1.0) {
            return Err("master pan must be between -1 and 1".into());
        }
        for (what, len) in [
            ("sound lists", self.sounds.len()),
            ("EQs", self.eq.len()),
            ("automations", self.automation.len()),
            ("drum mixers", self.drums.len()),
        ] {
            if len > tracks {
                return Err(format!("more {what} than tracks"));
            }
        }
        if self.focus.is_some_and(|f| f >= tracks) {
            return Err("the focused track does not exist".into());
        }
        for (index, sounds) in self.sounds.iter().enumerate() {
            if sounds.sounds.len() > MAX_SOUNDS {
                return Err(format!("track {index}: more than {MAX_SOUNDS} sounds"));
            }
            for sound in &sounds.sounds {
                check_name(&sound.name, "sound")?;
                if sound.effects.len() > MAX_TRACK_EFFECTS {
                    return Err(format!(
                        "track {index}: more than {MAX_TRACK_EFFECTS} effects"
                    ));
                }
            }
            if sounds.switches.len() > MAX_AUTOMATION_POINTS
                || sounds
                    .switches
                    .iter()
                    .any(|s| s.sound >= sounds.sounds.len().max(1))
            {
                return Err(format!("track {index}: invalid sound switch"));
            }
        }
        for (index, eq) in self.eq.iter().enumerate() {
            eq.validate().map_err(|e| format!("track {index}: {e}"))?;
        }
        for (index, automation) in self.automation.iter().enumerate() {
            for (lane, min, max) in [
                (&automation.volume, 0.0, 1.0),
                (&automation.pan, -1.0, 1.0),
                (&automation.mute, 0.0, 1.0),
            ] {
                if lane.len() > MAX_AUTOMATION_POINTS
                    || lane
                        .iter()
                        .any(|p| !in_range(p.bar, 0.0, 100_000.0) || !in_range(p.value, min, max))
                {
                    return Err(format!("track {index}: automation out of range"));
                }
            }
        }
        for (index, drums) in self.drums.iter().enumerate() {
            let Some(drums) = drums else { continue };
            if drums.elements.len() > MAX_DRUM_ELEMENTS {
                return Err(format!("track {index}: too many drum elements"));
            }
            for e in &drums.elements {
                check_name(&e.id, "drum element")?;
                if !in_range(e.volume, 0.0, 1.0) || !in_range(e.pan, -1.0, 1.0) {
                    return Err(format!("track {index}: drum mixer out of range"));
                }
            }
        }
        if let Some(audio) = &self.audio_track {
            check_name(&audio.name, "audio file")?;
            audio.params.validate()?;
            if audio.sync.len() > 10_000 || audio.sync.iter().any(|p| !in_range(p.ms, 0.0, 1.0e9)) {
                return Err("invalid audio track sync points".into());
            }
        }
        if self.presets.len() > MAX_PRESETS {
            return Err(format!("more than {MAX_PRESETS} presets"));
        }
        for preset in &self.presets {
            check_name(&preset.name, "preset")?;
            if preset.effects.len() > MAX_TRACK_EFFECTS {
                return Err("a preset has too many effects".into());
            }
        }
        Ok(())
    }
}

fn in_range(value: f64, min: f64, max: f64) -> bool {
    value.is_finite() && (min..=max).contains(&value)
}

/// A song's settings key: the lowercase hex SHA-256 of its content. Parsing it
/// strictly also rules out path traversal, since the key becomes a file name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileKey(String);

impl FileKey {
    pub fn parse(key: &str) -> Result<Self, CommandError> {
        let valid = key.len() == 64
            && key
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if valid {
            Ok(Self(key.to_owned()))
        } else {
            Err(CommandError::new(
                ErrorKind::InvalidKey,
                "The song key must be a lowercase SHA-256 hex digest.",
            ))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Reads and writes [`MixerSettings`] as `<dir>/<key>.json`. Stored as Tauri state.
#[derive(Debug, Clone)]
pub struct MixerStore {
    dir: PathBuf,
}

impl MixerStore {
    /// The folder is created on the first save.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path(&self, key: &FileKey) -> PathBuf {
        self.dir.join(format!("{}.json", key.as_str()))
    }

    /// Saved settings for a song, or `None` if there are none. Damaged or
    /// outdated files are ignored rather than blocking the song from opening.
    pub fn load(&self, key: &FileKey) -> Result<Option<MixerSettings>, CommandError> {
        let path = self.path(key);
        let json = match fs::read_to_string(&path) {
            Ok(json) => json,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_error(&error)),
        };
        let settings = serde_json::from_str::<MixerSettings>(&json)
            .map_err(|error| error.to_string())
            .and_then(|settings| settings.validate().map(|()| settings));
        match settings {
            Ok(settings) => Ok(Some(settings)),
            Err(reason) => {
                eprintln!("ignoring mixer settings {}: {reason}", path.display());
                Ok(None)
            }
        }
    }

    /// Saves settings atomically: a crash mid-write never leaves a torn file.
    pub fn save(&self, key: &FileKey, settings: &MixerSettings) -> Result<(), CommandError> {
        settings
            .validate()
            .map_err(|reason| CommandError::new(ErrorKind::InvalidSettings, reason))?;

        fs::create_dir_all(&self.dir).map_err(|error| io_error(&error))?;
        let mut file = tempfile::NamedTempFile::new_in(&self.dir).map_err(|e| io_error(&e))?;
        serde_json::to_writer_pretty(&mut file, settings)
            .map_err(io::Error::from)
            .and_then(|()| file.flush())
            .map_err(|error| io_error(&error))?;
        file.persist(self.path(key))
            .map_err(|error| io_error(&error.error))?;
        Ok(())
    }
}

fn io_error(error: &io::Error) -> CommandError {
    CommandError::new(
        ErrorKind::Io,
        format!("Mixer settings could not be saved or loaded: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

    fn key() -> FileKey {
        FileKey::parse(KEY).unwrap()
    }

    fn settings() -> MixerSettings {
        MixerSettings {
            version: VERSION,
            master: 0.8,
            tracks: vec![
                TrackMix {
                    volume: 0.75,
                    pan: -0.5,
                    mute: false,
                    solo: true,
                },
                TrackMix {
                    volume: 0.0,
                    pan: 1.0,
                    mute: true,
                    solo: false,
                },
            ],
            effects: Vec::new(),
            master_effects: Vec::new(),
            interpretation: Vec::new(),
            master_pan: 0.0,
            sounds: Vec::new(),
            eq: Vec::new(),
            automation: Vec::new(),
            focus: None,
            drums: Vec::new(),
            audio_track: None,
            presets: Vec::new(),
        }
    }

    #[test]
    fn accepts_values_in_range() {
        assert_eq!(settings().validate(), Ok(()));
        let empty = MixerSettings {
            tracks: vec![],
            ..settings()
        };
        assert_eq!(empty.validate(), Ok(()));
    }

    #[test]
    fn stores_effect_chains_and_reads_files_without_them() {
        use crate::audio::chain::{EffectConfig, EffectSlot};
        use crate::audio::dsp::gate::GateParams;
        let gate = EffectSlot {
            enabled: true,
            effect: EffectConfig::Gate(GateParams::default()),
        };
        let with_effects = MixerSettings {
            effects: vec![vec![gate.clone()], vec![]],
            master_effects: vec![gate.clone()],
            ..settings()
        };
        assert_eq!(with_effects.validate(), Ok(()));
        let json = serde_json::to_string(&with_effects).unwrap();
        assert!(json.contains(r#""masterEffects":[{"#));
        assert_eq!(
            serde_json::from_str::<MixerSettings>(&json).unwrap(),
            with_effects
        );
        // Files written before effects existed still load.
        let old: MixerSettings =
            serde_json::from_str(r#"{"version":1,"master":1,"tracks":[]}"#).unwrap();
        assert!(old.effects.is_empty() && old.master_effects.is_empty());
        // Limits.
        let too_many = MixerSettings {
            master_effects: vec![gate.clone(); 4],
            ..settings()
        };
        assert!(too_many.validate().unwrap_err().contains("master effects"));
        let long_chain = MixerSettings {
            effects: vec![vec![gate; 7]],
            ..settings()
        };
        assert!(long_chain.validate().unwrap_err().contains("track 0"));
    }

    #[test]
    fn stores_the_interpretation_of_tracks() {
        let style = Interpretation {
            style: PlayingStyle::Fingers,
            palm_mute: 0.8,
            accent: 0.2,
            let_ring: true,
            brush: false,
        };
        let with = MixerSettings {
            interpretation: vec![style],
            ..settings()
        };
        assert_eq!(with.validate(), Ok(()));
        let json = serde_json::to_string(&with).unwrap();
        assert!(json.contains(r#""style":"fingers""#) && json.contains(r#""letRing":true"#));
        assert_eq!(serde_json::from_str::<MixerSettings>(&json).unwrap(), with);
        let bad = MixerSettings {
            interpretation: vec![Interpretation {
                accent: 2.0,
                ..style
            }],
            ..settings()
        };
        assert!(bad.validate().unwrap_err().contains("interpretation"));
    }

    fn full() -> MixerSettings {
        use crate::audio::backing::BackingFilter;
        use crate::audio::chain::{EffectConfig, EffectSlot};
        use crate::audio::dsp::delay::DelayParams;
        let delay = EffectSlot {
            enabled: true,
            effect: EffectConfig::Delay(DelayParams::default()),
        };
        MixerSettings {
            master_pan: -0.25,
            sounds: vec![TrackSounds {
                sounds: vec![
                    Sound {
                        name: "Clean".into(),
                        effects: vec![],
                    },
                    Sound {
                        name: "Lead".into(),
                        effects: vec![delay.clone()],
                    },
                ],
                switches: vec![SoundSwitch { bar: 4, sound: 1 }],
            }],
            eq: vec![TrackEq {
                low_db: 3.0,
                ..Default::default()
            }],
            automation: vec![
                TrackAutomation::default(),
                TrackAutomation {
                    enabled: true,
                    volume: vec![
                        AutomationPoint {
                            bar: 0.0,
                            value: 1.0,
                        },
                        AutomationPoint {
                            bar: 2.5,
                            value: 0.2,
                        },
                    ],
                    pan: vec![AutomationPoint {
                        bar: 1.0,
                        value: -1.0,
                    }],
                    mute: vec![AutomationPoint {
                        bar: 3.0,
                        value: 1.0,
                    }],
                },
            ],
            focus: Some(1),
            drums: vec![
                None,
                Some(DrumMixer {
                    stereo: false,
                    elements: vec![DrumElementMix {
                        id: "snare".into(),
                        volume: 0.8,
                        pan: 0.3,
                        mute: false,
                        solo: true,
                    }],
                }),
            ],
            audio_track: Some(AudioTrack {
                name: "backing.mp3".into(),
                path: Some("/music/backing.mp3".into()),
                embedded: false,
                params: BackingParams {
                    volume: 0.7,
                    semitones: -2,
                    filter: BackingFilter::BassIsolate,
                    ..Default::default()
                },
                sync: vec![
                    SyncPoint {
                        bar: 0,
                        ms: 1_200.0,
                    },
                    SyncPoint {
                        bar: 8,
                        ms: 17_000.0,
                    },
                ],
            }),
            presets: vec![ChainPreset {
                name: "Slapback".into(),
                target: "guitar".into(),
                effects: vec![delay],
            }],
            ..settings()
        }
    }

    #[test]
    fn round_trips_every_v2_field() {
        let s = full();
        assert_eq!(s.validate(), Ok(()));
        let json = serde_json::to_string(&s).unwrap();
        for key in [
            "\"masterPan\"",
            "\"sounds\"",
            "\"switches\"",
            "\"eq\"",
            "\"automation\"",
            "\"focus\"",
            "\"drums\"",
            "\"audioTrack\"",
            "\"semitones\":-2",
            "\"filter\":\"bassIsolate\"",
            "\"presets\"",
        ] {
            assert!(json.contains(key), "{key} missing in {json}");
        }
        assert_eq!(serde_json::from_str::<MixerSettings>(&json).unwrap(), s);
    }

    #[test]
    fn rejects_bad_v2_values() {
        let cases: Vec<(MixerSettings, &str)> = vec![
            (
                MixerSettings {
                    master_pan: 2.0,
                    ..full()
                },
                "master pan",
            ),
            (
                MixerSettings {
                    focus: Some(5),
                    ..full()
                },
                "focused",
            ),
            (
                {
                    let mut s = full();
                    s.sounds[0].switches[0].sound = 7;
                    s
                },
                "sound switch",
            ),
            (
                {
                    let mut s = full();
                    s.automation[1].pan[0].value = 3.0;
                    s
                },
                "automation",
            ),
            (
                {
                    let mut s = full();
                    s.eq[0].mid_db = 99.0;
                    s
                },
                "EQ",
            ),
            (
                {
                    let mut s = full();
                    s.drums[1].as_mut().unwrap().elements[0].volume = -1.0;
                    s
                },
                "drum mixer",
            ),
            (
                {
                    let mut s = full();
                    s.audio_track.as_mut().unwrap().params.cents = 500;
                    s
                },
                "transposition",
            ),
            (
                {
                    let mut s = full();
                    s.eq = vec![TrackEq::default(); 3];
                    s
                },
                "more EQs",
            ),
        ];
        for (settings, message) in cases {
            let error = settings.validate().unwrap_err();
            assert!(error.contains(message), "{error} should mention {message}");
        }
    }

    #[test]
    fn rejects_out_of_range_values() {
        let mut s = settings();
        s.master = 1.01;
        assert!(s.validate().unwrap_err().contains("master"));

        let mut s = settings();
        s.tracks[1].volume = -0.1;
        assert!(s.validate().unwrap_err().contains("track 1: volume"));

        let mut s = settings();
        s.tracks[0].pan = f64::NAN;
        assert!(s.validate().unwrap_err().contains("track 0: pan"));

        let mut s = settings();
        s.version = 3;
        assert!(s.validate().unwrap_err().contains("version"));
        s.version = 1;
        assert_eq!(s.validate(), Ok(()), "version 1 files still load");

        let mut s = settings();
        s.tracks = vec![s.tracks[0]; MAX_TRACKS + 1];
        assert!(s.validate().unwrap_err().contains("tracks"));
    }

    #[test]
    fn serializes_camel_case_json() {
        let json = serde_json::to_value(settings()).unwrap();
        assert_eq!(json["version"], VERSION);
        // Empty v2 fields are left out, so plain mixes stay small.
        assert!(json.get("sounds").is_none() && json.get("audioTrack").is_none());
        assert_eq!(json["tracks"][0]["solo"], true);
    }

    #[test]
    fn file_keys_must_be_lowercase_sha256_hex() {
        assert_eq!(key().as_str(), KEY);
        for bad in [
            "",
            "abc",
            &KEY.to_uppercase(),
            &format!("{KEY}0"),
            &format!("../{}", &KEY[3..]),
            &KEY.replace('9', "g"),
        ] {
            let error = FileKey::parse(bad).unwrap_err();
            assert_eq!(error.kind, ErrorKind::InvalidKey, "{bad}");
        }
    }

    #[test]
    fn round_trips_through_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let store = MixerStore::new(dir.path().join("mixer"));

        assert_eq!(store.load(&key()).unwrap(), None);
        store.save(&key(), &settings()).unwrap();

        assert_eq!(store.load(&key()).unwrap(), Some(settings()));
        assert!(store.dir().join(format!("{KEY}.json")).is_file());
    }

    #[test]
    fn overwrites_previous_settings_without_leaving_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = MixerStore::new(dir.path());
        store.save(&key(), &settings()).unwrap();

        let updated = MixerSettings {
            master: 0.1,
            ..settings()
        };
        store.save(&key(), &updated).unwrap();

        assert_eq!(store.load(&key()).unwrap(), Some(updated));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn refuses_to_save_invalid_settings() {
        let dir = tempfile::tempdir().unwrap();
        let store = MixerStore::new(dir.path());
        let invalid = MixerSettings {
            master: 2.0,
            ..settings()
        };

        let error = store.save(&key(), &invalid).unwrap_err();

        assert_eq!(error.kind, ErrorKind::InvalidSettings);
        assert_eq!(store.load(&key()).unwrap(), None);
    }

    #[test]
    fn ignores_damaged_or_outdated_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = MixerStore::new(dir.path());
        let path = dir.path().join(format!("{KEY}.json"));

        fs::write(&path, "{ not json").unwrap();
        assert_eq!(store.load(&key()).unwrap(), None);

        fs::write(&path, r#"{"version":99,"master":1,"tracks":[]}"#).unwrap();
        assert_eq!(store.load(&key()).unwrap(), None);
    }
}
