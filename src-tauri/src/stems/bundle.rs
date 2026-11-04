//! Saving a separation for good: one `<Song name>.sbstems` file (issue #186).
//!
//! The file is a ZIP with every entry stored, not deflated (FLAC and the original audio do not
//! shrink, and a stored entry can be read straight from the file):
//!
//! ```text
//! manifest.json            what the song is and how to check every entry (see [`Manifest`])
//! stems/<kind>.flac        one lossless 16-bit stereo stem each (codec "wav" is also read)
//! original/<file name>     the audio file the stems were made from (optional)
//! state.json               the mixer state of the page, as the page wrote it (optional)
//! ```
//!
//! The cache ([`StemStore`]) stays the working copy: saving pins the cached song and opening a
//! file unpacks it into the cache under its id. Entries this version does not know are
//! ignored, a `version` above [`VERSION`] is refused (`docs/file-formats.md`). Entry names are
//! never used as paths: a stem is looked up under the one name its kind and codec give.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Runtime, State};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use super::store::{self, StemStore, hex};
use super::wav::{Pcm16, WavSink};
use super::{StemEngine, StemInfo, StemSong, StemsRun, codec, now_ms};
use crate::audio::backing;
use crate::error::{CommandError, ErrorKind};
use crate::separation::StemKind;

/// The extension of the file, without the dot. Registered in `tauri.conf.json`.
pub const EXTENSION: &str = "sbstems";
pub const FORMAT: &str = "smart-beat-stems";
/// The newest manifest version this build writes and reads.
pub const VERSION: u32 = 1;
/// The message of a save or open that was stopped.
pub const STOPPED: &str = "Stem file stopped.";
/// Sent while a file is written (`"writing"`) or unpacked (`"reading"`).
pub const PROGRESS_EVENT: &str = "stems-bundle-progress";

const MANIFEST: &str = "manifest.json";
const STATE: &str = "state.json";
const ORIGINAL_DIR: &str = "original/";
/// Largest manifest or state entry read.
const MAX_JSON_BYTES: u64 = 1024 * 1024;
/// A stem is a WAV file in the cache, so it has at most this many frames (4 bytes each).
const MAX_FRAMES: u64 = (u32::MAX as u64 - 36) / 4;
/// The stems are 16-bit stereo, mono sources included (they are doubled).
const CHANNELS: u8 = 2;
/// Stems get this much of the progress bar when the original is embedded too.
const STEM_SHARE: f32 = 0.9;

/// Mirrored by `StemBundleSaveRequest` in `src/lib/tauri.ts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    /// The song in the cache.
    pub id: String,
    /// Where to write the file; `.sbstems` is added when the name does not end in it.
    pub dest: String,
    /// Embed the audio file the stems were made from, when it can still be found.
    pub include_original: bool,
    /// The mixer state to keep with the song, any JSON object the page can read back.
    #[serde(default)]
    pub state: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub path: String,
    pub bytes: u64,
    /// False when it was not asked for, or when the source file is gone or changed.
    pub original_included: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    /// The [`StemEngine`] name: `fast`, `neural`, `scnet`, `scnet-xl`, `htdemucs` or `htdemucs-6s`.
    pub id: String,
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub model_sha256: Option<String>,
    #[serde(default)]
    pub algorithm_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StemEntry {
    pub kind: StemKind,
    /// The entry name: `stems/<kind>.<codec>`.
    pub file: String,
    /// `flac` or `wav`.
    pub codec: String,
    /// Size of the entry.
    pub bytes: u64,
    /// SHA-256 of the entry, lower-case hex.
    pub sha256: String,
    pub frames: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginalInfo {
    /// The file is in the bundle as `original/<file name>`.
    #[serde(default)]
    pub embedded: bool,
    /// Name of the audio file the stems were made from, when known.
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub bytes: u64,
}

/// `manifest.json`. Unknown fields are ignored on read.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub version: u32,
    /// The cache id of the song.
    pub id: String,
    pub name: String,
    pub duration_seconds: f64,
    pub sample_rate: u32,
    /// Channels of the stems: always 2.
    pub channels: u8,
    /// The source was mono (the stems are doubled to stereo).
    pub mono: bool,
    pub created_at_ms: u64,
    pub app_version: String,
    pub engine: EngineInfo,
    pub strong_drums: bool,
    #[serde(default)]
    pub skipped: Vec<StemKind>,
    #[serde(default)]
    pub panned_share: f32,
    pub stems: Vec<StemEntry>,
    #[serde(default)]
    pub original: OriginalInfo,
}

fn fail(kind: ErrorKind, message: impl Into<String>) -> CommandError {
    CommandError::new(kind, message)
}

fn io_fail(what: &str, e: impl std::fmt::Display) -> CommandError {
    fail(ErrorKind::Io, format!("{what}: {e}"))
}

fn stopped() -> CommandError {
    fail(ErrorKind::Audio, STOPPED)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned()
}

/// Whether `path` ends in `.sbstems` (case-insensitive).
pub fn is_bundle(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(EXTENSION))
}

/// A file name that is safe as an entry name: no folder parts, no control characters.
fn is_plain_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\'])
        && !name.chars().any(char::is_control)
}

fn is_sha256(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn stem_entry_name(kind: StemKind, codec: &str) -> String {
    format!("stems/{}.{codec}", kind.id())
}

/// Checks everything in the manifest that the rest of the code relies on.
fn validate(m: &Manifest) -> Result<(), String> {
    if !store::is_valid_id(&m.id) {
        return Err("it has no valid song id".into());
    }
    if StemEngine::deserialize(Value::String(m.engine.id.clone())).is_err() {
        return Err(format!(
            "it was made with an unknown engine “{}”",
            m.engine.id
        ));
    }
    if !(1..=655_350).contains(&m.sample_rate) || m.channels != CHANNELS {
        return Err("its audio format is not supported".into());
    }
    if !m.duration_seconds.is_finite() || !(0.0..=48.0 * 3600.0).contains(&m.duration_seconds) {
        return Err("its duration is not valid".into());
    }
    if m.stems.is_empty() || m.stems.len() > StemKind::ALL.len() {
        return Err("it has no stems".into());
    }
    for (i, stem) in m.stems.iter().enumerate() {
        if m.stems[..i].iter().any(|s| s.kind == stem.kind) {
            return Err(format!("the {} stem is listed twice", stem.kind.id()));
        }
        let name_ok = matches!(stem.codec.as_str(), "flac" | "wav")
            && stem.file == stem_entry_name(stem.kind, &stem.codec);
        if !name_ok {
            return Err(format!("“{}” is not a valid stem file name", stem.file));
        }
        if !is_sha256(&stem.sha256)
            || stem.bytes == 0
            || stem.frames == 0
            || stem.frames > MAX_FRAMES
        {
            return Err(format!("the {} stem is described wrongly", stem.kind.id()));
        }
    }
    let o = &m.original;
    if o.embedded
        && !(o.file_name.as_deref().is_some_and(is_plain_name)
            && o.sha256.as_deref().is_some_and(is_sha256))
    {
        return Err("its original audio is described wrongly".into());
    }
    Ok(())
}

/// The `manifest.json` of an opened archive, checked.
fn read_manifest<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Result<Manifest, CommandError> {
    let not_ours = || {
        fail(
            ErrorKind::UnsupportedType,
            format!("“{name}” is not a Smart Beat stems file."),
        )
    };
    let bytes = read_entry(archive, MANIFEST, MAX_JSON_BYTES)
        .map_err(|_| not_ours())?
        .ok_or_else(not_ours)?;
    // The header first: a newer version may have a manifest this one cannot parse at all.
    let header: Value = serde_json::from_slice(&bytes).map_err(|_| not_ours())?;
    if header.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err(not_ours());
    }
    let version = header.get("version").and_then(Value::as_u64).unwrap_or(0);
    if version == 0 {
        return Err(not_ours());
    }
    if version > u64::from(VERSION) {
        return Err(fail(
            ErrorKind::UnsupportedType,
            format!(
                "“{name}” was saved by a newer version of Smart Beat. Update the app to open it."
            ),
        ));
    }
    let manifest: Manifest = serde_json::from_value(header).map_err(|e| {
        fail(
            ErrorKind::UnsupportedType,
            format!("“{name}” is damaged: its description cannot be read ({e})."),
        )
    })?;
    validate(&manifest).map_err(|why| {
        fail(
            ErrorKind::UnsupportedType,
            format!("“{name}” is damaged: {why}."),
        )
    })?;
    Ok(manifest)
}

/// An entry's bytes, at most `limit`. `None` when there is no such entry.
fn read_entry<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    entry: &str,
    limit: u64,
) -> Result<Option<Vec<u8>>, String> {
    let file = match archive.by_name(entry) {
        Ok(file) => file,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if file.size() > limit {
        return Err(format!("{entry} is too large"));
    }
    let mut bytes = Vec::with_capacity(file.size() as usize);
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err(format!("{entry} is too large"));
    }
    Ok(Some(bytes))
}

/// Emits a fraction at most about once per percent.
struct Throttle<'a> {
    last: f32,
    emit: &'a mut dyn FnMut(f32),
}

impl<'a> Throttle<'a> {
    fn new(emit: &'a mut dyn FnMut(f32)) -> Self {
        Self { last: -1.0, emit }
    }

    fn at(&mut self, fraction: f32) {
        let fraction = fraction.clamp(0.0, 1.0);
        if fraction - self.last >= 0.01 || fraction >= 1.0 {
            self.last = fraction;
            (self.emit)(fraction);
        }
    }
}

/// Whether `e` (or what caused it) is a full disk. A full disk is the one write failure with a
/// remedy the user knows, so it gets its own message.
fn is_disk_full<E: std::error::Error + 'static>(e: &E) -> bool {
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(error) = current {
        if let Some(io) = error.downcast_ref::<std::io::Error>()
            && io.kind() == std::io::ErrorKind::StorageFull
        {
            return true;
        }
        if let Some(zip::result::ZipError::Io(io)) = error.downcast_ref::<zip::result::ZipError>()
            && io.kind() == std::io::ErrorKind::StorageFull
        {
            return true;
        }
        current = error.source();
    }
    false
}

const DISK_FULL: &str = "There is not enough free space to save the stems file.";

fn write_err<E: std::error::Error + 'static>(e: &E) -> CommandError {
    if is_disk_full(e) {
        fail(ErrorKind::Io, DISK_FULL)
    } else {
        io_fail("The file could not be written", e)
    }
}

/// A file being written next to its destination. Removed unless it is renamed into place.
/// In a folder a cloud client watches, the name is one such clients skip: hidden (leading dot)
/// and `.tmp` (`.Song.sbstems.1234-0.tmp`); the rename into place is what they upload.
struct TempFile {
    path: PathBuf,
    keep: bool,
}

impl TempFile {
    fn beside(dest: &Path) -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let name = format!(".{}.{}-{n}.tmp", file_name(dest), std::process::id());
        Self {
            path: dest.with_file_name(name),
            keep: false,
        }
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn stored(len: u64) -> SimpleFileOptions {
    SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .large_file(len >= u64::from(u32::MAX))
}

fn with_extension(dest: &str) -> PathBuf {
    let path = PathBuf::from(dest);
    if is_bundle(&path) {
        path
    } else {
        let mut name = path.into_os_string();
        name.push(format!(".{EXTENSION}"));
        PathBuf::from(name)
    }
}

/// The audio file the stems were made from: its name and bytes, from the source file or, when
/// that is gone or has changed, from the `.sbstems` file the song was opened from. `None` when
/// neither has it.
fn find_original(store: &StemStore, song: &StemSong) -> Option<(String, Vec<u8>)> {
    let size_ok = |len: u64| len <= backing::MAX_FILE_BYTES as u64;
    if let Some(source) = store.source(&song.id) {
        let path = Path::new(&source.path);
        let name = path.file_name()?.to_string_lossy().into_owned();
        let fits = std::fs::metadata(path).is_ok_and(|m| m.is_file() && size_ok(m.len()));
        if fits
            && let Ok(bytes) = std::fs::read(path)
            && hex(&Sha256::digest(&bytes)) == source.sha256
            && is_plain_name(&name)
        {
            return Some((name, bytes));
        }
    }
    let saved = Path::new(song.saved_path.as_deref()?);
    let mut archive = ZipArchive::new(BufReader::new(File::open(saved).ok()?)).ok()?;
    let manifest = read_manifest(&mut archive, "bundle").ok()?;
    if manifest.id != song.id || !manifest.original.embedded {
        return None;
    }
    let name = manifest.original.file_name?;
    let bytes = read_entry(
        &mut archive,
        &format!("{ORIGINAL_DIR}{name}"),
        backing::MAX_FILE_BYTES as u64,
    )
    .ok()??;
    let sha = manifest.original.sha256?;
    (hex(&Sha256::digest(&bytes)) == sha).then_some((name, bytes))
}

fn engine_info(engine: StemEngine) -> EngineInfo {
    let id = serde_json::to_value(engine)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();
    let (model_id, model_sha256) = match engine.onnx_model() {
        Some(model) => (
            Some(model.id().to_owned()),
            // Empty while a model's file is not published yet.
            Some(model.info().file.sha256.to_owned()).filter(|s| !s.is_empty()),
        ),
        None if engine == StemEngine::Neural => (Some("umx-hq".to_owned()), None),
        None => (None, None),
    };
    EngineInfo {
        id,
        model_id,
        model_sha256,
        algorithm_version: u32::from(store::ALGORITHM_VERSION),
    }
}

/// Writes the song `request.id` of the cache to `request.dest` as a `.sbstems` file and pins the
/// song. The file is written next to its destination and renamed into place, so a failed or
/// stopped save leaves nothing behind (and an older file of that name untouched).
/// `emit` receives the progress, `cancel` stops the save with [`STOPPED`].
pub fn save(
    store: &StemStore,
    request: &SaveRequest,
    app_version: &str,
    cancel: &AtomicBool,
    emit: &mut dyn FnMut(f32),
) -> Result<SaveResult, CommandError> {
    let song = store
        .get(&request.id)
        .ok_or_else(|| fail(ErrorKind::NotFound, "That song is not saved any more."))?;
    let dest = with_extension(&request.dest);
    if dest.is_dir() {
        return Err(fail(ErrorKind::Io, "There is a folder with that name."));
    }
    if dest
        .parent()
        .is_some_and(|p| !p.as_os_str().is_empty() && !p.is_dir())
    {
        return Err(fail(
            ErrorKind::NotFound,
            "The folder to save in does not exist.",
        ));
    }
    let state = match &request.state {
        None | Some(Value::Null) => None,
        Some(value) => {
            let json = serde_json::to_vec_pretty(value).map_err(|e| io_fail("The state", e))?;
            if json.len() as u64 > MAX_JSON_BYTES {
                return Err(fail(ErrorKind::TooLarge, "The mixer state is too large."));
            }
            Some(json)
        }
    };
    let mut progress = Throttle::new(emit);
    progress.at(0.0);

    let temp = TempFile::beside(&dest);
    let out = File::create(&temp.path).map_err(|e| {
        if is_disk_full(&e) {
            fail(ErrorKind::Io, DISK_FULL)
        } else {
            io_fail("The file cannot be created", e)
        }
    })?;
    let mut zip = ZipWriter::new(BufWriter::with_capacity(1 << 20, out));

    // The stems, one at a time: only one encoded stem is in memory.
    let total: u64 = song
        .stems
        .iter()
        .map(|s| s.bytes.saturating_sub(44) / 4)
        .sum();
    let share = if request.include_original {
        STEM_SHARE
    } else {
        1.0
    };
    let mut done = 0u64;
    let mut entries = Vec::new();
    for info in &song.stems {
        if cancel.load(Ordering::Relaxed) {
            return Err(stopped());
        }
        let wav = store
            .stem_path(&song.id, info.kind)
            .map_err(|e| fail(ErrorKind::Io, e))?;
        let base = done;
        let frames = Pcm16::open(&wav)
            .map_err(|e| fail(ErrorKind::Io, e))?
            .frames;
        // Too short for FLAC (a few milliseconds): kept as the WAV file it is.
        let (codec_name, bytes) = if frames < codec::MIN_FRAMES {
            let bytes = std::fs::read(&wav).map_err(|e| io_fail("A stem cannot be read", e))?;
            ("wav", bytes)
        } else {
            let encoded = codec::encode_wav(&wav, cancel, STOPPED, &mut |n| {
                progress.at((base + n) as f32 / total.max(1) as f32 * share);
            })
            .map_err(|e| {
                if e == STOPPED {
                    stopped()
                } else {
                    fail(ErrorKind::Audio, e)
                }
            })?;
            ("flac", encoded.bytes)
        };
        done += frames;
        let file = stem_entry_name(info.kind, codec_name);
        zip.start_file(&file, stored(bytes.len() as u64))
            .map_err(|e| write_err(&e))?;
        zip.write_all(&bytes).map_err(|e| write_err(&e))?;
        entries.push(StemEntry {
            kind: info.kind,
            file,
            codec: codec_name.into(),
            bytes: bytes.len() as u64,
            sha256: hex(&Sha256::digest(&bytes)),
            frames,
        });
    }

    // The original, when asked for and still there.
    let mut original = OriginalInfo::default();
    if request.include_original {
        progress.at(STEM_SHARE);
        match find_original(store, &song) {
            Some((name, bytes)) => {
                zip.start_file(format!("{ORIGINAL_DIR}{name}"), stored(bytes.len() as u64))
                    .map_err(|e| write_err(&e))?;
                zip.write_all(&bytes).map_err(|e| write_err(&e))?;
                original = OriginalInfo {
                    embedded: true,
                    sha256: Some(hex(&Sha256::digest(&bytes))),
                    bytes: bytes.len() as u64,
                    file_name: Some(name),
                };
            }
            None => {
                if let Some(source) = store.source(&song.id) {
                    original.file_name = Path::new(&source.path)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .filter(|n| is_plain_name(n));
                    original.sha256 = Some(source.sha256);
                }
            }
        }
    }
    if cancel.load(Ordering::Relaxed) {
        return Err(stopped());
    }

    if let Some(json) = &state {
        zip.start_file(STATE, stored(json.len() as u64))
            .map_err(|e| write_err(&e))?;
        zip.write_all(json).map_err(|e| write_err(&e))?;
    }
    let manifest = Manifest {
        format: FORMAT.into(),
        version: VERSION,
        id: song.id.clone(),
        name: song.name.clone(),
        duration_seconds: song.duration_seconds,
        sample_rate: song.sample_rate,
        channels: CHANNELS,
        mono: song.mono,
        created_at_ms: song.created_at_ms,
        app_version: app_version.to_owned(),
        engine: engine_info(song.engine),
        strong_drums: song.strong_drums,
        skipped: song.skipped.clone(),
        panned_share: song.panned_share,
        stems: entries,
        original: original.clone(),
    };
    let json = serde_json::to_vec_pretty(&manifest).map_err(|e| io_fail("The manifest", e))?;
    zip.start_file(MANIFEST, stored(json.len() as u64))
        .map_err(|e| write_err(&e))?;
    zip.write_all(&json).map_err(|e| write_err(&e))?;

    let file = zip
        .finish()
        .map_err(|e| write_err(&e))?
        .into_inner()
        .map_err(|e| write_err(e.error()))?;
    file.sync_all().map_err(|e| write_err(&e))?;
    drop(file);
    std::fs::rename(&temp.path, &dest).map_err(|e| io_fail("The file cannot be saved", e))?;
    let mut temp = temp;
    temp.keep = true;
    let bytes = std::fs::metadata(&dest).map_or(0, |m| m.len());

    // From now on the song is kept: pinned in the cache, and it knows where its file is. The
    // song may have been deleted from the cache in the meantime; the file is fine then.
    let saved_path = dest.to_string_lossy().into_owned();
    let _ = store.update(&song.id, |s| {
        s.pinned = true;
        s.saved_path = Some(saved_path.clone());
        // What `has_original` keeps on disk: the file of the song has the original.
        s.has_original = original.embedded;
    });
    progress.at(1.0);
    Ok(SaveResult {
        path: saved_path,
        bytes,
        original_included: original.embedded,
    })
}

/// Mirrored by `StemBundleEstimate` in `src/lib/tauri.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    /// About how many bytes the file will have. An estimate, not a promise.
    pub bytes: u64,
}

/// An ESTIMATE of the size of the `.sbstems` file for the song `id`, for "about 80 MB" in the
/// Save dialog. FLAC takes about half of the cache's 16-bit WAV files, so it is half of their
/// size, plus the original audio when `include_original` is set and it can still be found (the
/// source file, or the file the song was opened from). Only file sizes are looked at; the actual
/// size depends on the music and is usually within a few tens of percent.
pub fn estimate(
    store: &StemStore,
    id: &str,
    include_original: bool,
) -> Result<Estimate, CommandError> {
    let song = store
        .get(id)
        .ok_or_else(|| fail(ErrorKind::NotFound, "That song is not saved any more."))?;
    let wav: u64 = song.stems.iter().map(|s| s.bytes).sum();
    let mut bytes = wav / 2;
    if include_original {
        bytes += original_size(store, &song).unwrap_or(0);
    }
    Ok(Estimate { bytes })
}

/// The size of the audio file [`find_original`] would embed, without reading it.
fn original_size(store: &StemStore, song: &StemSong) -> Option<u64> {
    if let Some(source) = store.source(&song.id)
        && let Ok(metadata) = std::fs::metadata(&source.path)
        && metadata.is_file()
        && metadata.len() <= backing::MAX_FILE_BYTES as u64
    {
        return Some(metadata.len());
    }
    let saved = Path::new(song.saved_path.as_deref()?);
    let mut archive = ZipArchive::new(BufReader::new(File::open(saved).ok()?)).ok()?;
    let manifest = read_manifest(&mut archive, "bundle").ok()?;
    (manifest.id == song.id && manifest.original.embedded).then_some(manifest.original.bytes)
}

/// Reads an entry that must be there, checks its size and SHA-256 against the manifest.
fn read_stem<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    entry: &StemEntry,
    bundle: &str,
) -> Result<Vec<u8>, CommandError> {
    let damaged = |why: &str| {
        fail(
            ErrorKind::Io,
            format!("“{bundle}” is damaged: the {} stem {why}.", entry.kind.id()),
        )
    };
    let bytes = read_entry(archive, &entry.file, entry.bytes)
        .map_err(|_| damaged("cannot be read"))?
        .ok_or_else(|| damaged("is missing"))?;
    if bytes.len() as u64 != entry.bytes {
        return Err(damaged("has the wrong size"));
    }
    if hex(&Sha256::digest(&bytes)) != entry.sha256 {
        return Err(damaged("does not match its checksum"));
    }
    Ok(bytes)
}

/// Marks a song that is in the cache already as opened from `path`.
fn mark_opened(
    store: &StemStore,
    song: &StemSong,
    path: &str,
    embedded: bool,
) -> Result<StemSong, CommandError> {
    store
        .update(&song.id, |s| {
            s.pinned = true;
            s.last_opened = Some(now_ms());
            s.saved_path = Some(path.to_owned());
            s.has_original = embedded;
        })
        .map_err(|e| fail(ErrorKind::Io, e))
}

/// Opens a `.sbstems` file: the song goes into the cache under its id (pinned) and comes back.
/// A song that is in the cache already is not unpacked again. The original audio stays in the
/// file. `emit` receives the progress, `cancel` stops the work with [`STOPPED`].
pub fn open(
    store: &StemStore,
    path: &Path,
    cancel: &AtomicBool,
    emit: &mut dyn FnMut(f32),
) -> Result<StemSong, CommandError> {
    let name = file_name(path);
    let file = File::open(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            fail(ErrorKind::NotFound, format!("“{name}” does not exist."))
        }
        _ => io_fail(&format!("“{name}” cannot be opened"), e),
    })?;
    let mut archive = ZipArchive::new(BufReader::new(file)).map_err(|_| {
        fail(
            ErrorKind::UnsupportedType,
            format!("“{name}” is not a Smart Beat stems file."),
        )
    })?;
    let manifest = read_manifest(&mut archive, &name)?;
    let saved_path = path.to_string_lossy().into_owned();
    let mut progress = Throttle::new(emit);
    progress.at(0.0);
    if let Some(song) = store.get(&manifest.id) {
        let song = mark_opened(store, &song, &saved_path, manifest.original.embedded)?;
        progress.at(1.0);
        return Ok(song);
    }

    let staging = store
        .staging(&manifest.id)
        .map_err(|e| fail(ErrorKind::Io, e))?;
    let mut sink = WavSink::new(staging.path(), manifest.sample_rate);
    let total: u64 = manifest.stems.iter().map(|s| s.frames).sum();
    let mut done = 0u64;
    let mut kept: Vec<StemInfo> = Vec::new();
    for entry in &manifest.stems {
        if cancel.load(Ordering::Relaxed) {
            return Err(stopped());
        }
        let bytes = read_stem(&mut archive, entry, &name)?;
        let damaged = |why: String| {
            fail(
                ErrorKind::Io,
                format!("“{name}” is damaged: the {} stem {why}.", entry.kind.id()),
            )
        };
        let base = done;
        let frames = if entry.codec == "flac" {
            let decoded =
                codec::decode_flac(bytes, entry.kind, &mut sink, cancel, STOPPED, &mut |n| {
                    progress.at((base + n) as f32 / total.max(1) as f32);
                })
                .map_err(|e| {
                    if e == STOPPED {
                        stopped()
                    } else {
                        fail(ErrorKind::Io, format!("“{name}”: {e}"))
                    }
                })?;
            if decoded.rate != manifest.sample_rate {
                return Err(damaged("has another sample rate than the song".into()));
            }
            decoded.frames
        } else {
            // A WAV stem is already what the cache keeps: check it and put it in place.
            let dest = staging.path().join(format!("{}.wav", entry.kind.id()));
            std::fs::write(&dest, &bytes)
                .map_err(|e| io_fail("The stems could not be saved", e))?;
            let pcm = Pcm16::open(&dest).map_err(damaged)?;
            if pcm.rate != manifest.sample_rate {
                return Err(damaged("has another sample rate than the song".into()));
            }
            kept.push(StemInfo {
                kind: entry.kind,
                bytes: bytes.len() as u64,
            });
            pcm.frames
        };
        if frames != entry.frames {
            return Err(damaged(format!(
                "has {frames} frames, not the {} it should have",
                entry.frames
            )));
        }
        done += frames;
        progress.at(done as f32 / total.max(1) as f32);
    }
    let mut stems = sink.finish().map_err(|e| fail(ErrorKind::Io, e))?;
    stems.extend(kept);
    stems.sort_by_key(|s| s.kind);

    let song = StemSong {
        id: manifest.id.clone(),
        name: if manifest.name.trim().is_empty() {
            path.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        } else {
            manifest.name.clone()
        },
        duration_seconds: manifest.duration_seconds,
        sample_rate: manifest.sample_rate,
        engine: serde_json::from_value(Value::String(manifest.engine.id.clone()))
            .map_err(|e| fail(ErrorKind::UnsupportedType, e.to_string()))?,
        strong_drums: manifest.strong_drums,
        bytes: stems.iter().map(|s| s.bytes).sum(),
        stems,
        mono: manifest.mono,
        skipped: manifest.skipped.clone(),
        panned_share: if manifest.panned_share.is_finite() {
            manifest.panned_share.clamp(0.0, 1.0)
        } else {
            0.0
        },
        created_at_ms: manifest.created_at_ms,
        pinned: true,
        last_opened: Some(now_ms()),
        saved_path: Some(saved_path),
        has_original: manifest.original.embedded,
        tempo: None,
    };
    store
        .commit(staging, &song)
        .map_err(|e| fail(ErrorKind::Io, e))?;
    progress.at(1.0);
    Ok(song)
}

/// The mixer state saved with the song, if the file has one and it is readable JSON.
pub fn read_state(path: &Path) -> Result<Option<Value>, CommandError> {
    let name = file_name(path);
    let file = File::open(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            fail(ErrorKind::NotFound, format!("“{name}” does not exist."))
        }
        _ => io_fail(&format!("“{name}” cannot be opened"), e),
    })?;
    let mut archive = ZipArchive::new(BufReader::new(file)).map_err(|_| {
        fail(
            ErrorKind::UnsupportedType,
            format!("“{name}” is not a Smart Beat stems file."),
        )
    })?;
    read_manifest(&mut archive, &name)?;
    let bytes = read_entry(&mut archive, STATE, MAX_JSON_BYTES).unwrap_or(None);
    Ok(bytes.and_then(|b| serde_json::from_slice(&b).ok()))
}

#[derive(Clone, Copy, Serialize)]
struct Progress {
    stage: &'static str,
    fraction: f32,
}

/// Saves a cached song as a `.sbstems` file. Emits `stems-bundle-progress`
/// (`{ stage: "writing", fraction }`). Stopped by `stems_cancel` with [`STOPPED`].
#[tauri::command]
pub async fn stems_save_bundle<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, StemStore>,
    run: State<'_, StemsRun>,
    request: SaveRequest,
) -> Result<SaveResult, CommandError> {
    let store = store.inner().clone();
    let version = app.package_info().version.to_string();
    let stop = run.start_bundle();
    let worker = {
        let stop = stop.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut emit = |fraction: f32| {
                let _ = app.emit(
                    PROGRESS_EVENT,
                    Progress {
                        stage: "writing",
                        fraction,
                    },
                );
            };
            save(&store, &request, &version, &stop, &mut emit)
        })
    };
    let result = worker.await;
    run.finish_bundle(&stop);
    result.unwrap_or_else(|_| Err(fail(ErrorKind::Io, "The stems could not be saved.")))
}

/// Opens a `.sbstems` file and returns its song. Emits `stems-bundle-progress`
/// (`{ stage: "reading", fraction }`). Stopped by `stems_cancel` with [`STOPPED`].
#[tauri::command]
pub async fn stems_open_bundle<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, StemStore>,
    run: State<'_, StemsRun>,
    path: String,
) -> Result<StemSong, CommandError> {
    let store = store.inner().clone();
    let stop = run.start_bundle();
    let worker = {
        let stop = stop.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut emit = |fraction: f32| {
                let _ = app.emit(
                    PROGRESS_EVENT,
                    Progress {
                        stage: "reading",
                        fraction,
                    },
                );
            };
            wait_if_evicted(&app, Path::new(&path))?;
            open(&store, Path::new(&path), &stop, &mut emit)
        })
    };
    let result = worker.await;
    run.finish_bundle(&stop);
    result.unwrap_or_else(|_| Err(fail(ErrorKind::Io, "The stems file could not be opened.")))
}

/// The mixer state stored in a `.sbstems` file, or `null`.
#[tauri::command(async)]
pub fn stems_bundle_state<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<Option<Value>, CommandError> {
    wait_if_evicted(&app, Path::new(&path))?;
    read_state(Path::new(&path))
}

/// An ESTIMATE of the size of the file `stems_save_bundle` would write, `{ bytes }`, for the Save
/// dialog. See [`estimate`].
#[tauri::command(async)]
pub fn stems_estimate_bundle(
    store: State<'_, StemStore>,
    id: String,
    include_original: bool,
) -> Result<Estimate, CommandError> {
    estimate(&store, &id, include_original)
}

/// A file in the linked cloud folder may be online-only (an evicted iCloud file): waits for it to
/// download, sending `cloud-download-waiting` (the path) once, as opening a tab does. Other
/// drives download on first read, which the read waits for. A file that is just missing is let
/// through to the reader's own message.
fn wait_if_evicted<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<(), CommandError> {
    crate::cloud_folder::wait_if_evicted(
        path,
        crate::cloud_folder::DOWNLOAD_TIMEOUT,
        crate::cloud_folder::request_icloud_download,
        || {
            let _ = app.emit(
                crate::cloud_folder::DOWNLOAD_WAITING_EVENT,
                path.to_string_lossy().into_owned(),
            );
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stems::codec::tests::{signal, write_pcm};
    use crate::stems::store::Source;

    const ID: &str = "0123456789abcdef";

    /// A song in the cache with the given stems (kind, interleaved samples), at 44.1 kHz.
    fn cached(store: &StemStore, id: &str, stems: &[(StemKind, Vec<i16>)]) -> StemSong {
        let staging = store.staging(id).unwrap();
        let mut infos = Vec::new();
        for (kind, samples) in stems {
            let path = staging.path().join(format!("{}.wav", kind.id()));
            write_pcm(&path, 44_100, samples);
            infos.push(StemInfo {
                kind: *kind,
                bytes: std::fs::metadata(&path).unwrap().len(),
            });
        }
        let song = StemSong {
            id: id.into(),
            name: "Band Song".into(),
            duration_seconds: stems[0].1.len() as f64 / 2.0 / 44_100.0,
            sample_rate: 44_100,
            engine: StemEngine::Htdemucs,
            strong_drums: false,
            bytes: infos.iter().map(|s| s.bytes).sum(),
            stems: infos,
            mono: false,
            skipped: vec![StemKind::Panned],
            panned_share: 0.25,
            created_at_ms: 1_000,
            pinned: false,
            last_opened: None,
            saved_path: None,
            has_original: false,
            tempo: None,
        };
        store.commit(staging, &song).unwrap();
        song
    }

    fn two_stems() -> Vec<(StemKind, Vec<i16>)> {
        vec![
            (StemKind::Drums, signal(20_000)),
            (
                StemKind::Other,
                signal(20_000).iter().map(|s| s / 2).collect(),
            ),
        ]
    }

    fn request(id: &str, dest: &Path, original: bool) -> SaveRequest {
        SaveRequest {
            id: id.into(),
            dest: dest.to_string_lossy().into_owned(),
            include_original: original,
            state: None,
        }
    }

    fn save_ok(store: &StemStore, request: &SaveRequest) -> SaveResult {
        save(
            store,
            request,
            "1.2.3",
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap()
    }

    fn open_ok(store: &StemStore, path: &Path) -> StemSong {
        open(store, path, &AtomicBool::new(false), &mut |_| {}).unwrap()
    }

    fn pcm_of(path: &Path) -> Vec<i16> {
        hound::WavReader::open(path)
            .unwrap()
            .samples::<i16>()
            .map(|s| s.unwrap())
            .collect()
    }

    /// Rewrites a bundle with `change` applied to its entries (name, bytes); entries are stored.
    fn rewrite(path: &Path, change: impl FnOnce(&mut Vec<(String, Vec<u8>)>)) {
        let mut archive = ZipArchive::new(File::open(path).unwrap()).unwrap();
        let mut entries: Vec<(String, Vec<u8>)> = (0..archive.len())
            .map(|i| {
                let mut f = archive.by_index(i).unwrap();
                let mut bytes = Vec::new();
                f.read_to_end(&mut bytes).unwrap();
                (f.name().unwrap().into_owned(), bytes)
            })
            .collect();
        drop(archive);
        change(&mut entries);
        let mut zip = ZipWriter::new(File::create(path).unwrap());
        for (name, bytes) in entries {
            zip.start_file(name, stored(bytes.len() as u64)).unwrap();
            zip.write_all(&bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    fn edit_manifest(path: &Path, change: impl FnOnce(&mut Value)) {
        rewrite(path, |entries| {
            let entry = entries.iter_mut().find(|e| e.0 == MANIFEST).unwrap();
            let mut value: Value = serde_json::from_slice(&entry.1).unwrap();
            change(&mut value);
            entry.1 = serde_json::to_vec(&value).unwrap();
        });
    }

    fn setup() -> (tempfile::TempDir, StemStore, StemSong) {
        let dir = tempfile::tempdir().unwrap();
        let store = StemStore::new(dir.path().join("stems"));
        let song = cached(&store, ID, &two_stems());
        (dir, store, song)
    }

    #[test]
    fn a_saved_song_opens_into_an_empty_cache_with_identical_samples() {
        let (dir, store, song) = setup();
        let file = dir.path().join("Band Song.sbstems");
        let result = save_ok(&store, &request(ID, &file, false));
        assert_eq!(result.path, file.to_string_lossy());
        assert_eq!(result.bytes, std::fs::metadata(&file).unwrap().len());
        assert!(!result.original_included);

        let fresh = StemStore::new(dir.path().join("elsewhere"));
        let opened = open_ok(&fresh, &file);
        assert_eq!(opened.id, ID);
        assert_eq!(opened.name, "Band Song");
        assert_eq!(opened.engine, StemEngine::Htdemucs);
        assert_eq!(opened.skipped, [StemKind::Panned]);
        assert_eq!(opened.created_at_ms, 1_000);
        assert!((opened.panned_share - 0.25).abs() < 1e-6);
        assert!((opened.duration_seconds - song.duration_seconds).abs() < 1e-9);
        assert!(opened.pinned && !opened.has_original);
        assert_eq!(opened.saved_path.as_deref(), file.to_str());
        assert!(opened.last_opened.is_some());
        assert_eq!(opened.stems, song.stems);
        assert_eq!(fresh.get(ID), Some(opened));
        for info in &song.stems {
            let a = store.stem_path(ID, info.kind).unwrap();
            let b = fresh.stem_path(ID, info.kind).unwrap();
            assert_eq!(pcm_of(&a), pcm_of(&b), "{}", info.kind.id());
            assert_eq!(std::fs::read(a).unwrap(), std::fs::read(b).unwrap());
        }
    }

    #[test]
    fn saving_pins_the_cached_song_and_remembers_the_file() {
        let (dir, store, _) = setup();
        let file = dir.path().join("Band Song");
        // The extension is added.
        let result = save_ok(&store, &request(ID, &file, false));
        assert_eq!(
            Path::new(&result.path).file_name().unwrap(),
            "Band Song.sbstems"
        );
        let song = store.get(ID).unwrap();
        assert!(song.pinned);
        assert_eq!(song.saved_path.as_deref(), Some(result.path.as_str()));
        // No temp file is left next to it.
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().all(|n| !n.ends_with(".tmp")), "{names:?}");
    }

    #[test]
    fn every_entry_is_stored_and_the_manifest_describes_them() {
        let (dir, store, song) = setup();
        let file = dir.path().join("a.sbstems");
        let mut req = request(ID, &file, false);
        req.state = Some(serde_json::json!({ "speed": 0.8, "muted": ["drums"] }));
        save_ok(&store, &req);
        let mut archive = ZipArchive::new(File::open(&file).unwrap()).unwrap();
        let mut names = Vec::new();
        for i in 0..archive.len() {
            let entry = archive.by_index(i).unwrap();
            assert_eq!(entry.compression(), CompressionMethod::Stored);
            names.push(entry.name().unwrap().into_owned());
        }
        names.sort();
        assert_eq!(
            names,
            [
                "manifest.json",
                "state.json",
                "stems/drums.flac",
                "stems/other.flac"
            ]
        );
        let manifest = read_manifest(&mut archive, "a").unwrap();
        assert_eq!(
            (manifest.format.as_str(), manifest.version),
            (FORMAT, VERSION)
        );
        assert_eq!(manifest.app_version, "1.2.3");
        assert_eq!(manifest.engine.id, "htdemucs");
        assert_eq!(manifest.engine.model_id.as_deref(), Some("htdemucs"));
        assert_eq!(
            manifest.engine.model_sha256.as_deref().map(str::len),
            Some(64)
        );
        assert_eq!((manifest.sample_rate, manifest.channels), (44_100, 2));
        assert_eq!(manifest.stems.len(), 2);
        for (entry, info) in manifest.stems.iter().zip(&song.stems) {
            assert_eq!(entry.kind, info.kind);
            assert_eq!(entry.codec, "flac");
            assert_eq!(entry.frames, (info.bytes - 44) / 4);
            let bytes = read_entry(&mut archive, &entry.file, u64::MAX / 2)
                .unwrap()
                .unwrap();
            assert_eq!(bytes.len() as u64, entry.bytes);
            assert_eq!(hex(&Sha256::digest(&bytes)), entry.sha256);
        }
        // The raw JSON uses the documented camelCase names.
        let raw: Value = serde_json::from_slice(
            &read_entry(&mut archive, MANIFEST, 1 << 20)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        for key in [
            "durationSeconds",
            "sampleRate",
            "createdAtMs",
            "appVersion",
            "strongDrums",
            "pannedShare",
        ] {
            assert!(raw.get(key).is_some(), "{key}");
        }
        assert_eq!(raw["engine"]["algorithmVersion"], 1);
        assert_eq!(raw["original"]["embedded"], false);
    }

    #[test]
    fn the_state_comes_back_and_is_optional() {
        let (dir, store, _) = setup();
        let file = dir.path().join("a.sbstems");
        save_ok(&store, &request(ID, &file, false));
        assert_eq!(read_state(&file).unwrap(), None);
        let mut req = request(ID, &file, false);
        req.state = Some(serde_json::json!({ "gains": { "drums": 0.5 }, "loop": null }));
        save_ok(&store, &req);
        assert_eq!(
            read_state(&file).unwrap(),
            Some(serde_json::json!({ "gains": { "drums": 0.5 }, "loop": null }))
        );
        // Too large is refused before anything is written.
        req.state = Some(Value::String("x".repeat(2 << 20)));
        let other = dir.path().join("b.sbstems");
        req.dest = other.to_string_lossy().into_owned();
        assert_eq!(
            save(&store, &req, "1", &AtomicBool::new(false), &mut |_| {})
                .unwrap_err()
                .kind,
            ErrorKind::TooLarge
        );
        assert!(!other.exists());
    }

    #[test]
    fn the_original_is_embedded_when_the_source_file_is_there() {
        let (dir, store, _) = setup();
        let audio = dir.path().join("Band Song.mp3");
        let body: Vec<u8> = (0..5_000u32).map(|i| (i * 7) as u8).collect();
        std::fs::write(&audio, &body).unwrap();
        Source::of(&audio, &body)
            .write(&store.song_dir(ID).unwrap())
            .unwrap();

        let file = dir.path().join("with.sbstems");
        let result = save_ok(&store, &request(ID, &file, true));
        assert!(result.original_included);
        let mut archive = ZipArchive::new(File::open(&file).unwrap()).unwrap();
        let manifest = read_manifest(&mut archive, "with").unwrap();
        assert!(manifest.original.embedded);
        assert_eq!(
            manifest.original.file_name.as_deref(),
            Some("Band Song.mp3")
        );
        assert_eq!(manifest.original.bytes, 5_000);
        let embedded = read_entry(&mut archive, "original/Band Song.mp3", 1 << 20)
            .unwrap()
            .unwrap();
        assert_eq!(embedded, body);
        assert!(store.get(ID).unwrap().has_original);

        // Not asked for: not in the file, but the song can still offer it later.
        let plain = dir.path().join("without.sbstems");
        let result = save_ok(&store, &request(ID, &plain, false));
        assert!(!result.original_included);
        assert!(result.bytes < std::fs::metadata(&file).unwrap().len());
        assert!(store.get(ID).unwrap().has_original);

        // Opening the file with the original says so, and leaves the original in the file.
        let fresh = StemStore::new(dir.path().join("fresh"));
        let opened = open_ok(&fresh, &file);
        assert!(opened.has_original);
        assert!(!fresh.song_dir(ID).unwrap().join("Band Song.mp3").exists());
        assert!(!open_ok(&StemStore::new(dir.path().join("f2")), &plain).has_original);
    }

    #[test]
    fn without_the_source_file_the_song_is_saved_without_the_original() {
        let (dir, store, _) = setup();
        let audio = dir.path().join("gone.mp3");
        std::fs::write(&audio, b"audio").unwrap();
        Source::of(&audio, b"audio")
            .write(&store.song_dir(ID).unwrap())
            .unwrap();
        assert!(
            store.get(ID).unwrap().has_original,
            "the source is readable"
        );
        std::fs::remove_file(&audio).unwrap();
        assert!(!store.get(ID).unwrap().has_original, "the source is gone");
        assert!(!store.list()[0].has_original);

        let file = dir.path().join("a.sbstems");
        let result = save_ok(&store, &request(ID, &file, true));
        assert!(!result.original_included);
        // The song is still saved, and nothing promises an original.
        assert!(!store.get(ID).unwrap().has_original);
        let mut archive = ZipArchive::new(File::open(&file).unwrap()).unwrap();
        let manifest = read_manifest(&mut archive, "a").unwrap();
        assert!(!manifest.original.embedded);
        assert_eq!(manifest.original.file_name.as_deref(), Some("gone.mp3"));
        assert!((0..archive.len()).all(|i| {
            !archive
                .by_index(i)
                .unwrap()
                .name()
                .unwrap()
                .starts_with("original/")
        }));

        // A source file that changed since the separation is not the original any more.
        std::fs::write(&audio, b"another recording").unwrap();
        assert!(!save_ok(&store, &request(ID, &file, true)).original_included);
    }

    #[test]
    fn a_song_opened_from_a_file_can_carry_the_original_into_the_next_save() {
        let (dir, store, _) = setup();
        let audio = dir.path().join("take.wav");
        std::fs::write(&audio, b"original audio bytes").unwrap();
        Source::of(&audio, b"original audio bytes")
            .write(&store.song_dir(ID).unwrap())
            .unwrap();
        let first = dir.path().join("first.sbstems");
        assert!(save_ok(&store, &request(ID, &first, true)).original_included);

        // Another computer: no cache, no source file, only the file.
        let fresh = StemStore::new(dir.path().join("fresh"));
        open_ok(&fresh, &first);
        let second = dir.path().join("second.sbstems");
        let result = save_ok(&fresh, &request(ID, &second, true));
        assert!(result.original_included);
        let mut archive = ZipArchive::new(File::open(&second).unwrap()).unwrap();
        let bytes = read_entry(&mut archive, "original/take.wav", 1 << 20)
            .unwrap()
            .unwrap();
        assert_eq!(bytes, b"original audio bytes");
        // Saving over the file the original comes from works too.
        assert!(save_ok(&fresh, &request(ID, &first, true)).original_included);
    }

    #[test]
    fn a_stem_too_short_for_flac_is_kept_as_wav() {
        let dir = tempfile::tempdir().unwrap();
        let store = StemStore::new(dir.path().join("stems"));
        let tiny: Vec<_> = signal(9);
        let song = cached(
            &store,
            ID,
            &[
                (StemKind::Drums, tiny.clone()),
                (StemKind::Other, signal(9)),
            ],
        );
        let file = dir.path().join("tiny.sbstems");
        save_ok(&store, &request(ID, &file, false));
        let mut archive = ZipArchive::new(File::open(&file).unwrap()).unwrap();
        let manifest = read_manifest(&mut archive, "tiny").unwrap();
        assert!(
            manifest
                .stems
                .iter()
                .all(|s| s.codec == "wav" && s.frames == 9)
        );
        let fresh = StemStore::new(dir.path().join("fresh"));
        let opened = open_ok(&fresh, &file);
        assert_eq!(opened.stems, song.stems);
        assert_eq!(pcm_of(&fresh.stem_path(ID, StemKind::Drums).unwrap()), tiny);
    }

    #[test]
    fn a_stopped_save_leaves_nothing_and_keeps_an_older_file() {
        let (dir, store, _) = setup();
        let file = dir.path().join("a.sbstems");
        std::fs::write(&file, b"older file").unwrap();
        let err = save(
            &store,
            &request(ID, &file, false),
            "1",
            &AtomicBool::new(true),
            &mut |_| {},
        )
        .unwrap_err();
        assert_eq!(err.message, STOPPED);
        assert_eq!(std::fs::read(&file).unwrap(), b"older file");
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            2,
            "only stems/ and a.sbstems"
        );
        assert!(!store.get(ID).unwrap().pinned);
    }

    #[test]
    fn save_reports_a_missing_song_and_a_bad_destination() {
        let (dir, store, _) = setup();
        let cancel = AtomicBool::new(false);
        let go = |req: SaveRequest| save(&store, &req, "1", &cancel, &mut |_| {}).unwrap_err();
        assert_eq!(
            go(request(
                "fedcba9876543210",
                &dir.path().join("a.sbstems"),
                false
            ))
            .kind,
            ErrorKind::NotFound
        );
        assert!(
            go(request("../x", &dir.path().join("a.sbstems"), false))
                .message
                .contains("not saved")
        );
        assert_eq!(
            go(request(
                ID,
                &dir.path().join("no/such/folder/a.sbstems"),
                false
            ))
            .kind,
            ErrorKind::NotFound
        );
        let folder = dir.path().join("taken.sbstems");
        std::fs::create_dir(&folder).unwrap();
        assert_eq!(go(request(ID, &folder, false)).kind, ErrorKind::Io);
    }

    #[test]
    fn progress_runs_from_zero_to_one() {
        let (dir, store, _) = setup();
        let file = dir.path().join("a.sbstems");
        let mut seen = Vec::new();
        save(
            &store,
            &request(ID, &file, false),
            "1",
            &AtomicBool::new(false),
            &mut |f| seen.push(f),
        )
        .unwrap();
        assert_eq!(seen.first(), Some(&0.0));
        assert_eq!(seen.last(), Some(&1.0));
        assert!(seen.windows(2).all(|w| w[0] <= w[1]));
        let fresh = StemStore::new(dir.path().join("fresh"));
        let mut seen = Vec::new();
        open(&fresh, &file, &AtomicBool::new(false), &mut |f| {
            seen.push(f)
        })
        .unwrap();
        assert_eq!((seen.first(), seen.last()), (Some(&0.0), Some(&1.0)));
        assert!(seen.windows(2).all(|w| w[0] <= w[1]));
    }

    #[test]
    fn a_stem_file_name_that_climbs_out_of_the_folder_is_refused() {
        let (dir, store, _) = setup();
        let file = dir.path().join("a.sbstems");
        save_ok(&store, &request(ID, &file, false));
        for evil in [
            "../evil.flac",
            "stems/../../evil.flac",
            "/etc/passwd",
            "stems/drums.flac/../../x",
            "stems\\drums.flac",
            "stems/other.wav",
        ] {
            edit_manifest(&file, |m| {
                m["stems"][0]["file"] = Value::String(evil.into())
            });
            let fresh = StemStore::new(dir.path().join("fresh"));
            let err = open(&fresh, &file, &AtomicBool::new(false), &mut |_| {}).unwrap_err();
            assert!(
                err.message.contains("not a valid stem file name"),
                "{evil}: {err}"
            );
            assert!(fresh.list().is_empty());
            // Nothing was written anywhere but the cache.
            assert!(!dir.path().join("evil.flac").exists());
            save_ok(&store, &request(ID, &file, false));
        }
        // The same for the name of the original, and for a song id that is a path.
        edit_manifest(&file, |m| {
            m["original"] = serde_json::json!({
                "embedded": true, "fileName": "../x.mp3", "sha256": "0".repeat(64), "bytes": 1
            });
        });
        let fresh = StemStore::new(dir.path().join("fresh"));
        assert!(open(&fresh, &file, &AtomicBool::new(false), &mut |_| {}).is_err());
        save_ok(&store, &request(ID, &file, false));
        edit_manifest(&file, |m| {
            m["id"] = Value::String("../../../etc/pass".into())
        });
        assert!(open(&fresh, &file, &AtomicBool::new(false), &mut |_| {}).is_err());
        assert!(!is_plain_name("a/b") && !is_plain_name("..") && !is_plain_name("a\nb"));
        assert!(is_plain_name("Song (live) – ü.mp3"));
    }

    #[test]
    fn a_newer_version_is_refused_and_older_or_unknown_input_is_not_ours() {
        let (dir, store, _) = setup();
        let file = dir.path().join("a.sbstems");
        save_ok(&store, &request(ID, &file, false));
        let fresh = StemStore::new(dir.path().join("fresh"));
        let try_open = || open(&fresh, &file, &AtomicBool::new(false), &mut |_| {});

        // Version 2 may look nothing like version 1: refused before anything is parsed.
        edit_manifest(&file, |m| {
            m["version"] = 2.into();
            m["stems"] = Value::String("different now".into());
        });
        let err = try_open().unwrap_err();
        assert_eq!(err.kind, ErrorKind::UnsupportedType);
        assert!(err.message.contains("newer version"), "{err}");
        assert!(fresh.list().is_empty());

        save_ok(&store, &request(ID, &file, false));
        edit_manifest(&file, |m| m["version"] = 0.into());
        assert!(
            try_open()
                .unwrap_err()
                .message
                .contains("not a Smart Beat stems file")
        );
        save_ok(&store, &request(ID, &file, false));
        edit_manifest(&file, |m| m["format"] = "something-else".into());
        assert!(
            try_open()
                .unwrap_err()
                .message
                .contains("not a Smart Beat stems file")
        );

        // Not a zip, a zip without a manifest, a missing file: errors, not panics.
        std::fs::write(&file, b"PK but not really").unwrap();
        assert!(
            try_open()
                .unwrap_err()
                .message
                .contains("not a Smart Beat stems file")
        );
        rewrite_empty_zip(&file);
        assert!(
            try_open()
                .unwrap_err()
                .message
                .contains("not a Smart Beat stems file")
        );
        std::fs::remove_file(&file).unwrap();
        assert_eq!(try_open().unwrap_err().kind, ErrorKind::NotFound);
        assert!(fresh.list().is_empty());
    }

    fn rewrite_empty_zip(path: &Path) {
        let mut zip = ZipWriter::new(File::create(path).unwrap());
        zip.start_file("readme.txt", stored(2)).unwrap();
        zip.write_all(b"hi").unwrap();
        zip.finish().unwrap();
    }

    #[test]
    fn a_tampered_or_missing_stem_fails_its_checksum_and_leaves_the_cache_alone() {
        let (dir, store, _) = setup();
        let file = dir.path().join("a.sbstems");
        save_ok(&store, &request(ID, &file, false));
        let fresh = StemStore::new(dir.path().join("fresh"));
        let try_open = || open(&fresh, &file, &AtomicBool::new(false), &mut |_| {});

        rewrite(&file, |entries| {
            let flac = entries
                .iter_mut()
                .find(|e| e.0 == "stems/other.flac")
                .unwrap();
            let last = flac.1.len() - 1;
            flac.1[last] ^= 1;
        });
        let err = try_open().unwrap_err();
        assert!(
            err.message
                .contains("other stem does not match its checksum"),
            "{err}"
        );
        assert!(fresh.list().is_empty());
        let leftovers: Vec<_> = std::fs::read_dir(fresh.root()).unwrap().collect();
        assert!(leftovers.is_empty(), "the unpacking folder must be removed");

        save_ok(&store, &request(ID, &file, false));
        rewrite(&file, |entries| {
            entries.retain(|e| e.0 != "stems/drums.flac")
        });
        assert!(
            try_open()
                .unwrap_err()
                .message
                .contains("drums stem is missing")
        );

        // A wrong checksum in the manifest is the same thing seen from the other side.
        save_ok(&store, &request(ID, &file, false));
        edit_manifest(&file, |m| m["stems"][1]["sha256"] = "a".repeat(64).into());
        assert!(try_open().unwrap_err().message.contains("checksum"));
        // So is a wrong frame count.
        save_ok(&store, &request(ID, &file, false));
        edit_manifest(&file, |m| m["stems"][1]["frames"] = 19_999.into());
        assert!(try_open().unwrap_err().message.contains("frames"));
        assert!(fresh.list().is_empty());
    }

    #[test]
    fn unknown_entries_and_unknown_manifest_fields_are_ignored() {
        let (dir, store, _) = setup();
        let file = dir.path().join("a.sbstems");
        save_ok(&store, &request(ID, &file, false));
        rewrite(&file, |entries| {
            entries.push(("thumbnails/cover.png".into(), vec![1, 2, 3]));
            entries.push(("../outside.txt".into(), b"nope".to_vec()));
            entries.push(("stems/guitar.flac".into(), vec![9; 10]));
        });
        edit_manifest(&file, |m| {
            m["somethingNew"] = serde_json::json!({ "a": 1 });
            m["engine"]["gpu"] = true.into();
            m["stems"][0]["loudness"] = (-14.0).into();
        });
        let fresh = StemStore::new(dir.path().join("fresh"));
        let opened = open_ok(&fresh, &file);
        assert_eq!(opened.stems.len(), 2);
        assert!(!dir.path().join("outside.txt").exists());
        assert!(!dir.path().parent().unwrap().join("outside.txt").exists());
    }

    #[test]
    fn a_wav_stem_in_a_file_is_accepted() {
        let (dir, store, song) = setup();
        let file = dir.path().join("a.sbstems");
        save_ok(&store, &request(ID, &file, false));
        let wav = std::fs::read(store.stem_path(ID, StemKind::Drums).unwrap()).unwrap();
        rewrite(&file, |entries| {
            entries.retain(|e| e.0 != "stems/drums.flac");
            entries.push(("stems/drums.wav".into(), wav.clone()));
        });
        edit_manifest(&file, |m| {
            let drums = &mut m["stems"][0];
            drums["file"] = "stems/drums.wav".into();
            drums["codec"] = "wav".into();
            drums["bytes"] = wav.len().into();
            drums["sha256"] = hex(&Sha256::digest(&wav)).into();
        });
        let fresh = StemStore::new(dir.path().join("fresh"));
        let opened = open_ok(&fresh, &file);
        assert_eq!(opened.stems, song.stems);
        let a = pcm_of(&store.stem_path(ID, StemKind::Drums).unwrap());
        let b = pcm_of(&fresh.stem_path(ID, StemKind::Drums).unwrap());
        assert_eq!(a, b);
    }

    #[test]
    fn opening_a_song_that_is_cached_only_touches_and_pins_it() {
        let (dir, store, song) = setup();
        let file = dir.path().join("a.sbstems");
        save_ok(&store, &request(ID, &file, false));
        store.pin(ID, false).unwrap();
        assert!(!store.get(ID).unwrap().pinned);
        let before = std::fs::metadata(store.stem_path(ID, StemKind::Drums).unwrap())
            .unwrap()
            .modified()
            .unwrap();
        let opened = open_ok(&store, &file);
        assert!(opened.pinned);
        assert!(opened.last_opened.is_some());
        assert_eq!(opened.stems, song.stems);
        let after = std::fs::metadata(store.stem_path(ID, StemKind::Drums).unwrap())
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(before, after, "the stems were not unpacked again");
    }

    #[test]
    fn a_stopped_open_leaves_no_song_behind() {
        let (dir, store, _) = setup();
        let file = dir.path().join("a.sbstems");
        save_ok(&store, &request(ID, &file, false));
        let fresh = StemStore::new(dir.path().join("fresh"));
        let err = open(&fresh, &file, &AtomicBool::new(true), &mut |_| {}).unwrap_err();
        assert_eq!(err.message, STOPPED);
        assert!(fresh.list().is_empty());
        assert_eq!(std::fs::read_dir(fresh.root()).map_or(0, |d| d.count()), 0);
    }

    #[test]
    fn extensions_are_matched_without_case_and_added_when_missing() {
        assert!(is_bundle(Path::new("/a/Song.sbstems")));
        assert!(is_bundle(Path::new("Song.SBSTEMS")));
        assert!(!is_bundle(Path::new("Song.gp")));
        assert!(!is_bundle(Path::new("sbstems")));
        assert_eq!(with_extension("/a/Song"), PathBuf::from("/a/Song.sbstems"));
        assert_eq!(
            with_extension("/a/Song.sbstems"),
            PathBuf::from("/a/Song.sbstems")
        );
        assert_eq!(
            with_extension("/a/Song.v2"),
            PathBuf::from("/a/Song.v2.sbstems")
        );
    }

    #[test]
    fn the_size_of_a_minute_of_stereo_stems_as_flac_and_wav() {
        // A full minute per stem, four stems, as the app makes them.
        let (dir, store, _) = setup();
        let id = "aaaaaaaaaaaaaaaa";
        let minute = 44_100 * 60;
        let stems: Vec<_> = [
            StemKind::Drums,
            StemKind::Bass,
            StemKind::Vocals,
            StemKind::Other,
        ]
        .into_iter()
        .map(|k| (k, signal(minute)))
        .collect();
        let song = cached(&store, id, &stems);
        let file = dir.path().join("minute.sbstems");
        let started = std::time::Instant::now();
        let result = save_ok(&store, &request(id, &file, false));
        let saved_in = started.elapsed();
        let started = std::time::Instant::now();
        let fresh = StemStore::new(dir.path().join("fresh"));
        open_ok(&fresh, &file);
        println!(
            "60 s stereo, 4 stems: WAV {} bytes, .sbstems {} bytes ({:.0}%), save {saved_in:?}, open {:?}",
            song.bytes,
            result.bytes,
            result.bytes as f64 / song.bytes as f64 * 100.0,
            started.elapsed()
        );
        assert!(result.bytes < song.bytes);
    }

    #[test]
    fn the_estimate_is_half_the_cache_plus_the_original_when_it_is_there() {
        let (dir, store, song) = setup();
        let plain = estimate(&store, ID, false).unwrap();
        assert_eq!(plain.bytes, song.bytes / 2);
        assert!(plain.bytes > 0);
        // No source yet: asking for the original adds nothing.
        assert_eq!(estimate(&store, ID, true).unwrap(), plain);

        let audio = dir.path().join("Band Song.mp3");
        let body = vec![7u8; 5_000];
        std::fs::write(&audio, &body).unwrap();
        Source::of(&audio, &body)
            .write(&store.song_dir(ID).unwrap())
            .unwrap();
        assert_eq!(
            estimate(&store, ID, true).unwrap().bytes,
            plain.bytes + 5_000
        );
        assert_eq!(estimate(&store, ID, false).unwrap(), plain);

        // The source is gone but the file the song was saved to has the original.
        let file = dir.path().join("kept.sbstems");
        assert!(save_ok(&store, &request(ID, &file, true)).original_included);
        std::fs::remove_file(&audio).unwrap();
        assert_eq!(
            estimate(&store, ID, true).unwrap().bytes,
            plain.bytes + 5_000
        );

        // Nowhere to find it: the stems alone.
        std::fs::remove_file(&file).unwrap();
        assert_eq!(estimate(&store, ID, true).unwrap(), plain);
    }

    #[test]
    fn the_estimate_serializes_as_bytes_and_a_missing_song_is_not_found() {
        let (_dir, store, _) = setup();
        let json = serde_json::to_value(estimate(&store, ID, false).unwrap()).unwrap();
        assert!(json["bytes"].is_u64());
        assert_eq!(json.as_object().unwrap().len(), 1);
        let error = estimate(&store, "ffffffffffffffff", false).unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);
    }

    #[test]
    fn the_temp_file_is_hidden_and_a_tmp_file_that_a_sync_client_skips() {
        let dest = Path::new("/drive/Band: Song.sbstems");
        let temp = TempFile::beside(dest);
        let name = file_name(&temp.path);
        assert!(name.starts_with('.'), "{name}");
        assert!(name.ends_with(".tmp"), "{name}");
        assert_eq!(temp.path.parent(), dest.parent());
        assert!(!is_bundle(&temp.path));
        assert_ne!(temp.path, TempFile::beside(dest).path);
        let mut temp = temp;
        temp.keep = true;
    }

    #[test]
    fn a_save_leaves_only_the_file_and_the_cloud_lister_sees_it() {
        let (dir, store, _) = setup();
        let folder = dir.path().join("Drive");
        std::fs::create_dir(&folder).unwrap();
        let file = folder.join("Band Song.sbstems");
        let result = save_ok(&store, &request(ID, &file, false));
        let names: Vec<_> = std::fs::read_dir(&folder)
            .unwrap()
            .map(|e| file_name(&e.unwrap().path()))
            .collect();
        assert_eq!(names, ["Band Song.sbstems"]);
        let listed = crate::cloud_folder::list_stems(&folder).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].size, result.bytes);
        assert_eq!(listed[0].path, result.path);
    }

    #[test]
    fn a_full_disk_gets_its_own_message_and_other_errors_do_not() {
        let full = std::io::Error::from(std::io::ErrorKind::StorageFull);
        assert!(is_disk_full(&full));
        assert!(is_disk_full(&zip::result::ZipError::Io(
            std::io::Error::from(std::io::ErrorKind::StorageFull)
        )));
        assert_eq!(write_err(&full).message, DISK_FULL);
        let other = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert!(!is_disk_full(&other));
        assert!(
            write_err(&other)
                .message
                .starts_with("The file could not be written")
        );
    }

    #[test]
    fn an_online_only_bundle_is_waited_for_then_opened_from_the_stream() {
        let (dir, store, _) = setup();
        let made = dir.path().join("made.sbstems");
        save_ok(&store, &request(ID, &made, false));

        // In the cloud folder the file is an iCloud placeholder until the client downloads it.
        let folder = dir.path().join("Drive");
        std::fs::create_dir(&folder).unwrap();
        let target = folder.join("Away.sbstems");
        std::fs::write(folder.join(".Away.sbstems.icloud"), b"plist").unwrap();
        let waited = std::cell::Cell::new(0);
        crate::cloud_folder::wait_if_evicted(
            &target,
            std::time::Duration::from_secs(5),
            |_| {
                let (from, to) = (made.clone(), target.clone());
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    std::fs::copy(from, to).unwrap();
                });
            },
            || waited.set(waited.get() + 1),
        )
        .unwrap();
        assert_eq!(waited.get(), 1);
        let fresh = StemStore::new(dir.path().join("fresh"));
        let opened = open_ok(&fresh, &target);
        assert_eq!(opened.id, ID);
        assert_eq!(opened.saved_path.as_deref(), target.to_str());

        // A bundle that is not there at all goes on to the opener's own message.
        let gone = folder.join("Gone.sbstems");
        crate::cloud_folder::wait_if_evicted(
            &gone,
            std::time::Duration::ZERO,
            |_| {},
            || panic!("nothing to wait for"),
        )
        .unwrap();
        let error = open(&fresh, &gone, &AtomicBool::new(false), &mut |_| {}).unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);
    }
}
