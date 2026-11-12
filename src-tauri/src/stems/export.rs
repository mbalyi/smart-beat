//! Exporting the stems of a separated song as audio files (issue #223).
//!
//! Two ways, for every engine alike (the cache keeps every stem as a 16-bit stereo WAV at the
//! song's rate):
//!
//! - **Mixed**: the chosen stems are added up into one file.
//! - **Batch**: one file per chosen stem, in a new folder next to nothing else, named
//!   `<Stem> - <Song>`.
//!
//! Each file is WAV or FLAC (both lossless). Files are written to a hidden temporary file and
//! renamed into place, so a stopped or failed export leaves nothing behind.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};

use super::bundle::{self, Progress, TempFile, Throttle, is_disk_full};
use super::cloud::safe_base;
use super::store::StemStore;
use super::wav::{self, Pcm16};
use super::{StemSong, StemsRun, codec};
use crate::audio::{self, AudioState, SourceInfo, backing};
use crate::error::{CommandError, ErrorKind};
use crate::separation::StemKind;

/// Sent while an export runs: `{ stage: "mixing" | "writing", fraction }`, `fraction` being the
/// share of the whole export done.
pub const PROGRESS_EVENT: &str = "stems-export-progress";

const BLOCK: usize = 16_384;
const COPY_BLOCK: usize = 1 << 20;
const DISK_FULL: &str = "There is not enough free space to export the stems.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Wav,
    Flac,
}

impl ExportFormat {
    fn extension(self) -> &'static str {
        match self {
            Self::Wav => "wav",
            Self::Flac => "flac",
        }
    }
}

/// Mirrored by `StemExportMixedRequest` in `src/lib/tauri.ts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixedRequest {
    /// The song in the cache.
    pub id: String,
    /// The stems to add up (at least one).
    pub kinds: Vec<StemKind>,
    pub format: ExportFormat,
    /// The file to write; the format's extension is added when the name does not end in it.
    pub dest: String,
}

/// Mirrored by `StemExportBatchRequest` in `src/lib/tauri.ts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRequest {
    pub id: String,
    pub kinds: Vec<StemKind>,
    pub format: ExportFormat,
    /// An existing folder; the files go into a new folder inside it.
    pub dir: String,
}

/// Mirrored by `StemExportResult` in `src/lib/tauri.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    /// The files written, in the order of the stems.
    pub paths: Vec<String>,
    /// The folder of a batch.
    pub folder: Option<String>,
    /// The sum was louder than full scale somewhere and was limited there (mixed export only).
    pub clipped: bool,
}

fn fail(kind: ErrorKind, message: impl Into<String>) -> CommandError {
    CommandError::new(kind, message)
}

fn write_err(e: &std::io::Error) -> CommandError {
    if is_disk_full(e) {
        fail(ErrorKind::Io, DISK_FULL)
    } else {
        fail(ErrorKind::Io, format!("The file could not be written: {e}"))
    }
}

fn audio_err(message: String) -> CommandError {
    if message == bundle::STOPPED {
        bundle::stopped()
    } else {
        fail(ErrorKind::Audio, message)
    }
}

fn check_stop(stop: &AtomicBool) -> Result<(), CommandError> {
    if stop.load(Ordering::Relaxed) {
        Err(bundle::stopped())
    } else {
        Ok(())
    }
}

/// How the stem is named in a file: as the app calls it (`STEM_LABELS` in the page).
pub fn label(kind: StemKind) -> &'static str {
    match kind {
        StemKind::Drums => "Drums",
        StemKind::Bass => "Bass",
        StemKind::Vocals => "Vocals",
        StemKind::Guitar => "Guitar",
        StemKind::Piano => "Piano",
        StemKind::Panned => "Guitars and keys",
        StemKind::Other => "Other",
    }
}

/// The song and the chosen stems, in the order of [`StemKind::ALL`] and without duplicates.
fn resolve(
    store: &StemStore,
    id: &str,
    kinds: &[StemKind],
) -> Result<(StemSong, Vec<StemKind>), CommandError> {
    let song = store
        .get(id)
        .ok_or_else(|| fail(ErrorKind::NotFound, "This song is not in the stem library."))?;
    if kinds.is_empty() {
        return Err(fail(
            ErrorKind::Audio,
            "Choose at least one stem to export.",
        ));
    }
    for kind in kinds {
        if !song.stems.iter().any(|s| s.kind == *kind) {
            return Err(fail(
                ErrorKind::Audio,
                format!("This song has no {} stem.", kind.id()),
            ));
        }
    }
    let ordered = StemKind::ALL
        .into_iter()
        .filter(|k| kinds.contains(k))
        .collect();
    Ok((song, ordered))
}

struct Mixed {
    rate: u32,
    left: Vec<f32>,
    right: Vec<f32>,
    clipped: bool,
}

/// The chosen stems added up, padded with silence to the longest one. `progress` gets the
/// fraction of the samples read.
fn mix(
    store: &StemStore,
    song: &StemSong,
    kinds: &[StemKind],
    stop: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<Mixed, CommandError> {
    let mut readers = Vec::new();
    for kind in kinds {
        let path = store
            .stem_path(&song.id, *kind)
            .map_err(|e| fail(ErrorKind::Audio, e))?;
        readers.push(Pcm16::open(&path).map_err(|e| fail(ErrorKind::Audio, e))?);
    }
    let rate = readers.first().map_or(song.sample_rate, |p| p.rate);
    let frames = readers.iter().map(|p| p.frames).max().unwrap_or(0) as usize;
    let total: u64 = readers.iter().map(|p| p.frames).sum::<u64>().max(1);
    let (mut left, mut right) = (vec![0.0f32; frames], vec![0.0f32; frames]);
    let (mut bl, mut br) = (Vec::new(), Vec::new());
    let mut done = 0u64;
    for pcm in &mut readers {
        let mut at = 0;
        loop {
            check_stop(stop)?;
            bl.clear();
            br.clear();
            let n = pcm
                .read_block(&mut bl, &mut br, BLOCK)
                .map_err(|e| fail(ErrorKind::Audio, e))?;
            if n == 0 {
                break;
            }
            for i in 0..n {
                left[at + i] += bl[i];
                right[at + i] += br[i];
            }
            at += n;
            done += n as u64;
            progress(done as f32 / total as f32);
        }
    }
    let clipped = left.iter().chain(&right).any(|s| s.abs() > 1.0);
    Ok(Mixed {
        rate,
        left,
        right,
        clipped,
    })
}

fn with_extension(dest: &str, format: ExportFormat) -> PathBuf {
    let path = PathBuf::from(dest);
    let has = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(format.extension()));
    if has {
        path
    } else {
        let mut name = path.into_os_string();
        name.push(format!(".{}", format.extension()));
        PathBuf::from(name)
    }
}

/// Writes `bytes` to a hidden file beside `dest` and renames it into place.
fn write_atomic(dest: &Path, bytes: &[u8]) -> Result<(), CommandError> {
    let mut temp = TempFile::beside(dest);
    let mut file = File::create(&temp.path).map_err(|e| write_err(&e))?;
    file.write_all(bytes)
        .and_then(|()| file.flush())
        .map_err(|e| write_err(&e))?;
    drop(file);
    fs::rename(&temp.path, dest).map_err(|e| write_err(&e))?;
    temp.keep = true;
    Ok(())
}

/// Adds the chosen stems up into one file. `emit(stage, fraction)` gets the progress of the
/// whole export. A set `stop` ends it with [`bundle::STOPPED`] and writes nothing.
pub fn export_mixed(
    store: &StemStore,
    request: &MixedRequest,
    stop: &AtomicBool,
    emit: &mut dyn FnMut(&'static str, f32),
) -> Result<ExportResult, CommandError> {
    let (song, kinds) = resolve(store, &request.id, &request.kinds)?;
    let dest = with_extension(&request.dest, request.format);
    // Mixing is most of the work for WAV; FLAC spends about as long encoding.
    let mixing_share = match request.format {
        ExportFormat::Wav => 0.9,
        ExportFormat::Flac => 0.5,
    };
    emit("mixing", 0.0);
    let mixed = {
        let mut throttle_emit = |f: f32| emit("mixing", f * mixing_share);
        let mut throttle = Throttle::new(&mut throttle_emit);
        mix(store, &song, &kinds, stop, &mut |f| throttle.at(f))?
    };
    check_stop(stop)?;
    let wav_bytes = wav::encode(mixed.rate, &mixed.left, &mixed.right).map_err(audio_err)?;
    drop((mixed.left, mixed.right));
    match request.format {
        ExportFormat::Wav => {
            emit("writing", mixing_share);
            write_atomic(&dest, &wav_bytes)?;
        }
        ExportFormat::Flac => {
            // The encoder reads a WAV file: the sum goes to a hidden one first.
            let staged = TempFile::beside(&dest);
            fs::write(&staged.path, &wav_bytes).map_err(|e| write_err(&e))?;
            drop(wav_bytes);
            let frames = Pcm16::open(&staged.path).map_err(audio_err)?.frames.max(1);
            let mut progress_emit = |f: f32| {
                emit("writing", mixing_share + f * (1.0 - mixing_share));
            };
            let mut throttle = Throttle::new(&mut progress_emit);
            let encoded = codec::encode_wav(&staged.path, stop, bundle::STOPPED, &mut |done| {
                throttle.at(done as f32 / frames as f32);
            })
            .map_err(audio_err)?;
            write_atomic(&dest, &encoded.bytes)?;
        }
    }
    emit("writing", 1.0);
    Ok(ExportResult {
        paths: vec![dest.to_string_lossy().into_owned()],
        folder: None,
        clipped: mixed.clipped,
    })
}

/// A folder made for a batch, and the files in it. Removed (what was written, then the folder)
/// unless [`Made::keep`] is set.
struct Made {
    folder: PathBuf,
    files: Vec<PathBuf>,
    keep: bool,
}

impl Drop for Made {
    fn drop(&mut self) {
        if !self.keep {
            for file in &self.files {
                let _ = fs::remove_file(file);
            }
            let _ = fs::remove_dir(&self.folder);
        }
    }
}

/// `<base> stems`, or `<base> stems (2)`, `(3)`… when a folder of that name is there already.
fn new_folder(parent: &Path, base: &str) -> Result<PathBuf, CommandError> {
    for n in 1.. {
        let name = if n == 1 {
            format!("{base} stems")
        } else {
            format!("{base} stems ({n})")
        };
        let path = parent.join(name);
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(write_err(&e)),
        }
    }
    unreachable!("the loop ends when a folder name is free")
}

/// The cached WAV file `from` copied to `dest`, block by block.
fn copy_wav(
    from: &Path,
    dest: &Path,
    stop: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<(), CommandError> {
    let mut input = File::open(from)
        .map_err(|e| fail(ErrorKind::Audio, format!("A stem could not be opened: {e}")))?;
    let total = input.metadata().map_or(1, |m| m.len()).max(1);
    let mut temp = TempFile::beside(dest);
    let mut output = File::create(&temp.path).map_err(|e| write_err(&e))?;
    let mut block = vec![0u8; COPY_BLOCK];
    let mut done = 0u64;
    loop {
        check_stop(stop)?;
        let n = input
            .read(&mut block)
            .map_err(|e| fail(ErrorKind::Audio, format!("A stem could not be read: {e}")))?;
        if n == 0 {
            break;
        }
        output.write_all(&block[..n]).map_err(|e| write_err(&e))?;
        done += n as u64;
        progress(done as f32 / total as f32);
    }
    output.flush().map_err(|e| write_err(&e))?;
    drop(output);
    fs::rename(&temp.path, dest).map_err(|e| write_err(&e))?;
    temp.keep = true;
    Ok(())
}

/// Writes one file per chosen stem into a new folder inside `request.dir`. Each file has the
/// stem's own samples, length and rate. A set `stop`, or any error, removes what was written.
pub fn export_batch(
    store: &StemStore,
    request: &BatchRequest,
    stop: &AtomicBool,
    emit: &mut dyn FnMut(&'static str, f32),
) -> Result<ExportResult, CommandError> {
    let (song, kinds) = resolve(store, &request.id, &request.kinds)?;
    let parent = Path::new(&request.dir);
    if !parent.is_dir() {
        return Err(fail(ErrorKind::NotFound, "The folder is not there."));
    }
    check_stop(stop)?;
    let song_name = safe_base(&song.name);
    let mut made = Made {
        folder: new_folder(parent, &song_name)?,
        files: Vec::new(),
        keep: false,
    };
    let count = kinds.len() as f32;
    emit("writing", 0.0);
    for (i, kind) in kinds.iter().enumerate() {
        let name = safe_base(&format!("{} - {song_name}", label(*kind)));
        let dest = made
            .folder
            .join(format!("{name}.{}", request.format.extension()));
        let from = store
            .stem_path(&song.id, *kind)
            .map_err(|e| fail(ErrorKind::Audio, e))?;
        let base = i as f32 / count;
        let mut inner_emit = |f: f32| emit("writing", base + f / count);
        let mut throttle = Throttle::new(&mut inner_emit);
        match request.format {
            ExportFormat::Wav => copy_wav(&from, &dest, stop, &mut |f| throttle.at(f))?,
            ExportFormat::Flac => {
                let frames = Pcm16::open(&from).map_err(audio_err)?.frames.max(1);
                let encoded = codec::encode_wav(&from, stop, bundle::STOPPED, &mut |done| {
                    throttle.at(done as f32 / frames as f32);
                })
                .map_err(audio_err)?;
                write_atomic(&dest, &encoded.bytes)?;
            }
        }
        made.files.push(dest);
    }
    made.keep = true;
    emit("writing", 1.0);
    Ok(ExportResult {
        paths: made
            .files
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        folder: Some(made.folder.to_string_lossy().into_owned()),
        clipped: false,
    })
}

fn emitter<R: Runtime>(app: AppHandle<R>) -> impl FnMut(&'static str, f32) {
    move |stage, fraction| {
        let _ = app.emit(PROGRESS_EVENT, Progress { stage, fraction });
    }
}

/// Adds the chosen stems up into one audio file. Emits `stems-export-progress`. Stopped by
/// `stems_cancel` with [`bundle::STOPPED`].
#[tauri::command]
pub async fn stems_export_mixed<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, StemStore>,
    run: State<'_, StemsRun>,
    request: MixedRequest,
) -> Result<ExportResult, CommandError> {
    let store = store.inner().clone();
    let stop = run.start_export();
    let worker = {
        let stop = stop.clone();
        tauri::async_runtime::spawn_blocking(move || {
            export_mixed(&store, &request, &stop, &mut emitter(app))
        })
    };
    let result = worker.await;
    run.finish_export(&stop);
    result.unwrap_or_else(|_| Err(fail(ErrorKind::Io, "The stems could not be exported.")))
}

/// Writes one audio file per chosen stem into a new folder. Emits `stems-export-progress`.
/// Stopped by `stems_cancel` with [`bundle::STOPPED`].
#[tauri::command]
pub async fn stems_export_batch<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, StemStore>,
    run: State<'_, StemsRun>,
    request: BatchRequest,
) -> Result<ExportResult, CommandError> {
    let store = store.inner().clone();
    let stop = run.start_export();
    let worker = {
        let stop = stop.clone();
        tauri::async_runtime::spawn_blocking(move || {
            export_batch(&store, &request, &stop, &mut emitter(app))
        })
    };
    let result = worker.await;
    run.finish_export(&stop);
    result.unwrap_or_else(|_| Err(fail(ErrorKind::Io, "The stems could not be exported.")))
}

/// Puts one stem of a cached song into the lanes' audio files (decoded once, kept by content),
/// so a lane can play it. The audio is embedded when the tab is saved, so the cache may forget
/// the song afterwards.
#[tauri::command(async)]
pub fn stems_audio_source(
    id: String,
    kind: StemKind,
    store: State<'_, StemStore>,
    audio: State<'_, AudioState>,
) -> Result<SourceInfo, CommandError> {
    let (song, _) = resolve(&store, &id, &[kind])?;
    let path = store
        .stem_path(&song.id, kind)
        .map_err(|e| fail(ErrorKind::Audio, e))?;
    let size = fs::metadata(&path)
        .map_err(|e| fail(ErrorKind::Audio, format!("A stem could not be opened: {e}")))?
        .len();
    if size > backing::MAX_FILE_BYTES as u64 {
        return Err(fail(ErrorKind::TooLarge, "The stem is too large."));
    }
    let bytes = fs::read(&path)
        .map_err(|e| fail(ErrorKind::Audio, format!("A stem could not be read: {e}")))?;
    let name = format!(
        "{}.wav",
        safe_base(&format!("{} - {}", label(kind), song.name))
    );
    audio::add_source(&audio, name, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stems::codec::tests::{signal, write_pcm};
    use crate::stems::wav::WavSink;
    use crate::stems::{StemEngine, StemInfo};

    const ID: &str = "0123456789abcdef";

    /// A song in the cache with the given stems (kind, interleaved samples) at 44.1 kHz.
    fn cached(
        store: &StemStore,
        engine: StemEngine,
        name: &str,
        stems: &[(StemKind, Vec<i16>)],
    ) -> StemSong {
        let staging = store.staging(ID).unwrap();
        let mut infos = Vec::new();
        for (kind, samples) in stems {
            let path = staging.path().join(format!("{}.wav", kind.id()));
            write_pcm(&path, 44_100, samples);
            infos.push(StemInfo {
                kind: *kind,
                bytes: fs::metadata(&path).unwrap().len(),
            });
        }
        let song = StemSong {
            id: ID.into(),
            name: name.into(),
            duration_seconds: stems[0].1.len() as f64 / 2.0 / 44_100.0,
            sample_rate: 44_100,
            engine,
            strong_drums: false,
            bytes: infos.iter().map(|s| s.bytes).sum(),
            stems: infos,
            mono: false,
            skipped: Vec::new(),
            panned_share: 0.0,
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

    fn store(dir: &Path) -> StemStore {
        StemStore::new(dir.join("stems"))
    }

    fn pcm_of(path: &Path) -> (u32, Vec<i16>) {
        let mut reader = hound::WavReader::open(path).unwrap();
        let rate = reader.spec().sample_rate;
        (rate, reader.samples::<i16>().map(|s| s.unwrap()).collect())
    }

    /// The samples of a FLAC file, decoded by the same code the stems file uses.
    fn flac_pcm(path: &Path, work: &Path) -> (u32, Vec<i16>) {
        let bytes = fs::read(path).unwrap();
        let mut sink = WavSink::new(work, 44_100);
        let never = AtomicBool::new(false);
        let decoded = codec::decode_flac(
            bytes,
            StemKind::Other,
            &mut sink,
            &never,
            bundle::STOPPED,
            &mut |_| {},
        )
        .unwrap();
        sink.finish().unwrap();
        let (_, samples) = pcm_of(&work.join("other.wav"));
        (decoded.rate, samples)
    }

    fn mixed(id: &str, kinds: &[StemKind], format: ExportFormat, dest: &Path) -> MixedRequest {
        MixedRequest {
            id: id.into(),
            kinds: kinds.to_vec(),
            format,
            dest: dest.to_string_lossy().into_owned(),
        }
    }

    fn batch(id: &str, kinds: &[StemKind], format: ExportFormat, dir: &Path) -> BatchRequest {
        BatchRequest {
            id: id.into(),
            kinds: kinds.to_vec(),
            format,
            dir: dir.to_string_lossy().into_owned(),
        }
    }

    fn never() -> AtomicBool {
        AtomicBool::new(false)
    }

    fn mixed_ok(store: &StemStore, request: &MixedRequest) -> ExportResult {
        export_mixed(store, request, &never(), &mut |_, _| {}).unwrap()
    }

    fn batch_ok(store: &StemStore, request: &BatchRequest) -> ExportResult {
        export_batch(store, request, &never(), &mut |_, _| {}).unwrap()
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn summed(a: &[i16], b: &[i16]) -> Vec<i16> {
        (0..a.len().max(b.len()))
            .map(|i| {
                let x = i32::from(*a.get(i).unwrap_or(&0)) + i32::from(*b.get(i).unwrap_or(&0));
                x.clamp(-32768, 32767) as i16
            })
            .collect()
    }

    #[test]
    fn a_mixed_wav_is_the_sum_of_the_chosen_stems() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let stems = two_stems();
        cached(&store, StemEngine::Htdemucs, "Band Song", &stems);
        let dest = dir.path().join("mix.wav");
        let result = mixed_ok(
            &store,
            &mixed(
                ID,
                &[StemKind::Drums, StemKind::Other],
                ExportFormat::Wav,
                &dest,
            ),
        );
        assert_eq!(result.paths, vec![dest.to_string_lossy().into_owned()]);
        assert_eq!(result.folder, None);
        let (rate, samples) = pcm_of(&dest);
        assert_eq!(rate, 44_100);
        assert_eq!(samples.len(), stems[0].1.len());
        // The stems are summed as floats and rounded once; allow the one-step rounding.
        let expected = summed(&stems[0].1, &stems[1].1);
        for (got, want) in samples.iter().zip(&expected) {
            assert!(
                (i32::from(*got) - i32::from(*want)).abs() <= 1,
                "{got} vs {want}"
            );
        }
    }

    #[test]
    fn only_the_chosen_stems_are_in_the_mix() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let stems = two_stems();
        cached(&store, StemEngine::Htdemucs, "Band Song", &stems);
        let dest = dir.path().join("one.wav");
        mixed_ok(
            &store,
            &mixed(ID, &[StemKind::Other], ExportFormat::Wav, &dest),
        );
        let (_, samples) = pcm_of(&dest);
        assert_eq!(samples, stems[1].1);
    }

    #[test]
    fn a_shorter_stem_is_padded_with_silence_in_the_mix() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let long = signal(10_000);
        let short = signal(4_000);
        cached(
            &store,
            StemEngine::Fast,
            "Band Song",
            &[
                (StemKind::Drums, long.clone()),
                (StemKind::Bass, short.clone()),
            ],
        );
        let dest = dir.path().join("padded.wav");
        mixed_ok(
            &store,
            &mixed(
                ID,
                &[StemKind::Drums, StemKind::Bass],
                ExportFormat::Wav,
                &dest,
            ),
        );
        let (_, samples) = pcm_of(&dest);
        assert_eq!(samples.len(), long.len());
        assert_eq!(&samples[short.len()..], &long[short.len()..]);
    }

    #[test]
    fn a_mixed_flac_decodes_to_the_same_samples_as_the_wav() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        cached(&store, StemEngine::Htdemucs, "Band Song", &two_stems());
        let kinds = [StemKind::Drums, StemKind::Other];
        let wav = dir.path().join("mix.wav");
        let flac = dir.path().join("mix.flac");
        mixed_ok(&store, &mixed(ID, &kinds, ExportFormat::Wav, &wav));
        mixed_ok(&store, &mixed(ID, &kinds, ExportFormat::Flac, &flac));
        let (wav_rate, wav_samples) = pcm_of(&wav);
        let work = dir.path().join("work");
        fs::create_dir(&work).unwrap();
        let (flac_rate, flac_samples) = flac_pcm(&flac, &work);
        assert_eq!(flac_rate, wav_rate);
        assert_eq!(flac_samples, wav_samples);
    }

    #[test]
    fn the_extension_is_added_when_the_name_has_none() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        cached(&store, StemEngine::Fast, "Band Song", &two_stems());
        let wav = mixed_ok(
            &store,
            &mixed(
                ID,
                &[StemKind::Drums],
                ExportFormat::Wav,
                &dir.path().join("a"),
            ),
        );
        let flac = mixed_ok(
            &store,
            &mixed(
                ID,
                &[StemKind::Drums],
                ExportFormat::Flac,
                &dir.path().join("b.WAV"),
            ),
        );
        assert!(wav.paths[0].ends_with("a.wav"), "{:?}", wav.paths);
        assert!(flac.paths[0].ends_with("b.WAV.flac"), "{:?}", flac.paths);
        let kept = names_in(dir.path());
        assert!(kept.contains(&"a.wav".to_string()) && kept.contains(&"b.WAV.flac".to_string()));
        assert!(!kept.iter().any(|n| n.ends_with(".tmp")), "{kept:?}");
    }

    #[test]
    fn a_sum_louder_than_full_scale_is_limited_and_reported() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let loud = vec![30_000i16; 2_000];
        cached(
            &store,
            StemEngine::Fast,
            "Band Song",
            &[(StemKind::Drums, loud.clone()), (StemKind::Bass, loud)],
        );
        let dest = dir.path().join("loud.wav");
        let result = mixed_ok(
            &store,
            &mixed(
                ID,
                &[StemKind::Drums, StemKind::Bass],
                ExportFormat::Wav,
                &dest,
            ),
        );
        assert!(result.clipped);
        let (_, samples) = pcm_of(&dest);
        assert!(samples.iter().all(|s| *s == 32_767));
        let quiet = mixed_ok(
            &store,
            &mixed(ID, &[StemKind::Drums], ExportFormat::Wav, &dest),
        );
        assert!(!quiet.clipped);
    }

    #[test]
    fn a_batch_writes_one_file_per_stem_into_a_new_folder() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let stems = two_stems();
        cached(&store, StemEngine::Htdemucs, "Band Song", &stems);
        let out = dir.path().join("out");
        fs::create_dir(&out).unwrap();
        // The order the request lists them in does not matter.
        let result = batch_ok(
            &store,
            &batch(
                ID,
                &[StemKind::Other, StemKind::Drums, StemKind::Other],
                ExportFormat::Wav,
                &out,
            ),
        );
        let folder = out.join("Band Song stems");
        assert_eq!(result.folder, Some(folder.to_string_lossy().into_owned()));
        assert_eq!(
            names_in(&folder),
            vec!["Drums - Band Song.wav", "Other - Band Song.wav"]
        );
        assert_eq!(names_in(&out), vec!["Band Song stems"]);
        assert_eq!(result.paths.len(), 2);
        assert!(result.paths[0].ends_with("Drums - Band Song.wav"));
        for (kind, samples) in &stems {
            let file = folder.join(format!("{} - Band Song.wav", label(*kind)));
            let (rate, got) = pcm_of(&file);
            assert_eq!(rate, 44_100);
            assert_eq!(&got, samples, "{kind:?}");
            // Byte for byte the cached file: same length, rate and samples.
            assert_eq!(
                fs::read(&file).unwrap(),
                fs::read(store.stem_path(ID, *kind).unwrap()).unwrap()
            );
        }
    }

    #[test]
    fn a_batch_of_flac_files_decodes_to_the_cached_samples() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let stems = two_stems();
        cached(&store, StemEngine::Htdemucs, "Band Song", &stems);
        let out = dir.path().join("out");
        fs::create_dir(&out).unwrap();
        let result = batch_ok(
            &store,
            &batch(
                ID,
                &[StemKind::Drums, StemKind::Other],
                ExportFormat::Flac,
                &out,
            ),
        );
        let folder = PathBuf::from(result.folder.unwrap());
        assert_eq!(
            names_in(&folder),
            vec!["Drums - Band Song.flac", "Other - Band Song.flac"]
        );
        for (kind, samples) in &stems {
            let work = dir.path().join(format!("work-{}", kind.id()));
            fs::create_dir(&work).unwrap();
            let (rate, got) = flac_pcm(
                &folder.join(format!("{} - Band Song.flac", label(*kind))),
                &work,
            );
            assert_eq!((rate, &got), (44_100, samples));
        }
    }

    #[test]
    fn a_second_batch_gets_a_folder_of_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        cached(&store, StemEngine::Fast, "Band Song", &two_stems());
        let out = dir.path().join("out");
        fs::create_dir(&out).unwrap();
        let request = batch(ID, &[StemKind::Drums], ExportFormat::Wav, &out);
        batch_ok(&store, &request);
        batch_ok(&store, &request);
        assert_eq!(
            names_in(&out),
            vec!["Band Song stems", "Band Song stems (2)"]
        );
    }

    #[test]
    fn file_names_have_no_characters_a_drive_refuses() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        cached(
            &store,
            StemEngine::Fast,
            "AC/DC: Back in Black?",
            &two_stems(),
        );
        let out = dir.path().join("out");
        fs::create_dir(&out).unwrap();
        let result = batch_ok(
            &store,
            &batch(ID, &[StemKind::Drums], ExportFormat::Wav, &out),
        );
        assert_eq!(names_in(&out), vec!["AC_DC_ Back in Black_ stems"]);
        assert!(
            result.paths[0].ends_with("Drums - AC_DC_ Back in Black_.wav"),
            "{:?}",
            result.paths
        );
    }

    #[test]
    fn every_engine_variant_exports_the_same_way() {
        let dir = tempfile::tempdir().unwrap();
        for engine in [
            StemEngine::Fast,
            StemEngine::Neural,
            StemEngine::Scnet,
            StemEngine::ScnetXl,
            StemEngine::Htdemucs,
            StemEngine::Htdemucs6s,
        ] {
            let store = store(&dir.path().join(format!("{engine:?}")));
            let kinds: Vec<StemKind> = match engine {
                StemEngine::Fast => StemKind::FAST.to_vec(),
                e => {
                    let mut k = e.neural_kinds().to_vec();
                    k.push(StemKind::Other);
                    k
                }
            };
            let stems: Vec<(StemKind, Vec<i16>)> =
                kinds.iter().map(|k| (*k, signal(3_000))).collect();
            cached(&store, engine, "Song", &stems);
            let out = dir.path().join(format!("out-{engine:?}"));
            fs::create_dir(&out).unwrap();
            let result = batch_ok(&store, &batch(ID, &kinds, ExportFormat::Wav, &out));
            assert_eq!(result.paths.len(), kinds.len(), "{engine:?}");
            let dest = out.join("mix.flac");
            mixed_ok(&store, &mixed(ID, &kinds, ExportFormat::Flac, &dest));
            assert!(dest.is_file(), "{engine:?}");
        }
    }

    #[test]
    fn exporting_nothing_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        cached(&store, StemEngine::Fast, "Band Song", &two_stems());
        let dest = dir.path().join("none.wav");
        let error = export_mixed(
            &store,
            &mixed(ID, &[], ExportFormat::Wav, &dest),
            &never(),
            &mut |_, _| {},
        )
        .unwrap_err();
        assert!(
            error.message.contains("at least one stem"),
            "{}",
            error.message
        );
        assert!(!dest.exists());
        let error = export_batch(
            &store,
            &batch(ID, &[], ExportFormat::Wav, dir.path()),
            &never(),
            &mut |_, _| {},
        )
        .unwrap_err();
        assert!(
            error.message.contains("at least one stem"),
            "{}",
            error.message
        );
        assert_eq!(names_in(dir.path()), vec!["stems"]);
    }

    #[test]
    fn a_stem_the_song_does_not_have_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        cached(&store, StemEngine::Fast, "Band Song", &two_stems());
        let error = export_mixed(
            &store,
            &mixed(
                ID,
                &[StemKind::Guitar],
                ExportFormat::Wav,
                &dir.path().join("g.wav"),
            ),
            &never(),
            &mut |_, _| {},
        )
        .unwrap_err();
        assert!(
            error.message.contains("no guitar stem"),
            "{}",
            error.message
        );
        let error = export_batch(
            &store,
            &batch(
                "ffffffffffffffff",
                &[StemKind::Drums],
                ExportFormat::Wav,
                dir.path(),
            ),
            &never(),
            &mut |_, _| {},
        )
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);
    }

    #[test]
    fn a_missing_folder_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        cached(&store, StemEngine::Fast, "Band Song", &two_stems());
        let error = export_batch(
            &store,
            &batch(
                ID,
                &[StemKind::Drums],
                ExportFormat::Wav,
                &dir.path().join("gone"),
            ),
            &never(),
            &mut |_, _| {},
        )
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);
    }

    #[test]
    fn a_stopped_mixed_export_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        cached(&store, StemEngine::Htdemucs, "Band Song", &two_stems());
        let kinds = [StemKind::Drums, StemKind::Other];
        for format in [ExportFormat::Wav, ExportFormat::Flac] {
            let dest = dir.path().join("mix");
            let stop = AtomicBool::new(true);
            let error = export_mixed(
                &store,
                &mixed(ID, &kinds, format, &dest),
                &stop,
                &mut |_, _| {},
            )
            .unwrap_err();
            assert_eq!(error.message, bundle::STOPPED);
            assert_eq!(names_in(dir.path()), vec!["stems"], "{format:?}");
        }
    }

    #[test]
    fn a_batch_stopped_between_files_removes_the_files_and_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        cached(&store, StemEngine::Htdemucs, "Band Song", &two_stems());
        let out = dir.path().join("out");
        fs::create_dir(&out).unwrap();
        for format in [ExportFormat::Wav, ExportFormat::Flac] {
            let stop = AtomicBool::new(false);
            // The first file is done at a progress of 0.5; the stop comes then.
            let error = export_batch(
                &store,
                &batch(ID, &[StemKind::Drums, StemKind::Other], format, &out),
                &stop,
                &mut |_, fraction| {
                    if fraction >= 0.5 {
                        stop.store(true, Ordering::Relaxed);
                    }
                },
            )
            .unwrap_err();
            assert_eq!(error.message, bundle::STOPPED);
            assert!(
                names_in(&out).is_empty(),
                "{format:?}: {:?}",
                names_in(&out)
            );
        }
    }

    #[test]
    fn progress_rises_to_one_and_never_goes_back() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        cached(&store, StemEngine::Htdemucs, "Band Song", &two_stems());
        let out = dir.path().join("out");
        fs::create_dir(&out).unwrap();
        for format in [ExportFormat::Wav, ExportFormat::Flac] {
            let mut seen: Vec<f32> = Vec::new();
            export_mixed(
                &store,
                &mixed(
                    ID,
                    &[StemKind::Drums, StemKind::Other],
                    format,
                    &out.join("m"),
                ),
                &never(),
                &mut |_, f| seen.push(f),
            )
            .unwrap();
            assert!(
                seen.windows(2).all(|w| w[0] <= w[1]),
                "{format:?}: {seen:?}"
            );
            assert_eq!(seen.last(), Some(&1.0));
            let mut seen: Vec<f32> = Vec::new();
            let result = export_batch(
                &store,
                &batch(ID, &[StemKind::Drums, StemKind::Other], format, &out),
                &never(),
                &mut |_, f| seen.push(f),
            )
            .unwrap();
            assert!(
                seen.windows(2).all(|w| w[0] <= w[1]),
                "{format:?}: {seen:?}"
            );
            assert_eq!(seen.last(), Some(&1.0));
            fs::remove_dir_all(result.folder.unwrap()).unwrap();
        }
    }

    #[test]
    fn a_stem_too_short_for_flac_is_refused_and_leaves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        cached(
            &store,
            StemEngine::Fast,
            "Band Song",
            &[(StemKind::Drums, signal(4))],
        );
        let dest = dir.path().join("tiny.flac");
        let error = export_mixed(
            &store,
            &mixed(ID, &[StemKind::Drums], ExportFormat::Flac, &dest),
            &never(),
            &mut |_, _| {},
        )
        .unwrap_err();
        assert!(error.message.contains("too short"), "{}", error.message);
        assert_eq!(names_in(dir.path()), vec!["stems"]);
    }
}
