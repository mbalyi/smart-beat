//! Looking inside a sample folder: which audio files it holds, what each one is (length, rate,
//! a small waveform), and a cache so a second look does not decode everything again.
//!
//! A file is known again when its relative path, size and modified time are unchanged.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Cursor, Write};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use crate::audio::backing::{self, AUDIO_EXTENSIONS};
use crate::error::{CommandError, ErrorKind};

/// Deepest subfolder level that is read.
pub const MAX_DEPTH: usize = 8;
/// Most files one folder lists; a guard against pointing at a whole disk.
pub const MAX_FILES: usize = 50_000;
/// Bins of the waveform thumbnail.
pub const PEAK_BINS: usize = 96;
/// Files up to this size are decoded for a thumbnail; bigger ones only get a length.
pub const THUMBNAIL_LIMIT: u64 = 48 * 1024 * 1024;
/// Most files one probe call handles.
pub const MAX_PROBE_BATCH: usize = 64;
const INDEX_VERSION: u32 = 1;
const PROBE_THREADS: usize = 2;

/// A file as found on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub rel: String,
    pub size: u64,
    pub modified_ms: u64,
}

/// The result of walking a folder.
#[derive(Debug, Default)]
pub struct Walk {
    pub files: Vec<Found>,
    /// Visible files that are not audio this app opens.
    pub skipped: u32,
    pub subfolders: u32,
    pub total_bytes: u64,
}

/// A file as the page sees it. The measured fields are `None` until the file is probed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleFile {
    pub rel: String,
    pub name: String,
    pub ext: String,
    pub size_bytes: u64,
    pub modified_ms: u64,
    pub duration_ms: Option<u64>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
    pub peaks: Option<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Cached {
    size: u64,
    modified_ms: u64,
    duration_ms: Option<u64>,
    sample_rate: Option<u32>,
    channels: Option<u8>,
    peaks: Option<Vec<u8>>,
    /// Probing failed: the file is skipped quietly until it changes.
    #[serde(default)]
    corrupt: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Index {
    version: u32,
    files: BTreeMap<String, Cached>,
}

/// What probing one file learnt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probed {
    pub duration_ms: u64,
    pub sample_rate: u32,
    pub channels: u8,
    pub peaks: Option<Vec<u8>>,
}

pub fn extension_of(path: &Path) -> Option<String> {
    path.extension().map(|e| e.to_string_lossy().to_lowercase())
}

/// Whether the app opens this file type.
pub fn is_audio(path: &Path) -> bool {
    extension_of(path).is_some_and(|e| AUDIO_EXTENSIONS.contains(&e.as_str()))
}

/// Hidden files and the `._name` companions macOS leaves on other drives.
pub fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

fn modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Walks `root` (depth-capped, hidden entries and symbolic links left alone) and lists its audio.
pub fn walk(root: &Path) -> Walk {
    let mut out = Walk::default();
    let mut stack = vec![(root.to_path_buf(), String::new(), 0usize)];
    while let Some((dir, prefix, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_hidden(&name) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if kind.is_dir() {
                if depth < MAX_DEPTH {
                    out.subfolders += 1;
                    stack.push((entry.path(), rel, depth + 1));
                }
            } else if kind.is_file() {
                let Ok(meta) = entry.metadata() else {
                    continue;
                };
                if is_audio(&entry.path()) {
                    if out.files.len() < MAX_FILES {
                        out.total_bytes += meta.len();
                        out.files.push(Found {
                            rel,
                            size: meta.len(),
                            modified_ms: modified_ms(&meta),
                        });
                    }
                } else {
                    out.skipped += 1;
                }
            }
        }
    }
    out.files.sort_by(|a, b| a.rel.cmp(&b.rel));
    out
}

/// The absolute path of `rel` inside `root`, refusing anything that leaves it (a `..`, an
/// absolute path, or a symbolic link that points elsewhere).
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, CommandError> {
    let outside = || {
        CommandError::new(
            ErrorKind::NotFound,
            "That file is not inside a sample folder.",
        )
    };
    if rel.is_empty() || rel.contains('\\') || rel.contains('\0') {
        return Err(outside());
    }
    let relative = Path::new(rel);
    if relative
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(outside());
    }
    let canonical_root = root.canonicalize().map_err(|_| {
        CommandError::new(ErrorKind::NotFound, "The sample folder cannot be found.")
    })?;
    let file = canonical_root
        .join(relative)
        .canonicalize()
        .map_err(|_| CommandError::new(ErrorKind::NotFound, "That sample is gone."))?;
    if !file.starts_with(&canonical_root) || !file.is_file() {
        return Err(outside());
    }
    Ok(file)
}

impl Index {
    pub fn load(path: &Path) -> Self {
        fs::read_to_string(path)
            .ok()
            .and_then(|json| serde_json::from_str::<Index>(&json).ok())
            .filter(|i| i.version == INDEX_VERSION)
            .unwrap_or_default()
    }

    pub fn save(&mut self, path: &Path) -> Result<(), CommandError> {
        self.version = INDEX_VERSION;
        let what = "The sample index could not be saved";
        let io_error = |e: &io::Error| CommandError::new(ErrorKind::Io, format!("{what}: {e}"));
        let dir = path.parent().unwrap_or(Path::new("."));
        fs::create_dir_all(dir).map_err(|e| io_error(&e))?;
        let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|e| io_error(&e))?;
        serde_json::to_writer(&mut file, self)
            .map_err(io::Error::from)
            .and_then(|()| file.flush())
            .map_err(|e| io_error(&e))?;
        file.persist(path).map_err(|e| io_error(&e.error))?;
        Ok(())
    }

    /// Drops what is known about files that are no longer there.
    fn forget_missing(&mut self, found: &[Found]) {
        let keep: std::collections::HashSet<&str> = found.iter().map(|f| f.rel.as_str()).collect();
        self.files.retain(|rel, _| keep.contains(rel.as_str()));
    }

    fn known(&self, f: &Found) -> Option<&Cached> {
        self.files
            .get(&f.rel)
            .filter(|c| c.size == f.size && c.modified_ms == f.modified_ms)
    }

    pub fn record(&mut self, f: &Found, probed: Option<&Probed>) {
        self.files.insert(
            f.rel.clone(),
            Cached {
                size: f.size,
                modified_ms: f.modified_ms,
                duration_ms: probed.map(|p| p.duration_ms),
                sample_rate: probed.map(|p| p.sample_rate),
                channels: probed.map(|p| p.channels),
                peaks: probed.and_then(|p| p.peaks.clone()),
                corrupt: probed.is_none(),
            },
        );
    }
}

fn sample_file(f: &Found, cached: Option<&Cached>) -> SampleFile {
    let path = Path::new(&f.rel);
    SampleFile {
        rel: f.rel.clone(),
        name: path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        ext: extension_of(path).unwrap_or_default(),
        size_bytes: f.size,
        modified_ms: f.modified_ms,
        duration_ms: cached.and_then(|c| c.duration_ms),
        sample_rate: cached.and_then(|c| c.sample_rate),
        channels: cached.and_then(|c| c.channels),
        peaks: cached.and_then(|c| c.peaks.clone()),
    }
}

/// The files of a folder, sorted by name, with what the cache already knows. Files that failed
/// to decode before (and have not changed) are left out. Rewrites the index when files vanished.
pub fn list_files(root: &Path, index_path: &Path) -> Vec<SampleFile> {
    let found = walk(root).files;
    let mut index = Index::load(index_path);
    let before = index.files.len();
    index.forget_missing(&found);
    if index.files.len() != before {
        let _ = index.save(index_path);
    }
    let mut files: Vec<SampleFile> = found
        .iter()
        .filter_map(|f| {
            let cached = index.known(f);
            if cached.is_some_and(|c| c.corrupt) {
                return None;
            }
            Some(sample_file(f, cached))
        })
        .collect();
    files.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.rel.cmp(&b.rel))
    });
    files
}

/// Length, rate and channels from the container header, without decoding. `None` when the
/// container does not say.
fn header_info(bytes: Vec<u8>, ext: &str) -> Option<(u64, u32, u8)> {
    let mut hint = Hint::new();
    hint.with_extension(ext);
    let stream = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
    let format = symphonia::default::get_probe()
        .probe(
            &hint,
            stream,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .ok()?;
    let track = format.default_track(TrackType::Audio)?;
    let audio = track.codec_params.as_ref()?.audio()?;
    let rate = audio.sample_rate.filter(|&r| r > 0)?;
    let channels = audio
        .channels
        .as_ref()
        .map_or(2, |c| c.count())
        .clamp(1, 255) as u8;
    let ms = track.num_frames.map(|n| n * 1000 / u64::from(rate))?;
    Some((ms, rate, channels))
}

/// Squashed loudness (square root) so quiet parts stay visible in a small thumbnail.
fn thumbnail(audio: &backing::DecodedAudio) -> Vec<u8> {
    let frames = audio.frames();
    (0..PEAK_BINS)
        .map(|bin| {
            let (a, b) = (frames * bin / PEAK_BINS, frames * (bin + 1) / PEAK_BINS);
            let peak = audio.left[a..b.max(a)]
                .iter()
                .chain(&audio.right[a..b.max(a)])
                .fold(0.0f32, |m, s| m.max(s.abs()))
                .min(1.0);
            (peak.sqrt() * 255.0).round() as u8
        })
        .collect()
}

/// Learns what one file is. Small files are decoded for a thumbnail; big ones only report a
/// length from their header. An error means the file cannot be played.
pub fn probe_file(path: &Path) -> Result<Probed, String> {
    let ext = extension_of(path).unwrap_or_default();
    let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > backing::MAX_FILE_BYTES as u64 {
        return Err("The audio file is too large".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if size > THUMBNAIL_LIMIT {
        return header_info(bytes, &ext)
            .map(|(duration_ms, sample_rate, channels)| Probed {
                duration_ms,
                sample_rate,
                channels,
                peaks: None,
            })
            .ok_or_else(|| "The file has no readable length".to_string());
    }
    let audio = backing::decode(bytes, Some(&ext))?;
    Ok(Probed {
        duration_ms: (audio.duration() * 1000.0).round() as u64,
        sample_rate: audio.rate,
        channels: audio.channels.clamp(1, 255) as u8,
        peaks: Some(thumbnail(&audio)),
    })
}

/// Probes `rels` (at most [`MAX_PROBE_BATCH`]) on a small pool and stores the results in the
/// index. Files that cannot be decoded come back unmeasured and are remembered as damaged.
pub fn probe_files(
    root: &Path,
    index_path: &Path,
    rels: &[String],
) -> Result<Vec<SampleFile>, CommandError> {
    if rels.len() > MAX_PROBE_BATCH {
        return Err(CommandError::new(
            ErrorKind::Io,
            format!("Probe at most {MAX_PROBE_BATCH} files at a time."),
        ));
    }
    let mut jobs = Vec::new();
    for rel in rels {
        let path = resolve(root, rel)?;
        let meta = fs::metadata(&path).map_err(|e| {
            CommandError::new(ErrorKind::Io, format!("That sample cannot be read: {e}"))
        })?;
        jobs.push((
            Found {
                rel: rel.clone(),
                size: meta.len(),
                modified_ms: modified_ms(&meta),
            },
            path,
        ));
    }
    let mut index = Index::load(index_path);
    let todo: Vec<&(Found, PathBuf)> = jobs
        .iter()
        .filter(|(f, _)| index.known(f).is_none())
        .collect();
    let results: Vec<(usize, Option<Probed>)> = {
        let next = std::sync::atomic::AtomicUsize::new(0);
        let out = std::sync::Mutex::new(Vec::new());
        std::thread::scope(|scope| {
            for _ in 0..PROBE_THREADS.min(todo.len()) {
                scope.spawn(|| {
                    loop {
                        let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let Some((_, path)) = todo.get(i) else {
                            break;
                        };
                        let probed = probe_file(path).ok();
                        out.lock().unwrap().push((i, probed));
                    }
                });
            }
        });
        out.into_inner().unwrap()
    };
    for (i, probed) in &results {
        index.record(&todo[*i].0, probed.as_ref());
    }
    if !results.is_empty() {
        index.save(index_path)?;
    }
    Ok(jobs
        .iter()
        .map(|(f, _)| sample_file(f, index.known(f)))
        .collect())
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::Path;

    /// A 440 Hz tone, mono, 16-bit, `seconds` long.
    pub fn tone_wav(seconds: f64, rate: u32) -> Vec<u8> {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = hound::WavWriter::new(&mut cursor, spec).unwrap();
            for i in 0..(seconds * f64::from(rate)) as usize {
                let t = i as f64 / f64::from(rate);
                let s = (std::f64::consts::TAU * 440.0 * t).sin() * 12_000.0;
                writer.write_sample(s as i16).unwrap();
            }
            writer.finalize().unwrap();
        }
        cursor.into_inner()
    }

    pub fn write_tone(dir: &Path, rel: &str, seconds: f64) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, tone_wav(seconds, 22_050)).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn walk_lists_supported_audio_and_skips_the_rest_quietly() {
        let dir = tempfile::tempdir().unwrap();
        write_tone(dir.path(), "kick.wav", 0.2);
        write_tone(dir.path(), "deep/er/snare.wav", 0.2);
        fs::write(dir.path().join("notes.txt"), "x").unwrap();
        fs::write(dir.path().join(".hidden.wav"), "x").unwrap();
        fs::write(dir.path().join("._kick.wav"), "x").unwrap();
        let walked = walk(dir.path());
        let rels: Vec<&str> = walked.files.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(rels, ["deep/er/snare.wav", "kick.wav"]);
        assert_eq!(walked.skipped, 1, "only the visible non-audio file counts");
        assert_eq!(walked.subfolders, 2);
    }

    #[cfg(unix)]
    #[test]
    fn walk_does_not_follow_symbolic_links() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write_tone(outside.path(), "secret.wav", 0.2);
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.wav"),
            dir.path().join("file.wav"),
        )
        .unwrap();
        assert!(walk(dir.path()).files.is_empty());
    }

    #[test]
    fn resolve_refuses_to_leave_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        write_tone(dir.path(), "a/kick.wav", 0.2);
        assert!(resolve(dir.path(), "a/kick.wav").is_ok());
        for bad in [
            "../x.wav",
            "/etc/passwd",
            "a/../../x",
            "",
            "a\\kick.wav",
            "a//",
        ] {
            assert!(resolve(dir.path(), bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[cfg(unix)]
    #[test]
    fn resolve_refuses_a_symbolic_link_that_points_outside() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write_tone(outside.path(), "secret.wav", 0.2);
        std::os::unix::fs::symlink(
            outside.path().join("secret.wav"),
            dir.path().join("sneaky.wav"),
        )
        .unwrap();
        assert!(resolve(dir.path(), "sneaky.wav").is_err());
    }

    #[test]
    fn probe_reads_length_rate_and_a_thumbnail() {
        let dir = tempfile::tempdir().unwrap();
        write_tone(dir.path(), "tone.wav", 1.5);
        let probed = probe_file(&dir.path().join("tone.wav")).unwrap();
        assert!(probed.duration_ms.abs_diff(1500) <= 5);
        assert_eq!(probed.sample_rate, 22_050);
        assert_eq!(probed.channels, 1);
        let peaks = probed.peaks.unwrap();
        assert_eq!(peaks.len(), PEAK_BINS);
        assert!(
            peaks.iter().all(|&p| p > 100),
            "a steady tone is loud everywhere"
        );
    }

    #[test]
    fn probe_rejects_a_file_that_is_not_audio() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("fake.wav"), b"not audio at all").unwrap();
        assert!(probe_file(&dir.path().join("fake.wav")).is_err());
    }

    #[test]
    fn header_reports_a_length_without_decoding() {
        let bytes = tone_wav(2.0, 22_050);
        let (ms, rate, channels) = header_info(bytes, "wav").unwrap();
        assert!(ms.abs_diff(2000) <= 2);
        assert_eq!((rate, channels), (22_050, 1));
    }

    #[test]
    fn probing_fills_the_cache_and_a_second_look_reuses_it() {
        let dir = tempfile::tempdir().unwrap();
        let index = dir.path().join("cache/index.json");
        let root = dir.path().join("files");
        write_tone(&root, "a.wav", 0.5);
        write_tone(&root, "b.wav", 0.7);
        assert!(list_files(&root, &index)[0].duration_ms.is_none());
        let probed = probe_files(&root, &index, &["a.wav".into(), "b.wav".into()]).unwrap();
        assert!(probed.iter().all(|f| f.duration_ms.is_some()));
        let listed = list_files(&root, &index);
        assert_eq!(listed.len(), 2);
        assert!(
            listed.iter().all(|f| f.peaks.is_some()),
            "read from the cache"
        );
    }

    #[test]
    fn a_changed_file_is_probed_again() {
        let dir = tempfile::tempdir().unwrap();
        let index = dir.path().join("index.json");
        let root = dir.path().join("files");
        write_tone(&root, "a.wav", 0.5);
        probe_files(&root, &index, &["a.wav".into()]).unwrap();
        write_tone(&root, "a.wav", 1.0);
        let listed = list_files(&root, &index);
        assert!(
            listed[0].duration_ms.is_none(),
            "a different size means the cached length is stale"
        );
    }

    #[test]
    fn damaged_files_drop_out_of_the_list() {
        let dir = tempfile::tempdir().unwrap();
        let index = dir.path().join("index.json");
        let root = dir.path().join("files");
        write_tone(&root, "good.wav", 0.3);
        fs::write(root.join("bad.wav"), b"junk").unwrap();
        let both = probe_files(&root, &index, &["good.wav".into(), "bad.wav".into()]).unwrap();
        assert!(
            both.iter()
                .find(|f| f.rel == "bad.wav")
                .unwrap()
                .duration_ms
                .is_none()
        );
        let listed: Vec<_> = list_files(&root, &index)
            .into_iter()
            .map(|f| f.rel)
            .collect();
        assert_eq!(listed, ["good.wav"]);
    }

    #[test]
    fn the_cache_forgets_files_that_were_removed() {
        let dir = tempfile::tempdir().unwrap();
        let index = dir.path().join("index.json");
        let root = dir.path().join("files");
        write_tone(&root, "a.wav", 0.3);
        probe_files(&root, &index, &["a.wav".into()]).unwrap();
        fs::remove_file(root.join("a.wav")).unwrap();
        assert!(list_files(&root, &index).is_empty());
        assert!(Index::load(&index).files.is_empty());
    }

    #[test]
    fn probe_refuses_a_batch_that_is_too_big_and_paths_outside() {
        let dir = tempfile::tempdir().unwrap();
        let many: Vec<String> = (0..=MAX_PROBE_BATCH).map(|i| format!("{i}.wav")).collect();
        assert!(probe_files(dir.path(), &dir.path().join("i.json"), &many).is_err());
        assert!(probe_files(dir.path(), &dir.path().join("i.json"), &["../x.wav".into()]).is_err());
    }
}
