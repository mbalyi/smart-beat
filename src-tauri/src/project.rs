//! Smart Beat's own data inside a saved `.gp` file.
//!
//! A Guitar Pro 7+ file is a ZIP archive. After alphaTab writes the score,
//! Smart Beat adds `SmartBeat/settings.json` (the mixer settings: effect
//! chains, sounds, EQ, automation, drum mixer, audio track, presets) and, when
//! the user asks for it, the audio track's recording under `SmartBeat/audio/`.
//! Guitar Pro and alphaTab ignore entries they do not know, so the file still
//! opens everywhere, and the settings travel with it.

use std::fs::File;
use std::io::{Cursor, Read, Write};
use std::path::Path;

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::error::{CommandError, ErrorKind};
use crate::mixer::MixerSettings;
use crate::score_file::MAX_SIZE;
use crate::score_write;

pub const SETTINGS_ENTRY: &str = "SmartBeat/settings.json";
pub const AUDIO_PREFIX: &str = "SmartBeat/audio/";
/// Largest settings entry read back.
const MAX_SETTINGS_BYTES: u64 = 16 * 1024 * 1024;

fn is_gp(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("gp"))
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned()
}

fn not_a_project(path: &Path) -> CommandError {
    CommandError::new(
        ErrorKind::NotAScore,
        format!("“{}” is not a Guitar Pro 7+ file.", file_name(path)),
    )
}

fn io_error(path: &Path, error: impl std::fmt::Display) -> CommandError {
    CommandError::new(
        ErrorKind::Io,
        format!("“{}” could not be read: {error}", file_name(path)),
    )
}

/// An embedded recording's entry name; refuses names that could escape the folder.
fn audio_entry(name: &str) -> Result<String, CommandError> {
    let valid = !name.is_empty()
        && name.len() <= 255
        && !name.contains(['/', '\\'])
        && name != "."
        && name != "..";
    if !valid {
        return Err(CommandError::new(
            ErrorKind::Io,
            "The audio file name is not valid.",
        ));
    }
    Ok(format!("{AUDIO_PREFIX}{name}"))
}

fn open(path: &Path) -> Result<ZipArchive<File>, CommandError> {
    let file = File::open(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => CommandError::new(
            ErrorKind::NotFound,
            format!("“{}” does not exist.", file_name(path)),
        ),
        _ => io_error(path, e),
    })?;
    ZipArchive::new(file).map_err(|_| not_a_project(path))
}

/// The settings stored in a `.gp` file, if it has any. Other file types and
/// damaged or unreadable settings give `None` (the song still opens).
pub fn read_settings(path: &Path) -> Result<Option<MixerSettings>, CommandError> {
    if !is_gp(path) {
        return Ok(None);
    }
    let mut archive = match open(path) {
        Ok(archive) => archive,
        Err(e) if e.kind == ErrorKind::NotAScore => return Ok(None),
        Err(e) => return Err(e),
    };
    let Ok(entry) = archive.by_name(SETTINGS_ENTRY) else {
        return Ok(None);
    };
    let mut json = String::new();
    if entry
        .take(MAX_SETTINGS_BYTES)
        .read_to_string(&mut json)
        .is_err()
    {
        return Ok(None);
    }
    let settings = serde_json::from_str::<MixerSettings>(&json)
        .map_err(|e| e.to_string())
        .and_then(|s| s.validate().map(|()| s));
    match settings {
        Ok(settings) => Ok(Some(settings)),
        Err(reason) => {
            eprintln!("ignoring settings in {}: {reason}", path.display());
            Ok(None)
        }
    }
}

/// The recording `name` embedded in a `.gp` file.
pub fn read_embedded_audio(path: &Path, name: &str) -> Result<Vec<u8>, CommandError> {
    let entry_name = audio_entry(name)?;
    let mut archive = open(path)?;
    let entry = archive.by_name(&entry_name).map_err(|_| {
        CommandError::new(
            ErrorKind::NotFound,
            format!("“{name}” is not in “{}”.", file_name(path)),
        )
    })?;
    let mut bytes = Vec::new();
    entry
        .take(MAX_SIZE)
        .read_to_end(&mut bytes)
        .map_err(|e| io_error(path, e))?;
    Ok(bytes)
}

/// Rewrites the `.gp` file at `path` with `settings` inside. `audio` is the
/// recording to embed (name and bytes); without it, an embedded recording of
/// the same name that the settings still refer to is kept, and any other is
/// removed.
pub fn write_settings(
    path: &Path,
    settings: &MixerSettings,
    audio: Option<(&str, &[u8])>,
) -> Result<(), CommandError> {
    if !is_gp(path) {
        return Err(CommandError::new(
            ErrorKind::UnsupportedType,
            "Settings can only be stored in .gp files.",
        ));
    }
    settings
        .validate()
        .map_err(|reason| CommandError::new(ErrorKind::InvalidSettings, reason))?;
    let keep_audio = match (audio, &settings.audio_track) {
        (None, Some(track)) if track.embedded => Some(audio_entry(&track.name)?),
        _ => None,
    };
    let new_audio = audio
        .map(|(name, bytes)| audio_entry(name).map(|entry| (entry, bytes)))
        .transpose()?;

    let mut archive = open(path)?;
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let zip_error = |e: zip::result::ZipError| io_error(path, e);
    for i in 0..archive.len() {
        let entry = archive.by_index_raw(i).map_err(zip_error)?;
        let name = entry.name().map_err(zip_error)?.into_owned();
        let ours = name == SETTINGS_ENTRY || name.starts_with(AUDIO_PREFIX);
        if ours && keep_audio.as_deref() != Some(name.as_str()) {
            continue;
        }
        writer.raw_copy_file(entry).map_err(zip_error)?;
    }
    if let Some((entry, bytes)) = new_audio {
        // Compressed audio does not shrink further: store it as is.
        let stored = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .large_file(bytes.len() as u64 >= u32::MAX as u64);
        writer.start_file(entry, stored).map_err(zip_error)?;
        writer.write_all(bytes).map_err(|e| io_error(path, e))?;
    }
    let json = serde_json::to_vec_pretty(settings).map_err(|e| io_error(path, e))?;
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    writer
        .start_file(SETTINGS_ENTRY, deflated)
        .map_err(zip_error)?;
    writer.write_all(&json).map_err(|e| io_error(path, e))?;
    let bytes = writer.finish().map_err(zip_error)?.into_inner();
    drop(archive);
    score_write::write(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mixer::{AudioTrack, TrackMix, VERSION};

    /// A small ZIP standing in for alphaTab's output.
    fn gp_bytes() -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("Content/score.gpif", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"<GPIF/>").unwrap();
        writer.finish().unwrap().into_inner()
    }

    fn settings() -> MixerSettings {
        serde_json::from_value(serde_json::json!({
            "version": VERSION,
            "master": 0.9,
            "tracks": [{ "volume": 0.5, "pan": 0.0, "mute": false, "solo": false }],
        }))
        .unwrap()
    }

    fn entries(path: &Path) -> Vec<String> {
        let archive = open(path).unwrap();
        archive
            .file_names()
            .map(|name| name.unwrap().into_owned())
            .collect()
    }

    fn with_audio(embedded: bool) -> MixerSettings {
        MixerSettings {
            audio_track: Some(AudioTrack {
                name: "take.mp3".into(),
                path: None,
                embedded,
                params: Default::default(),
                sync: vec![],
            }),
            ..settings()
        }
    }

    #[test]
    fn stores_and_reads_settings_keeping_the_score() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("song.gp");
        std::fs::write(&path, gp_bytes()).unwrap();
        assert_eq!(read_settings(&path).unwrap(), None);

        write_settings(&path, &settings(), None).unwrap();
        assert_eq!(read_settings(&path).unwrap(), Some(settings()));
        // Saving again replaces the entry instead of adding a second one.
        let mut changed = settings();
        changed.tracks[0] = TrackMix {
            volume: 0.1,
            ..changed.tracks[0]
        };
        write_settings(&path, &changed, None).unwrap();
        assert_eq!(read_settings(&path).unwrap(), Some(changed));
        assert_eq!(entries(&path), vec!["Content/score.gpif", SETTINGS_ENTRY]);
        let mut archive = open(&path).unwrap();
        let mut gpif = String::new();
        archive
            .by_name("Content/score.gpif")
            .unwrap()
            .read_to_string(&mut gpif)
            .unwrap();
        assert_eq!(gpif, "<GPIF/>");
    }

    #[test]
    fn embeds_keeps_and_drops_the_recording() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("song.gp");
        std::fs::write(&path, gp_bytes()).unwrap();
        write_settings(&path, &with_audio(true), Some(("take.mp3", b"ID3 audio"))).unwrap();
        assert_eq!(
            read_embedded_audio(&path, "take.mp3").unwrap(),
            b"ID3 audio"
        );
        // Saved again without new bytes: still embedded.
        write_settings(&path, &with_audio(true), None).unwrap();
        assert_eq!(
            read_embedded_audio(&path, "take.mp3").unwrap(),
            b"ID3 audio"
        );
        // Switched to a reference: the bytes go.
        write_settings(&path, &with_audio(false), None).unwrap();
        assert_eq!(
            read_embedded_audio(&path, "take.mp3").unwrap_err().kind,
            ErrorKind::NotFound
        );
        assert_eq!(entries(&path).len(), 2);
    }

    #[test]
    fn ignores_damaged_settings_and_other_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("song.gp");
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file(SETTINGS_ENTRY, SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"{ broken").unwrap();
        std::fs::write(&path, writer.finish().unwrap().into_inner()).unwrap();
        assert_eq!(read_settings(&path).unwrap(), None);
        // Not a ZIP at all.
        std::fs::write(&path, b"FICHIER GUITAR PRO").unwrap();
        assert_eq!(read_settings(&path).unwrap(), None);
        assert_eq!(
            write_settings(&path, &settings(), None).unwrap_err().kind,
            ErrorKind::NotAScore
        );
        // Other extensions have no settings and cannot take them.
        let gp5 = dir.path().join("song.gp5");
        std::fs::write(&gp5, b"x").unwrap();
        assert_eq!(read_settings(&gp5).unwrap(), None);
        assert_eq!(
            write_settings(&gp5, &settings(), None).unwrap_err().kind,
            ErrorKind::UnsupportedType
        );
    }

    #[test]
    fn refuses_invalid_settings_and_audio_names() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("song.gp");
        std::fs::write(&path, gp_bytes()).unwrap();
        let bad = MixerSettings {
            master: 4.0,
            ..settings()
        };
        assert_eq!(
            write_settings(&path, &bad, None).unwrap_err().kind,
            ErrorKind::InvalidSettings
        );
        for name in ["../evil.mp3", "a/b.mp3", "", ".."] {
            assert!(read_embedded_audio(&path, name).is_err(), "{name}");
            assert!(
                write_settings(&path, &settings(), Some((name, b"x"))).is_err(),
                "{name}"
            );
        }
        assert_eq!(read_settings(&path).unwrap(), None, "nothing was written");
    }
}
