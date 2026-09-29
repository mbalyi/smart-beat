//! Per-song mixer settings, stored as JSON files in the app data folder.
//!
//! Settings are keyed by the SHA-256 of the song file's content, so they follow
//! the song when it is renamed or moved, and the user's folders are never
//! touched. Once Smart Beat can save Guitar Pro files (issue #15), the mix will
//! also be written into the file itself.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{CommandError, ErrorKind};

/// Current settings format. Files with another version are ignored.
pub const VERSION: u32 = 1;

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
        if self.version != VERSION {
            return Err(format!("unsupported settings version {}", self.version));
        }
        if self.tracks.len() > MAX_TRACKS {
            return Err(format!("more than {MAX_TRACKS} tracks"));
        }
        if !in_range(self.master, 0.0, 1.0) {
            return Err("master volume must be between 0 and 1".into());
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
        s.version = 2;
        assert!(s.validate().unwrap_err().contains("version"));

        let mut s = settings();
        s.tracks = vec![s.tracks[0]; MAX_TRACKS + 1];
        assert!(s.validate().unwrap_err().contains("tracks"));
    }

    #[test]
    fn serializes_camel_case_json() {
        let json = serde_json::to_value(settings()).unwrap();
        assert_eq!(json["version"], 1);
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
