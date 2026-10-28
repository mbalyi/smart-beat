//! Stem separation in the app (issue #186): the library of separated songs, the commands the
//! page calls, and the optional neural model download. The signal processing itself lives in
//! [`crate::separation`].
//!
//! A job reads the file, looks the song up in the [`StemStore`] (same file and options: the
//! saved stems come back at once), decodes, separates segment by segment while a
//! [`wav::WavSink`] writes 16-bit stereo WAV files, and moves the finished folder into the
//! store. The page plays the stems itself; [`mix::render`] makes the slowed-down version.

pub mod mix;
pub mod store;
pub mod umx_model;
pub mod wav;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};

pub use store::StemStore;

use crate::audio::backing::{self, DecodedAudio};
use crate::error::{CommandError, ErrorKind};
use crate::separation::{self, Options, StemKind, pipeline::Report, stereo, umx};

/// Which separation runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StemEngine {
    /// Signal processing, built in.
    Fast,
    /// The downloaded Open-Unmix model.
    Neural,
}

/// Mirrored by `SeparateRequest` in `src/lib/tauri.ts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeparateRequest {
    pub path: String,
    /// The stems the user wants of their own; "other" is always made. Ignored by the neural
    /// engine, which makes drums, bass, vocals and other.
    pub kinds: Vec<StemKind>,
    pub engine: StemEngine,
    #[serde(default)]
    pub strong_drums: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StemInfo {
    pub kind: StemKind,
    pub bytes: u64,
}

/// A separated song as saved in `meta.json` and listed on the page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StemSong {
    pub id: String,
    pub name: String,
    pub duration_seconds: f64,
    pub sample_rate: u32,
    pub engine: StemEngine,
    pub strong_drums: bool,
    pub stems: Vec<StemInfo>,
    pub mono: bool,
    pub skipped: Vec<StemKind>,
    pub panned_share: f32,
    pub bytes: u64,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemCacheInfo {
    pub bytes: u64,
    pub count: u32,
    pub limit_bytes: u64,
}

/// Mirrored by `StemMixRequest` in `src/lib/tauri.ts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixRequest {
    /// Volume 0 to 1 per stem, mute and solo already applied. A stem without an entry is silent.
    pub gains: BTreeMap<StemKind, f32>,
    /// 0.5 to 1.
    pub speed: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Reading,
    Separating,
    Saving,
    Done,
}

#[derive(Clone, Copy, Serialize)]
struct Progress {
    stage: &'static str,
    fraction: f32,
}

fn error(message: impl Into<String>) -> CommandError {
    CommandError::new(ErrorKind::Audio, message)
}

/// The stop switch of the running job. A new job stops the old one.
#[derive(Default)]
pub struct StemsRun(Mutex<Option<Arc<AtomicBool>>>);
impl StemsRun {
    fn start(&self) -> Arc<AtomicBool> {
        let stop = Arc::new(AtomicBool::new(false));
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = slot.replace(stop.clone()) {
            old.store(true, Ordering::Relaxed);
        }
        stop
    }
    fn finish(&self, stop: &Arc<AtomicBool>) {
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if slot
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, stop))
        {
            *slot = None;
        }
    }
    pub fn cancel(&self) {
        if let Some(stop) = self.0.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            stop.store(true, Ordering::Relaxed);
        }
    }
}

/// The wanted stems of a fast job in the order of [`StemKind::ALL`], without duplicates and
/// without "other" (always made).
fn wanted_kinds(request: &SeparateRequest) -> Vec<StemKind> {
    match request.engine {
        StemEngine::Neural => vec![StemKind::Drums, StemKind::Bass, StemKind::Vocals],
        StemEngine::Fast => StemKind::ALL
            .into_iter()
            .filter(|k| *k != StemKind::Other && request.kinds.contains(k))
            .collect(),
    }
}

/// Reads and checks the file the user chose. Returns its name (without extension), its
/// extension, and its bytes.
fn read_audio_file(path: &Path) -> Result<(String, String, Vec<u8>), CommandError> {
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| error("The audio file has no name"))?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !backing::AUDIO_EXTENSIONS.contains(&ext.as_str()) {
        return Err(CommandError::new(
            ErrorKind::UnsupportedType,
            format!("“{file_name}” is not an mp3, wav, flac, ogg or aiff file."),
        ));
    }
    let meta = std::fs::metadata(path).map_err(|e| {
        CommandError::new(
            ErrorKind::NotFound,
            format!("“{file_name}” cannot be opened: {e}"),
        )
    })?;
    if !meta.is_file() {
        return Err(CommandError::new(
            ErrorKind::NotFound,
            format!("“{file_name}” is not a file."),
        ));
    }
    if meta.len() as usize > backing::MAX_FILE_BYTES {
        return Err(CommandError::new(
            ErrorKind::TooLarge,
            format!("“{file_name}” is too large."),
        ));
    }
    let bytes =
        std::fs::read(path).map_err(|e| error(format!("“{file_name}” cannot be opened: {e}")))?;
    let name = path
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or(file_name);
    Ok((name, ext, bytes))
}

/// The recording at 44.1 kHz for the neural model, resampled when it has another rate.
fn at_44100(audio: DecodedAudio) -> Result<DecodedAudio, CommandError> {
    const RATE: u32 = 44_100;
    if audio.rate == RATE {
        return Ok(audio);
    }
    if audio.duration() > backing::MAX_SECONDS {
        return Err(error(
            "The recording is too long to convert to 44.1 kHz for the neural model",
        ));
    }
    let (left, right) = std::thread::scope(|scope| {
        let l = scope.spawn(|| crate::recording::resample(&audio.left, audio.rate, RATE));
        let r = crate::recording::resample(&audio.right, audio.rate, RATE);
        (l.join().expect("a resampling worker panicked"), r)
    });
    Ok(DecodedAudio {
        rate: RATE,
        channels: audio.channels,
        left,
        right,
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// One separation job, from the file to the saved song. `model_dir` is the folder of the neural
/// model when the engine is neural (the command checks that it is ready). `emit` receives the
/// progress, `cancel` stops the job between segments with [`separation::STOPPED`].
pub fn run_job(
    store: &StemStore,
    request: &SeparateRequest,
    model_dir: Option<&Path>,
    cancel: &AtomicBool,
    emit: &mut dyn FnMut(Stage, f32),
) -> Result<StemSong, CommandError> {
    let kinds = wanted_kinds(request);
    if request.engine == StemEngine::Fast && kinds.is_empty() {
        return Err(error("Choose at least one stem to separate."));
    }
    if request.engine == StemEngine::Neural && model_dir.is_none() {
        return Err(error("The neural model is not downloaded."));
    }
    let strong = request.engine == StemEngine::Fast
        && request.strong_drums
        && kinds.contains(&StemKind::Drums);

    emit(Stage::Reading, 0.0);
    let (name, ext, bytes) = read_audio_file(Path::new(&request.path))?;
    let id = store::song_id(&bytes, request.engine, &kinds, strong);
    if let Some(song) = store.get(&id) {
        emit(Stage::Done, 1.0);
        return Ok(song);
    }
    emit(Stage::Reading, 0.3);
    let mut audio = backing::decode(bytes, Some(&ext)).map_err(error)?;
    if audio.frames() == 0 || audio.duration() > backing::MAX_SECONDS {
        return Err(error("The recording is empty or too long"));
    }
    if request.engine == StemEngine::Neural {
        audio = at_44100(audio)?;
    }
    emit(Stage::Reading, 1.0);

    let staging = store.staging(&id).map_err(error)?;
    let mut sink = wav::WavSink::new(staging.path(), audio.rate);
    let mut last = -1.0f32;
    let mut progress = |fraction: f32| {
        // About one event per percent is enough for a progress bar.
        if fraction - last >= 0.01 || fraction >= 1.0 {
            last = fraction;
            emit(Stage::Separating, fraction.clamp(0.0, 1.0));
        }
    };
    let report = match (request.engine, model_dir) {
        (StemEngine::Neural, Some(dir)) => {
            let model = umx::Model::load(dir).map_err(error)?;
            umx::separate(&model, &audio, &mut sink, cancel, &mut progress).map_err(error)?;
            Report {
                mono: stereo::is_mono(&audio.left, &audio.right),
                skipped: Vec::new(),
                panned_share: 0.0,
            }
        }
        _ => {
            let mut options = Options::for_kinds(&kinds);
            if strong {
                options = options.strong_drums();
            }
            separation::separate(&audio, &options, &mut sink, cancel, &mut progress)
                .map_err(error)?
        }
    };
    if cancel.load(Ordering::Relaxed) {
        return Err(error(separation::STOPPED));
    }

    emit(Stage::Saving, 0.0);
    let stems = sink.finish().map_err(error)?;
    let song = StemSong {
        id,
        name,
        duration_seconds: audio.duration(),
        sample_rate: audio.rate,
        engine: request.engine,
        strong_drums: strong,
        bytes: stems.iter().map(|s| s.bytes).sum(),
        stems,
        mono: report.mono,
        skipped: report.skipped,
        panned_share: report.panned_share,
        created_at_ms: now_ms(),
    };
    store.commit(staging, &song).map_err(error)?;
    emit(Stage::Saving, 1.0);
    emit(Stage::Done, 1.0);
    Ok(song)
}

/// Separates a recording into stems (or returns the saved ones). Emits `stems-progress`
/// (`{ stage: "reading" | "separating" | "saving" | "done", fraction }`). A stopped job
/// fails with [`separation::STOPPED`].
#[tauri::command]
pub async fn stems_separate<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, StemStore>,
    run: State<'_, StemsRun>,
    request: SeparateRequest,
) -> Result<StemSong, CommandError> {
    let model_dir = if request.engine == StemEngine::Neural {
        if !umx_model::is_ready(&app) {
            return Err(error("The neural model is not downloaded."));
        }
        Some(umx_model::model_dir(&app).map_err(error)?)
    } else {
        None
    };
    let store = store.inner().clone();
    let stop = run.start();
    let worker = {
        let stop = stop.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut emit = |stage: Stage, fraction: f32| {
                let stage = match stage {
                    Stage::Reading => "reading",
                    Stage::Separating => "separating",
                    Stage::Saving => "saving",
                    Stage::Done => "done",
                };
                let _ = app.emit("stems-progress", Progress { stage, fraction });
            };
            run_job(&store, &request, model_dir.as_deref(), &stop, &mut emit)
        })
    };
    let result = worker.await;
    run.finish(&stop);
    match result {
        Ok(song) => song,
        Err(_) => Err(error("Stem separation failed.")),
    }
}

/// Stops the running separation. Its call fails with [`separation::STOPPED`].
#[tauri::command]
pub fn stems_cancel(run: State<'_, StemsRun>) {
    run.cancel();
}

/// The separated songs, newest first.
#[tauri::command(async)]
pub fn stems_list(store: State<'_, StemStore>) -> Vec<StemSong> {
    store.list()
}

#[tauri::command(async)]
pub fn stems_cache_info(store: State<'_, StemStore>) -> StemCacheInfo {
    store.info()
}

#[tauri::command(async)]
pub fn stems_delete(store: State<'_, StemStore>, id: String) -> Result<(), CommandError> {
    store.delete(&id).map_err(error)
}

/// Deletes every separated song (and stops a running job). Returns the bytes freed.
#[tauri::command(async)]
pub fn stems_clear(
    store: State<'_, StemStore>,
    run: State<'_, StemsRun>,
) -> Result<u64, CommandError> {
    run.cancel();
    store.clear().map_err(error)
}

/// The WAV file of one stem, as raw bytes.
#[tauri::command(async)]
pub fn stems_read(
    store: State<'_, StemStore>,
    id: String,
    kind: StemKind,
) -> Result<tauri::ipc::Response, CommandError> {
    let path: PathBuf = store.stem_path(&id, kind).map_err(error)?;
    let song = store
        .get(&id)
        .filter(|s| s.stems.iter().any(|i| i.kind == kind));
    if song.is_none() {
        return Err(CommandError::new(
            ErrorKind::NotFound,
            "That stem is not saved any more.",
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| error(format!("The stem cannot be read: {e}")))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The stems added up with the given gains and slowed to `speed` without changing the pitch,
/// as a 16-bit stereo WAV file.
#[tauri::command]
pub async fn stems_render_mix(
    store: State<'_, StemStore>,
    id: String,
    request: MixRequest,
) -> Result<tauri::ipc::Response, CommandError> {
    mix::validate(&request.gains, request.speed).map_err(error)?;
    let store = store.inner().clone();
    let song = store.get(&id).ok_or_else(|| {
        CommandError::new(ErrorKind::NotFound, "That song is not saved any more.")
    })?;
    let rendered = tauri::async_runtime::spawn_blocking(move || {
        mix::render(&store, &song, &request.gains, request.speed)
    })
    .await
    .map_err(|_| error("The mix could not be rendered."))?;
    rendered.map(tauri::ipc::Response::new).map_err(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::separation::synth;

    fn write_wav(path: &Path, rate: u32, left: &[f32], right: &[f32]) {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for (l, r) in left.iter().zip(right) {
            w.write_sample((l * 16_000.0) as i16).unwrap();
            w.write_sample((r * 16_000.0) as i16).unwrap();
        }
        w.finalize().unwrap();
    }

    fn request(path: &Path, kinds: &[StemKind]) -> SeparateRequest {
        SeparateRequest {
            path: path.to_string_lossy().into_owned(),
            kinds: kinds.to_vec(),
            engine: StemEngine::Fast,
            strong_drums: false,
        }
    }

    fn job(
        store: &StemStore,
        request: &SeparateRequest,
        cancel: &AtomicBool,
    ) -> (Result<StemSong, CommandError>, Vec<(Stage, f32)>) {
        let mut events = Vec::new();
        let result = run_job(store, request, None, cancel, &mut |s, f| {
            events.push((s, f))
        });
        (result, events)
    }

    #[test]
    fn the_wanted_stems_are_ordered_deduplicated_and_never_include_other() {
        let r = request(
            Path::new("x.wav"),
            &[
                StemKind::Vocals,
                StemKind::Other,
                StemKind::Drums,
                StemKind::Vocals,
            ],
        );
        assert_eq!(wanted_kinds(&r), [StemKind::Drums, StemKind::Vocals]);
        let neural = SeparateRequest {
            engine: StemEngine::Neural,
            kinds: vec![],
            ..r
        };
        assert_eq!(
            wanted_kinds(&neural),
            [StemKind::Drums, StemKind::Bass, StemKind::Vocals]
        );
    }

    #[test]
    fn a_file_that_is_not_audio_is_refused_before_it_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let store = StemStore::new(dir.path().join("stems"));
        let cancel = AtomicBool::new(false);
        let txt = dir.path().join("notes.txt");
        std::fs::write(&txt, "hello").unwrap();
        let err = job(&store, &request(&txt, &[StemKind::Drums]), &cancel)
            .0
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::UnsupportedType);
        let missing = dir.path().join("missing.wav");
        let err = job(&store, &request(&missing, &[StemKind::Drums]), &cancel)
            .0
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotFound);
        // A folder with an audio name is not a file.
        let folder = dir.path().join("folder.wav");
        std::fs::create_dir(&folder).unwrap();
        let err = job(&store, &request(&folder, &[StemKind::Drums]), &cancel)
            .0
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotFound);
        // Right extension, wrong content.
        let fake = dir.path().join("fake.wav");
        std::fs::write(&fake, "this is not audio").unwrap();
        assert!(
            job(&store, &request(&fake, &[StemKind::Drums]), &cancel)
                .0
                .is_err()
        );
        assert!(store.list().is_empty());
    }

    #[test]
    fn no_stem_chosen_and_the_neural_engine_without_a_model_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = StemStore::new(dir.path().join("stems"));
        let cancel = AtomicBool::new(false);
        let path = dir.path().join("a.wav");
        write_wav(&path, 44_100, &[0.1; 100], &[0.1; 100]);
        let err = job(&store, &request(&path, &[StemKind::Other]), &cancel)
            .0
            .unwrap_err();
        assert!(err.message.contains("at least one stem"), "{err}");
        let neural = SeparateRequest {
            engine: StemEngine::Neural,
            ..request(&path, &[])
        };
        let err = job(&store, &neural, &cancel).0.unwrap_err();
        assert_eq!(err.message, "The neural model is not downloaded.");
    }

    #[test]
    fn a_job_saves_stems_that_add_up_and_a_second_job_reuses_them() {
        let dir = tempfile::tempdir().unwrap();
        let store = StemStore::new(dir.path().join("stems"));
        let band = synth::band(6.0);
        let path = dir.path().join("Band Song.wav");
        write_wav(&path, synth::RATE, &band.mix.left, &band.mix.right);
        let kinds = [StemKind::Drums, StemKind::Bass, StemKind::Vocals];
        let cancel = AtomicBool::new(false);

        let (first, events) = job(&store, &request(&path, &kinds), &cancel);
        let song = first.unwrap();
        assert_eq!(song.name, "Band Song");
        assert_eq!(song.sample_rate, synth::RATE);
        assert!((song.duration_seconds - 6.0).abs() < 0.01);
        assert!(!song.mono && song.skipped.is_empty());
        let made: Vec<_> = song.stems.iter().map(|s| s.kind).collect();
        assert_eq!(
            made,
            [
                StemKind::Drums,
                StemKind::Bass,
                StemKind::Vocals,
                StemKind::Other
            ]
        );
        let frames = band.mix.left.len();
        for s in &song.stems {
            assert_eq!(s.bytes, 44 + frames as u64 * 4);
        }
        assert_eq!(song.bytes, song.stems.iter().map(|s| s.bytes).sum::<u64>());
        // Progress goes reading, separating, saving, done and ends at 1.
        let stages: Vec<_> = events.iter().map(|e| e.0).collect();
        let first_of = |s| stages.iter().position(|x| *x == s).unwrap();
        assert!(first_of(Stage::Reading) < first_of(Stage::Separating));
        assert!(first_of(Stage::Separating) < first_of(Stage::Saving));
        assert!(first_of(Stage::Saving) < first_of(Stage::Done));
        assert_eq!(events.last().unwrap(), &(Stage::Done, 1.0));
        // The saved stems add up to the mix (16-bit rounding aside).
        let (mut sum_l, mut sum_r) = (vec![0.0f32; frames], vec![0.0f32; frames]);
        for s in &song.stems {
            let mut pcm = wav::Pcm16::open(&store.stem_path(&song.id, s.kind).unwrap()).unwrap();
            let (mut l, mut r) = (Vec::new(), Vec::new());
            while pcm.read_block(&mut l, &mut r, 1 << 16).unwrap() > 0 {}
            for i in 0..frames {
                sum_l[i] += l[i];
                sum_r[i] += r[i];
            }
        }
        let err: f32 = band
            .mix
            .left
            .iter()
            .zip(&sum_l)
            .map(|(m, s)| (m * 16_000.0 / 32_768.0 - s).powi(2))
            .sum::<f32>()
            / band.mix.left.iter().map(|m| m * m).sum::<f32>();
        assert!(err < 1e-4, "relative error {err}");
        assert_eq!(sum_r.len(), frames);

        // Same file, same options: the saved song at once, no separation.
        let (again, events) = job(&store, &request(&path, &kinds), &cancel);
        assert_eq!(again.unwrap(), song);
        assert_eq!(events.last().unwrap(), &(Stage::Done, 1.0));
        assert!(events.iter().all(|e| e.0 != Stage::Separating));
        // Another option is another song; the order of the kinds does not matter.
        let reordered = [StemKind::Vocals, StemKind::Drums, StemKind::Bass];
        assert_eq!(
            job(&store, &request(&path, &reordered), &cancel)
                .0
                .unwrap()
                .id,
            song.id
        );
        let other = job(&store, &request(&path, &[StemKind::Drums]), &cancel)
            .0
            .unwrap();
        assert_ne!(other.id, song.id);
        assert_eq!(store.list().len(), 2);
    }

    #[test]
    fn a_mono_file_reports_the_stems_it_could_not_make() {
        let dir = tempfile::tempdir().unwrap();
        let store = StemStore::new(dir.path().join("stems"));
        let band = synth::band(4.0);
        let path = dir.path().join("mono.wav");
        write_wav(&path, synth::RATE, &band.mix.left, &band.mix.left);
        let song = job(
            &store,
            &request(
                &path,
                &[StemKind::Drums, StemKind::Vocals, StemKind::Panned],
            ),
            &AtomicBool::new(false),
        )
        .0
        .unwrap();
        assert!(song.mono);
        assert_eq!(song.skipped, [StemKind::Vocals, StemKind::Panned]);
        let made: Vec<_> = song.stems.iter().map(|s| s.kind).collect();
        assert_eq!(made, [StemKind::Drums, StemKind::Other]);
    }

    #[test]
    fn a_cancelled_job_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let stems = dir.path().join("stems");
        let store = StemStore::new(stems.clone());
        let band = synth::band(3.0);
        let path = dir.path().join("a.wav");
        write_wav(&path, synth::RATE, &band.mix.left, &band.mix.right);
        let (result, _) = job(
            &store,
            &request(&path, &[StemKind::Drums]),
            &AtomicBool::new(true),
        );
        assert_eq!(result.unwrap_err().message, separation::STOPPED);
        assert!(store.list().is_empty());
        let leftovers = std::fs::read_dir(&stems).map_or(0, |d| d.count());
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn a_new_job_stops_the_old_one() {
        let run = StemsRun::default();
        let first = run.start();
        let second = run.start();
        assert!(first.load(Ordering::Relaxed));
        assert!(!second.load(Ordering::Relaxed));
        run.cancel();
        assert!(second.load(Ordering::Relaxed));
        run.finish(&second);
        run.cancel();
    }

    #[test]
    fn a_neural_file_at_another_rate_is_resampled_to_44100() {
        let tone: Vec<f32> = (0..48_000).map(|i| (i as f32 * 0.05).sin() * 0.3).collect();
        let audio = DecodedAudio {
            rate: 48_000,
            channels: 2,
            left: tone.clone(),
            right: tone,
        };
        let out = at_44100(audio).unwrap();
        assert_eq!(
            (out.rate, out.left.len(), out.right.len()),
            (44_100, 44_100, 44_100)
        );
    }
}
