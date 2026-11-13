//! Practice together sends the audio files of the lanes to the other players (ADR 0005).
//!
//! The page never holds a whole file (they can be hundreds of megabytes): the sender reads it in
//! pieces from the loaded copy ([`audio_source_chunk`]) and the receiver writes the pieces into a
//! file in the temporary folder ([`audio_stage_begin`], [`audio_stage_append`]), which is checked
//! against the file's SHA-256 (its id) and loaded like any other file ([`audio_stage_finish`]).
//! A transfer that stops can start again where it stopped: the staged file says how far it got.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::State;

use super::{AudioState, SourceInfo, add_source, audio_error, backing, sha256_hex};
use crate::error::{CommandError, ErrorKind};

/// The most bytes one piece carries.
const MAX_PIECE: usize = 1024 * 1024;

/// A file's id is its SHA-256 in lower case hex: nothing else is ever a path component here.
fn valid_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn checked_id(id: &str) -> Result<(), CommandError> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(audio_error("That is not the id of an audio file"))
    }
}

/// Where unfinished incoming files are kept (this run of the app only).
fn stage_dir() -> PathBuf {
    std::env::temp_dir().join(format!("smart-beat-incoming-{}", std::process::id()))
}

fn part_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.part"))
}

/// The size of a loaded audio file in bytes.
fn source_size(state: &AudioState, id: &str) -> Result<u64, CommandError> {
    checked_id(id)?;
    let inner = state.inner.lock().unwrap();
    let source = inner.sources.get(id).ok_or_else(|| {
        CommandError::new(ErrorKind::NotFound, "That audio file is not loaded here")
    })?;
    Ok(source.bytes.len() as u64)
}

/// `len` bytes of a loaded audio file from `offset` (fewer at the end of the file).
fn source_chunk(
    state: &AudioState,
    id: &str,
    offset: u64,
    len: usize,
) -> Result<Vec<u8>, CommandError> {
    checked_id(id)?;
    let inner = state.inner.lock().unwrap();
    let source = inner.sources.get(id).ok_or_else(|| {
        CommandError::new(ErrorKind::NotFound, "That audio file is not loaded here")
    })?;
    let bytes = &source.bytes;
    let start = usize::try_from(offset)
        .map_err(|_| audio_error("The offset is out of range"))?
        .min(bytes.len());
    let end = start.saturating_add(len.min(MAX_PIECE)).min(bytes.len());
    Ok(bytes[start..end].to_vec())
}

/// Starts (or continues) an incoming file: how many bytes of it are staged already.
fn stage_begin(dir: &Path, id: &str, size: u64) -> Result<u64, CommandError> {
    checked_id(id)?;
    if size == 0 || size > backing::MAX_FILE_BYTES as u64 {
        return Err(CommandError::new(
            ErrorKind::TooLarge,
            "The audio file is empty or too large",
        ));
    }
    std::fs::create_dir_all(dir).map_err(|e| audio_error(format!("No room for the file: {e}")))?;
    let path = part_path(dir, id);
    let have = std::fs::metadata(&path).map_or(0, |m| m.len());
    if have > size {
        // Not a part of this file: start over.
        std::fs::remove_file(&path).ok();
        return Ok(0);
    }
    Ok(have)
}

/// Adds the next piece of an incoming file; `offset` must be where the staged part ends.
fn stage_append(dir: &Path, id: &str, offset: u64, bytes: &[u8]) -> Result<u64, CommandError> {
    checked_id(id)?;
    if bytes.is_empty() || bytes.len() > MAX_PIECE {
        return Err(audio_error("The piece of the file has a wrong size"));
    }
    let path = part_path(dir, id);
    let have = std::fs::metadata(&path).map_or(0, |m| m.len());
    if have != offset {
        return Err(audio_error(format!(
            "The piece does not follow the staged file ({have} bytes, piece at {offset})"
        )));
    }
    let total = have + bytes.len() as u64;
    if total > backing::MAX_FILE_BYTES as u64 {
        std::fs::remove_file(&path).ok();
        return Err(CommandError::new(
            ErrorKind::TooLarge,
            "The audio file is too large",
        ));
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| audio_error(format!("The file cannot be written: {e}")))?;
    file.write_all(bytes)
        .map_err(|e| audio_error(format!("The file cannot be written: {e}")))?;
    Ok(total)
}

/// Checks the staged file against its id and loads it as an audio file.
fn stage_finish(
    state: &AudioState,
    dir: &Path,
    id: &str,
    name: &str,
) -> Result<SourceInfo, CommandError> {
    checked_id(id)?;
    let path = part_path(dir, id);
    let bytes = std::fs::read(&path)
        .map_err(|e| audio_error(format!("The received file cannot be read: {e}")))?;
    // Whatever happens next, the staged file is not kept.
    std::fs::remove_file(&path).ok();
    if sha256_hex(&bytes) != id {
        return Err(audio_error(
            "The received audio file is not the file that was offered",
        ));
    }
    add_source(state, name.to_owned(), bytes)
}

/// The size of a loaded audio file (to offer it to the other players).
#[tauri::command(async)]
pub fn audio_source_size(id: String, state: State<'_, AudioState>) -> Result<u64, CommandError> {
    source_size(&state, &id)
}

/// A piece of a loaded audio file as raw bytes.
#[tauri::command(async)]
pub fn audio_source_chunk(
    id: String,
    offset: u64,
    len: usize,
    state: State<'_, AudioState>,
) -> Result<tauri::ipc::Response, CommandError> {
    source_chunk(&state, &id, offset, len).map(tauri::ipc::Response::new)
}

/// Starts or continues an incoming file: returns how many bytes are staged already.
#[tauri::command(async)]
pub fn audio_stage_begin(id: String, size: u64) -> Result<u64, CommandError> {
    stage_begin(&stage_dir(), &id, size)
}

/// Adds a piece (raw bytes, headers `x-id` and `x-offset`) to an incoming file: returns the
/// bytes staged now.
#[tauri::command(async)]
pub fn audio_stage_append(request: tauri::ipc::Request<'_>) -> Result<u64, CommandError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(audio_error("The piece must be sent as raw bytes"));
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let id = header("x-id").ok_or_else(|| audio_error("The piece has no file id"))?;
    let offset = header("x-offset")
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| audio_error("The piece has no offset"))?;
    stage_append(&stage_dir(), &id, offset, bytes)
}

/// The incoming file is complete: checked against its id and loaded.
#[tauri::command(async)]
pub fn audio_stage_finish(
    id: String,
    name: String,
    state: State<'_, AudioState>,
) -> Result<SourceInfo, CommandError> {
    stage_finish(&state, &stage_dir(), &id, &name)
}

/// Gives up on an incoming file (or, without an id, on all of them): the staged parts go.
#[tauri::command(async)]
pub fn audio_stage_abort(id: Option<String>) -> Result<(), CommandError> {
    match id {
        Some(id) => {
            checked_id(&id)?;
            std::fs::remove_file(part_path(&stage_dir(), &id)).ok();
        }
        None => {
            std::fs::remove_dir_all(stage_dir()).ok();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn wav() -> Vec<u8> {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 8_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut writer = hound::WavWriter::new(&mut cursor, spec).unwrap();
            for i in 0..4_000 {
                let s =
                    ((i as f64 / 8_000.0 * 440.0 * std::f64::consts::TAU).sin() * 9_000.0) as i16;
                writer.write_sample(s).unwrap();
            }
            writer.finalize().unwrap();
        }
        cursor.into_inner()
    }

    fn state(dir: &Path) -> AudioState {
        AudioState::new(dir.join("library"))
    }

    #[test]
    fn a_file_is_sent_in_pieces_and_arrives_whole() {
        let dir = tempfile::tempdir().unwrap();
        let sender = state(&dir.path().join("a"));
        let receiver = state(&dir.path().join("b"));
        let bytes = wav();
        let info = add_source(&sender, "tone.wav".into(), bytes.clone()).unwrap();
        let stage = dir.path().join("stage");

        let size = source_size(&sender, &info.id).unwrap();
        assert_eq!(size, bytes.len() as u64);
        assert_eq!(stage_begin(&stage, &info.id, size).unwrap(), 0);
        let mut offset = 0u64;
        while offset < size {
            let piece = source_chunk(&sender, &info.id, offset, 1_500).unwrap();
            assert!(!piece.is_empty());
            offset = stage_append(&stage, &info.id, offset, &piece).unwrap();
        }
        let got = stage_finish(&receiver, &stage, &info.id, "tone.wav").unwrap();
        assert_eq!(got.id, info.id);
        assert!((got.duration_ms - info.duration_ms).abs() < 1.0);
        // The staged file is gone, and the file is in the receiver's pool.
        assert!(!part_path(&stage, &info.id).exists());
        assert_eq!(source_size(&receiver, &info.id).unwrap(), size);
    }

    #[test]
    fn a_transfer_that_stopped_continues_where_it_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let sender = state(&dir.path().join("a"));
        let bytes = wav();
        let info = add_source(&sender, "tone.wav".into(), bytes.clone()).unwrap();
        let stage = dir.path().join("stage");
        let size = bytes.len() as u64;
        stage_begin(&stage, &info.id, size).unwrap();
        let first = source_chunk(&sender, &info.id, 0, 3_000).unwrap();
        stage_append(&stage, &info.id, 0, &first).unwrap();
        // The line dropped: asking again says how far it got.
        let have = stage_begin(&stage, &info.id, size).unwrap();
        assert_eq!(have, 3_000);
        let rest = source_chunk(&sender, &info.id, have, 1_000_000).unwrap();
        assert_eq!(rest.len() as u64, size - have);
        stage_append(&stage, &info.id, have, &rest).unwrap();
        let receiver = state(&dir.path().join("b"));
        assert!(stage_finish(&receiver, &stage, &info.id, "tone.wav").is_ok());
    }

    #[test]
    fn a_piece_that_does_not_follow_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let id = "a".repeat(64);
        stage_begin(dir.path(), &id, 100).unwrap();
        stage_append(dir.path(), &id, 0, &[1, 2, 3]).unwrap();
        assert!(stage_append(dir.path(), &id, 0, &[4]).is_err());
        assert!(stage_append(dir.path(), &id, 9, &[4]).is_err());
        assert!(stage_append(dir.path(), &id, 3, &[]).is_err());
    }

    #[test]
    fn a_file_that_is_not_the_offered_one_is_refused_and_not_kept() {
        let dir = tempfile::tempdir().unwrap();
        let receiver = state(&dir.path().join("b"));
        let bytes = wav();
        // Offered under the id of another file.
        let id = sha256_hex(b"something else");
        stage_begin(dir.path(), &id, bytes.len() as u64).unwrap();
        stage_append(dir.path(), &id, 0, &bytes[..1_000]).unwrap();
        stage_append(dir.path(), &id, 1_000, &bytes[1_000..]).unwrap();
        let err = stage_finish(&receiver, dir.path(), &id, "x.wav").unwrap_err();
        assert!(err.message.contains("not the file that was offered"));
        assert!(!part_path(dir.path(), &id).exists());
        assert!(source_size(&receiver, &id).is_err());
    }

    #[test]
    fn an_id_that_is_not_a_hash_never_reaches_the_disk() {
        let dir = tempfile::tempdir().unwrap();
        for bad in ["../x", "", "A".repeat(64).as_str(), &"g".repeat(64), "a/b"] {
            assert!(stage_begin(dir.path(), bad, 10).is_err(), "{bad}");
            assert!(stage_append(dir.path(), bad, 0, &[1]).is_err(), "{bad}");
        }
        let receiver = state(dir.path());
        assert!(source_chunk(&receiver, "../x", 0, 1).is_err());
        assert!(stage_finish(&receiver, dir.path(), "../x", "x").is_err());
    }

    #[test]
    fn size_limits_hold() {
        let dir = tempfile::tempdir().unwrap();
        let id = "b".repeat(64);
        assert!(stage_begin(dir.path(), &id, 0).is_err());
        assert!(stage_begin(dir.path(), &id, backing::MAX_FILE_BYTES as u64 + 1).is_err());
        assert!(stage_append(dir.path(), &id, 0, &vec![0; MAX_PIECE + 1]).is_err());
    }

    #[test]
    fn a_staged_part_longer_than_the_file_starts_over() {
        let dir = tempfile::tempdir().unwrap();
        let id = "c".repeat(64);
        stage_begin(dir.path(), &id, 100).unwrap();
        stage_append(dir.path(), &id, 0, &[7; 50]).unwrap();
        // The same id is offered again with a smaller size: the old part cannot be of it.
        assert_eq!(stage_begin(dir.path(), &id, 10).unwrap(), 0);
    }

    #[test]
    fn a_chunk_past_the_end_is_empty_and_the_last_one_is_short() {
        let dir = tempfile::tempdir().unwrap();
        let sender = state(dir.path());
        let bytes = wav();
        let info = add_source(&sender, "tone.wav".into(), bytes.clone()).unwrap();
        let end = bytes.len() as u64;
        assert!(source_chunk(&sender, &info.id, end, 10).unwrap().is_empty());
        assert_eq!(
            source_chunk(&sender, &info.id, end - 4, 100).unwrap().len(),
            4
        );
        assert!(source_chunk(&sender, &"d".repeat(64), 0, 10).is_err());
    }
}
