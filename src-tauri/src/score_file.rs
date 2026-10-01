//! Reading Guitar Pro, MusicXML, MIDI, MuseScore, alphaTex, Capella and text tab
//! files for the score viewer.
//!
//! The webview asks for a file by path (picked in the native Open dialog or
//! dropped on the window). Only files that are music scores are returned,
//! so the command cannot be used to read arbitrary files from disk.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::Path;

use crate::error::{CommandError, ErrorKind};

/// File extensions offered in the Open dialog and accepted on drop.
/// Mirrored by `SCORE_EXTENSIONS` in `src/lib/tauri.ts`.
pub const EXTENSIONS: [&str; 14] = [
    "gp3", "gp4", "gp5", "gpx", "gp", "mid", "midi", "musicxml", "xml", "mscx", "mscz", "atex",
    "capx", "txt",
];

/// Largest file we load. Guitar Pro 7+ files can embed audio, so this is generous.
pub const MAX_SIZE: u64 = 100 * 1024 * 1024;

/// Guitar Pro file generations, told apart by their first bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScoreFormat {
    Gp3,
    Gp4,
    Gp5,
    /// Guitar Pro 6 (`.gpx`).
    Gpx,
    /// Guitar Pro 7 and later (`.gp`).
    Gp7,
    /// Standard MIDI file (`.mid`).
    Midi,
    /// Uncompressed MusicXML (`.musicxml`, `.xml`).
    MusicXml,
}

/// GP3–GP5 start with a length byte followed by this text and the version,
/// e.g. `FICHIER GUITAR PRO v4.06` (or `L4.06` for some GP4 files).
const GP3_TO_5_SIGNATURE: &[u8] = b"FICHIER GUITAR PRO ";

impl ScoreFormat {
    /// Detects the format from the start of a file.
    pub fn detect(bytes: &[u8]) -> Option<Self> {
        if bytes.starts_with(b"MThd") {
            return Some(Self::Midi);
        }
        if is_music_xml(bytes) {
            return Some(Self::MusicXml);
        }
        // GP6 containers are "BCFZ" (compressed) or "BCFS" (uncompressed).
        if bytes.starts_with(b"BCFZ") || bytes.starts_with(b"BCFS") {
            return Some(Self::Gpx);
        }
        // GP7+ files are ZIP archives.
        if bytes.starts_with(b"PK\x03\x04") {
            return Some(Self::Gp7);
        }

        let (&length, rest) = bytes.split_first()?;
        let version = rest
            .get(..usize::from(length))?
            .strip_prefix(GP3_TO_5_SIGNATURE)?;
        match version {
            [b'v' | b'L', major, b'.', ..] => match major {
                b'3' => Some(Self::Gp3),
                b'4' => Some(Self::Gp4),
                b'5' => Some(Self::Gp5),
                _ => None,
            },
            _ => None,
        }
    }
}

/// A MusicXML document: XML whose start declares a `score-partwise` or
/// `score-timewise` root (after an optional BOM and whitespace).
fn is_music_xml(bytes: &[u8]) -> bool {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let start = bytes.iter().position(|b| !b.is_ascii_whitespace());
    let Some(start) = start else { return false };
    let head = &bytes[start..bytes.len().min(start + 4096)];
    head.starts_with(b"<")
        && [&b"<score-partwise"[..], b"<score-timewise"]
            .iter()
            .any(|tag| head.windows(tag.len()).any(|w| w == *tag))
}

/// Whether the bytes are XML whose start declares the `tag` root (after an optional BOM and blanks).
fn is_xml_with_root(bytes: &[u8], tag: &[u8]) -> bool {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let head = &bytes[..bytes.len().min(4096)];
    head.trim_ascii_start().starts_with(b"<") && head.windows(tag.len()).any(|w| w == tag)
}

/// Text formats (alphaTex, ASCII tab): no NUL bytes in the start, which a binary file has.
fn is_text(bytes: &[u8]) -> bool {
    !bytes.is_empty() && !bytes[..bytes.len().min(4096)].contains(&0)
}

/// Whether the content fits the file's extension (the formats that are told apart by name).
fn content_matches(extension: &str, bytes: &[u8]) -> bool {
    match extension {
        "atex" | "txt" => is_text(bytes),
        "mscx" => is_xml_with_root(bytes, b"<museScore"),
        // MuseScore and Capella archives are ZIP files.
        "mscz" | "capx" => bytes.starts_with(b"PK\x03\x04"),
        _ => ScoreFormat::detect(bytes).is_some(),
    }
}

/// Whether `path` ends in one of [`EXTENSIONS`] (case-insensitive).
pub fn has_supported_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| EXTENSIONS.iter().any(|e| ext.eq_ignore_ascii_case(e)))
}

/// Reads a Guitar Pro file, rejecting anything that is not one.
pub fn read(path: &Path) -> Result<Vec<u8>, CommandError> {
    let name = display_name(path);
    if !has_supported_extension(path) {
        return Err(CommandError::new(
            ErrorKind::UnsupportedType,
            format!("“{name}” is not a file Smart Beat can open."),
        ));
    }

    let metadata = fs::metadata(path).map_err(|error| io_error(&name, &error))?;
    if !metadata.is_file() {
        return Err(CommandError::new(
            ErrorKind::NotFound,
            format!("“{name}” is not a file."),
        ));
    }
    if metadata.len() > MAX_SIZE {
        return Err(too_large(&name));
    }

    // `take` guards against the file growing between `metadata` and the read.
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or_default());
    File::open(path)
        .and_then(|file| file.take(MAX_SIZE + 1).read_to_end(&mut bytes))
        .map_err(|error| io_error(&name, &error))?;
    if bytes.len() as u64 > MAX_SIZE {
        return Err(too_large(&name));
    }

    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_matches(&extension, &bytes) {
        return Err(CommandError::new(
            ErrorKind::NotAScore,
            format!("“{name}” is not a supported music file, or it is damaged."),
        ));
    }
    Ok(bytes)
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned()
}

fn too_large(name: &str) -> CommandError {
    CommandError::new(
        ErrorKind::TooLarge,
        format!("“{name}” is larger than {} MB.", MAX_SIZE / (1024 * 1024)),
    )
}

fn io_error(name: &str, error: &io::Error) -> CommandError {
    match error.kind() {
        io::ErrorKind::NotFound => {
            CommandError::new(ErrorKind::NotFound, format!("“{name}” could not be found."))
        }
        _ => CommandError::new(
            ErrorKind::Io,
            format!("“{name}” could not be read: {error}"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    /// Header of a GP3–GP5 file: length byte + version text, padded to 30 bytes.
    fn gp_header(version: &str) -> Vec<u8> {
        let mut bytes = vec![u8::try_from(version.len()).unwrap()];
        bytes.extend_from_slice(version.as_bytes());
        bytes.resize(31, 0);
        bytes
    }

    fn write(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.path().join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn detects_gp3_to_gp5_from_the_version_header() {
        let cases = [
            ("FICHIER GUITAR PRO v3.00", ScoreFormat::Gp3),
            ("FICHIER GUITAR PRO v4.00", ScoreFormat::Gp4),
            ("FICHIER GUITAR PRO v4.06", ScoreFormat::Gp4),
            ("FICHIER GUITAR PRO L4.06", ScoreFormat::Gp4),
            ("FICHIER GUITAR PRO v5.00", ScoreFormat::Gp5),
            ("FICHIER GUITAR PRO v5.10", ScoreFormat::Gp5),
        ];
        for (version, format) in cases {
            assert_eq!(
                ScoreFormat::detect(&gp_header(version)),
                Some(format),
                "{version}"
            );
        }
    }

    #[test]
    fn detects_gpx_and_gp7_containers() {
        assert_eq!(ScoreFormat::detect(b"BCFZ\x00\x01"), Some(ScoreFormat::Gpx));
        assert_eq!(ScoreFormat::detect(b"BCFS\x00\x01"), Some(ScoreFormat::Gpx));
        assert_eq!(
            ScoreFormat::detect(b"PK\x03\x04\x14\x00"),
            Some(ScoreFormat::Gp7)
        );
    }

    #[test]
    fn rejects_other_content() {
        for bytes in [
            &b""[..],
            b"\x00",
            b"%PDF-1.7",
            b"<html><body>score-partwise</body></html>",
            b"<?xml version=\"1.0\"?><svg/>",
            b"   ",
            &gp_header("FICHIER GUITARE PRO v1.04"),
            &gp_header("FICHIER GUITAR PRO v6.00"),
            &gp_header("FICHIER GUITAR PRO"),
        ] {
            assert_eq!(ScoreFormat::detect(bytes), None, "{bytes:?}");
        }
    }

    #[test]
    fn detects_midi_and_musicxml() {
        assert_eq!(
            ScoreFormat::detect(b"MThd\x00\x00\x00\x06"),
            Some(ScoreFormat::Midi)
        );
        let xml = b"\xEF\xBB\xBF \n<?xml version=\"1.0\"?>\n<!DOCTYPE score-partwise PUBLIC \"x\">\n<score-partwise version=\"4.0\">";
        assert_eq!(ScoreFormat::detect(xml), Some(ScoreFormat::MusicXml));
        let timewise = b"<score-timewise></score-timewise>";
        assert_eq!(ScoreFormat::detect(timewise), Some(ScoreFormat::MusicXml));
    }

    #[test]
    fn opens_text_musescore_and_capella_files_by_extension_and_content() {
        let dir = tempfile::tempdir().unwrap();
        let tex = write(&dir, "song.atex", b"\\title \"x\"\n\\track \"g\" :4 0.6");
        assert!(read(&tex).is_ok());
        let ascii = write(&dir, "tab.TXT", b"e|--0--|\nB|--1--|");
        assert!(read(&ascii).is_ok());
        let mscx = write(
            &dir,
            "score.mscx",
            b"<?xml version=\"1.0\"?>\n<museScore version=\"3.02\"><Score/></museScore>",
        );
        assert!(read(&mscx).is_ok());
        let mscz = write(&dir, "score.mscz", b"PK\x03\x04\x14\x00");
        assert!(read(&mscz).is_ok());
        let capx = write(&dir, "score.capx", b"PK\x03\x04\x14\x00");
        assert!(read(&capx).is_ok());
    }

    #[test]
    fn refuses_binary_files_named_like_text_and_other_xml_named_mscx() {
        let dir = tempfile::tempdir().unwrap();
        let binary = write(&dir, "tab.txt", b"abc\x00\x01\x02");
        assert_eq!(read(&binary).unwrap_err().kind, ErrorKind::NotAScore);
        let empty = write(&dir, "empty.atex", b"");
        assert_eq!(read(&empty).unwrap_err().kind, ErrorKind::NotAScore);
        let svg = write(&dir, "score.mscx", b"<?xml version=\"1.0\"?><svg/>");
        assert_eq!(read(&svg).unwrap_err().kind, ErrorKind::NotAScore);
        let text_as_zip = write(&dir, "score.mscz", b"not a zip");
        assert_eq!(read(&text_as_zip).unwrap_err().kind, ErrorKind::NotAScore);
    }

    #[test]
    fn accepts_midi_and_musicxml_extensions() {
        for name in [
            "a.mid",
            "a.MIDI",
            "a.musicxml",
            "a.xml",
            "a.mscx",
            "a.MSCZ",
            "a.atex",
            "a.capx",
            "a.txt",
        ] {
            assert!(has_supported_extension(Path::new(name)), "{name}");
        }
        assert!(!has_supported_extension(Path::new("a.mxl")));
    }

    #[test]
    fn rejects_a_truncated_header() {
        // The length byte promises more text than the file contains.
        let header = gp_header("FICHIER GUITAR PRO v5.00");
        assert_eq!(ScoreFormat::detect(&header[..10]), None);
    }

    #[test]
    fn accepts_guitar_pro_extensions_in_any_case() {
        for name in [
            "a.gp3", "a.gp4", "a.gp5", "a.gpx", "a.gp", "A.GP5", "song.Gp",
        ] {
            assert!(has_supported_extension(Path::new(name)), "{name}");
        }
        for name in ["a.pdf", "a.gp6", "a.gpk", "gp5", "a.gp5.zip", ".gp5x"] {
            assert!(!has_supported_extension(Path::new(name)), "{name}");
        }
    }

    #[test]
    fn reads_a_guitar_pro_file() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = gp_header("FICHIER GUITAR PRO v5.00");
        let path = write(&dir, "song.gp5", &bytes);

        assert_eq!(read(&path).unwrap(), bytes);
    }

    #[test]
    fn trusts_the_content_over_the_extension() {
        // Renamed files are common: a GP4 file saved as .gp5 still opens.
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "song.gp5", &gp_header("FICHIER GUITAR PRO v4.06"));

        assert!(read(&path).is_ok());
    }

    #[test]
    fn refuses_files_with_other_extensions_without_reading_them() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "id_rsa", b"-----BEGIN KEY-----");

        let error = read(&path).unwrap_err();
        assert_eq!(error.kind, ErrorKind::UnsupportedType);
        assert!(error.message.contains("id_rsa"));
    }

    #[test]
    fn refuses_non_guitar_pro_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "fake.gp5", b"just some text");

        assert_eq!(read(&path).unwrap_err().kind, ErrorKind::NotAScore);
    }

    #[test]
    fn reports_missing_files_and_directories_as_not_found() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            read(&dir.path().join("missing.gp5")).unwrap_err().kind,
            ErrorKind::NotFound
        );

        let folder = dir.path().join("folder.gp");
        fs::create_dir(&folder).unwrap();
        assert_eq!(read(&folder).unwrap_err().kind, ErrorKind::NotFound);
    }

    #[test]
    fn refuses_files_over_the_size_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("huge.gp");
        let file = File::create(&path).unwrap();
        file.set_len(MAX_SIZE + 1).unwrap(); // sparse: no real disk use

        let error = read(&path).unwrap_err();
        assert_eq!(error.kind, ErrorKind::TooLarge);
        assert!(error.message.contains("100 MB"));
    }
}
