//! Writing songs: Save, Save As and the exports.
//!
//! The UI builds the file content (Guitar Pro, MusicXML, MIDI, ASCII tab) and
//! the user picks the destination in the native Save dialog. The command only
//! writes file types Smart Beat produces, so it cannot be used to overwrite
//! arbitrary files on disk. Writing is atomic: the content goes to a temporary
//! file next to the target, which then replaces it.

use std::fs;
use std::io::{self, Write};
use std::path::Path;

use crate::error::{CommandError, ErrorKind};
use crate::score_file::MAX_SIZE;

/// File extensions Smart Beat writes. Mirrored by `SAVE_EXTENSIONS` in `src/lib/tauri.ts`.
pub const WRITE_EXTENSIONS: [&str; 7] = ["gp", "gp5", "mid", "midi", "musicxml", "txt", "wav"];

/// Whether `path` ends in one of [`WRITE_EXTENSIONS`] (case-insensitive).
pub fn has_writable_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| WRITE_EXTENSIONS.iter().any(|e| ext.eq_ignore_ascii_case(e)))
}

/// Writes `bytes` to `path`, replacing any existing file.
pub fn write(path: &Path, bytes: &[u8]) -> Result<(), CommandError> {
    let name = path
        .file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned();
    if !has_writable_extension(path) {
        return Err(CommandError::new(
            ErrorKind::UnsupportedType,
            format!("“{name}” has an extension Smart Beat does not save."),
        ));
    }
    if bytes.len() as u64 > MAX_SIZE {
        return Err(CommandError::new(
            ErrorKind::TooLarge,
            format!(
                "“{name}” would be larger than {} MB.",
                MAX_SIZE / (1024 * 1024)
            ),
        ));
    }
    let dir = match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => Path::new("."),
    };
    let io_error = |error: &io::Error| match error.kind() {
        io::ErrorKind::NotFound => CommandError::new(
            ErrorKind::NotFound,
            format!("The folder for “{name}” does not exist."),
        ),
        _ => CommandError::new(
            ErrorKind::Io,
            format!("“{name}” could not be saved: {error}"),
        ),
    };
    if path.is_dir() {
        return Err(CommandError::new(
            ErrorKind::Io,
            format!("“{name}” is a folder."),
        ));
    }
    let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|e| io_error(&e))?;
    file.write_all(bytes)
        .and_then(|()| file.flush())
        .map_err(|e| io_error(&e))?;
    // Keep the permissions of the file being replaced.
    if let Ok(metadata) = fs::metadata(path) {
        let _ = fs::set_permissions(file.path(), metadata.permissions());
    }
    file.persist(path).map_err(|e| io_error(&e.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_replaces_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("song.gp5");
        write(&path, b"one").unwrap();
        write(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        // No temporary files are left behind.
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn extension_check_is_case_insensitive() {
        assert!(has_writable_extension(Path::new("a.GP5")));
        assert!(has_writable_extension(Path::new("a.MusicXML")));
        assert!(has_writable_extension(Path::new("a.txt")));
        assert!(has_writable_extension(Path::new("mix.WAV")));
        assert!(!has_writable_extension(Path::new("a.sh")));
        assert!(!has_writable_extension(Path::new("a")));
    }

    #[test]
    fn saves_exported_audio_as_a_wav_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mix.wav");
        write(&path, b"RIFF....WAVE").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"RIFF....WAVE");
    }

    #[test]
    fn refuses_other_extensions_without_touching_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.sh");
        fs::write(&path, "keep").unwrap();
        let error = write(&path, b"x").unwrap_err();
        assert_eq!(error.kind, ErrorKind::UnsupportedType);
        assert_eq!(fs::read(&path).unwrap(), b"keep");
    }

    #[test]
    fn reports_a_missing_folder() {
        let dir = tempfile::tempdir().unwrap();
        let error = write(&dir.path().join("missing").join("a.gp5"), b"x").unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);
    }

    #[test]
    fn refuses_to_replace_a_folder() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("a.gp5");
        fs::create_dir(&folder).unwrap();
        assert_eq!(write(&folder, b"x").unwrap_err().kind, ErrorKind::Io);
    }

    #[test]
    fn refuses_oversized_content() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = vec![0u8; usize::try_from(MAX_SIZE).unwrap() + 1];
        let error = write(&dir.path().join("a.gp5"), &bytes).unwrap_err();
        assert_eq!(error.kind, ErrorKind::TooLarge);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_permissions_of_the_replaced_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.gp5");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        write(&path, b"new").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
    }
}
