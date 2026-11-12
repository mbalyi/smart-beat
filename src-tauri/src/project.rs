//! Smart Beat's own data inside a saved `.gp` file.
//!
//! A Guitar Pro 7+ file is a ZIP archive. After alphaTab writes the score,
//! Smart Beat adds `SmartBeat/settings.json` (the mixer settings: effect
//! chains, sounds, EQ, automation, drum mixer, audio lanes, presets) and the
//! embedded audio files of the lanes' clips under `SmartBeat/audio/<sha256>.<ext>`,
//! each file stored once however many clips play it.
//! Guitar Pro and alphaTab ignore entries they do not know, so the file still
//! opens everywhere, and the settings travel with it.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Cursor, Read, Write};
use std::path::Path;
use std::sync::Arc;

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
        .and_then(|s| s.validate().map(|()| s.migrate()));
    match settings {
        Ok(settings) => Ok(Some(settings)),
        Err(reason) => {
            eprintln!("ignoring settings in {}: {reason}", path.display());
            Ok(None)
        }
    }
}

/// The audio entry `name` (a pool name `<id>.<ext>`, or an old audio track's file name)
/// embedded in a `.gp` file.
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

/// The embedded audio files of `settings` that a clip plays, with the entry names an existing
/// archive may hold them under (the pool name, and the name an old audio track used).
fn wanted_audio(settings: &MixerSettings) -> Result<Vec<(String, Vec<String>)>, CommandError> {
    let Some(audio) = &settings.audio else {
        return Ok(Vec::new());
    };
    audio
        .used_sources()
        .filter(|s| s.embedded)
        .map(|s| {
            let mut names = vec![audio_entry(&s.entry_name())?];
            if let Some(legacy) = &s.legacy_entry {
                names.push(audio_entry(legacy)?);
            }
            Ok((s.id.clone(), names))
        })
        .collect()
}

/// Rewrites the `.gp` file at `path` with `settings` inside. Every embedded audio file a clip
/// plays is kept (or written from `files`, by source id, when the archive does not have it yet);
/// files no clip plays any more are removed, so the song does not keep growing.
pub fn write_settings(
    path: &Path,
    settings: &MixerSettings,
    files: &HashMap<String, Arc<Vec<u8>>>,
) -> Result<(), CommandError> {
    if !is_gp(path) {
        return Err(CommandError::new(
            ErrorKind::UnsupportedType,
            "Settings can only be stored in .gp files.",
        ));
    }
    let settings = settings.clone().migrate();
    settings
        .validate()
        .map_err(|reason| CommandError::new(ErrorKind::InvalidSettings, reason))?;
    let wanted = wanted_audio(&settings)?;

    let mut archive = open(path)?;
    let present: HashSet<String> = archive
        .file_names()
        .filter_map(|n| n.ok().map(|n| n.into_owned()))
        .collect();
    let keep: HashSet<&str> = wanted
        .iter()
        .flat_map(|(_, names)| names.iter().map(String::as_str))
        .collect();
    let mut missing = Vec::new();
    for (id, names) in &wanted {
        if names.iter().any(|n| present.contains(n)) {
            continue;
        }
        let bytes = files.get(id).ok_or_else(|| {
            CommandError::new(
                ErrorKind::Audio,
                "An audio file is not loaded, so it cannot be stored in the song.",
            )
        })?;
        missing.push((names[0].clone(), bytes.clone()));
    }

    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let zip_error = |e: zip::result::ZipError| io_error(path, e);
    for i in 0..archive.len() {
        let entry = archive.by_index_raw(i).map_err(zip_error)?;
        let name = entry.name().map_err(zip_error)?.into_owned();
        let ours = name == SETTINGS_ENTRY || name.starts_with(AUDIO_PREFIX);
        if ours && !keep.contains(name.as_str()) {
            continue;
        }
        writer.raw_copy_file(entry).map_err(zip_error)?;
    }
    for (entry, bytes) in missing {
        // Compressed audio does not shrink further: store it as is.
        let stored = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .large_file(bytes.len() as u64 >= u32::MAX as u64);
        writer.start_file(entry, stored).map_err(zip_error)?;
        writer.write_all(&bytes).map_err(|e| io_error(path, e))?;
    }
    let json = serde_json::to_vec_pretty(&settings).map_err(|e| io_error(path, e))?;
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
    use crate::audio_lanes::{AudioLanes, AudioSource, migrate_audio_track};
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

    fn none() -> HashMap<String, Arc<Vec<u8>>> {
        HashMap::new()
    }

    fn hex(c: char) -> String {
        c.to_string().repeat(64)
    }

    /// Lanes playing `clips` sources (by id), with the sources `embedded` or not.
    fn with_lanes(clips: &[&str], embedded: bool) -> MixerSettings {
        let mut audio: AudioLanes = migrate_audio_track(&AudioTrack {
            name: "take.mp3".into(),
            path: None,
            embedded,
            params: Default::default(),
            sync: vec![],
        });
        audio.sources = ['a', 'b']
            .map(|c| AudioSource {
                id: hex(c),
                name: format!("{c}.wav"),
                ext: "wav".into(),
                path: None,
                embedded,
                legacy_entry: None,
            })
            .to_vec();
        let template = audio.lanes[0].clips[0].clone();
        audio.lanes[0].clips = clips
            .iter()
            .enumerate()
            .map(|(i, id)| {
                let mut clip = template.clone();
                clip.id = format!("clip-{i}");
                clip.takes[0].source_id = (*id).into();
                clip
            })
            .collect();
        MixerSettings {
            audio: Some(audio),
            ..settings()
        }
    }

    fn files(pairs: &[(&str, &[u8])]) -> HashMap<String, Arc<Vec<u8>>> {
        pairs
            .iter()
            .map(|(id, b)| ((*id).to_string(), Arc::new(b.to_vec())))
            .collect()
    }

    #[test]
    fn stores_and_reads_settings_keeping_the_score() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("song.gp");
        std::fs::write(&path, gp_bytes()).unwrap();
        assert_eq!(read_settings(&path).unwrap(), None);

        write_settings(&path, &settings(), &none()).unwrap();
        assert_eq!(read_settings(&path).unwrap(), Some(settings()));
        // Saving again replaces the entry instead of adding a second one.
        let mut changed = settings();
        changed.tracks[0] = TrackMix {
            volume: 0.1,
            ..changed.tracks[0]
        };
        write_settings(&path, &changed, &none()).unwrap();
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
    fn stores_each_audio_file_once_and_drops_unused_ones() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("song.gp");
        std::fs::write(&path, gp_bytes()).unwrap();
        let (a, b) = (hex('a'), hex('b'));
        // Two clips play one file: it is stored once.
        let pool = files(&[(&a, b"RIFF a"), (&b, b"RIFF b")]);
        write_settings(&path, &with_lanes(&[&a, &a], true), &pool).unwrap();
        assert_eq!(
            read_embedded_audio(&path, &format!("{a}.wav")).unwrap(),
            b"RIFF a"
        );
        assert_eq!(entries(&path).len(), 3);
        // A second file is added; saving again without bytes keeps both.
        write_settings(&path, &with_lanes(&[&a, &b], true), &pool).unwrap();
        write_settings(&path, &with_lanes(&[&a, &b], true), &none()).unwrap();
        assert_eq!(entries(&path).len(), 4);
        // The clip playing `b` is removed: its file goes on the next save.
        write_settings(&path, &with_lanes(&[&a], true), &none()).unwrap();
        assert_eq!(
            read_embedded_audio(&path, &format!("{b}.wav"))
                .unwrap_err()
                .kind,
            ErrorKind::NotFound
        );
        // Referenced files are never stored.
        write_settings(&path, &with_lanes(&[&a], false), &none()).unwrap();
        assert_eq!(entries(&path).len(), 2);
    }

    #[test]
    fn refuses_to_save_an_embedded_file_that_is_not_loaded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("song.gp");
        std::fs::write(&path, gp_bytes()).unwrap();
        let error = write_settings(&path, &with_lanes(&[&hex('a')], true), &none()).unwrap_err();
        assert_eq!(error.kind, ErrorKind::Audio);
    }

    #[test]
    fn an_old_song_keeps_its_recording_after_migration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("song.gp");
        // A version 2 file: the old settings and the recording under its own name.
        let old = MixerSettings {
            version: 2,
            audio_track: Some(AudioTrack {
                name: "take.mp3".into(),
                path: None,
                embedded: true,
                params: Default::default(),
                sync: vec![],
            }),
            ..settings()
        };
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("Content/score.gpif", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"<GPIF/>").unwrap();
        writer
            .start_file(SETTINGS_ENTRY, SimpleFileOptions::default())
            .unwrap();
        writer
            .write_all(&serde_json::to_vec(&old).unwrap())
            .unwrap();
        writer
            .start_file(
                format!("{AUDIO_PREFIX}take.mp3"),
                SimpleFileOptions::default(),
            )
            .unwrap();
        writer.write_all(b"ID3 audio").unwrap();
        std::fs::write(&path, writer.finish().unwrap().into_inner()).unwrap();

        let migrated = read_settings(&path).unwrap().unwrap();
        assert_eq!(migrated.version, VERSION);
        assert!(migrated.audio_track.is_none());
        let source = &migrated.audio.as_ref().unwrap().sources[0];
        assert_eq!(source.legacy_entry.as_deref(), Some("take.mp3"));
        // The first save writes version 3 and keeps the recording without a rewrite.
        write_settings(&path, &migrated, &none()).unwrap();
        assert_eq!(
            read_embedded_audio(&path, "take.mp3").unwrap(),
            b"ID3 audio"
        );
        let json = {
            let mut archive = open(&path).unwrap();
            let mut text = String::new();
            archive
                .by_name(SETTINGS_ENTRY)
                .unwrap()
                .read_to_string(&mut text)
                .unwrap();
            text
        };
        assert!(!json.contains("audioTrack"));
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
            write_settings(&path, &settings(), &none())
                .unwrap_err()
                .kind,
            ErrorKind::NotAScore
        );
        // Other extensions have no settings and cannot take them.
        let gp5 = dir.path().join("song.gp5");
        std::fs::write(&gp5, b"x").unwrap();
        assert_eq!(read_settings(&gp5).unwrap(), None);
        assert_eq!(
            write_settings(&gp5, &settings(), &none()).unwrap_err().kind,
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
            write_settings(&path, &bad, &none()).unwrap_err().kind,
            ErrorKind::InvalidSettings
        );
        for name in ["../evil.mp3", "a/b.mp3", "", ".."] {
            assert!(read_embedded_audio(&path, name).is_err(), "{name}");
        }
        assert_eq!(read_settings(&path).unwrap(), None, "nothing was written");
    }
}
