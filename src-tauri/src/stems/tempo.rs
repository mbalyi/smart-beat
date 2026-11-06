//! The tempo of a separated song: reads the cached stems, runs [`crate::separation::tempo`] and
//! keeps the result in the song's `meta.json`, so the analysis runs once per song and
//! algorithm version.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::State;

use super::store::StemStore;
use super::wav::Pcm16;
use super::{StemSong, StemsRun, error};
use crate::error::{CommandError, ErrorKind};
use crate::separation::StemKind;
use crate::separation::tempo::{self, ALGORITHM_VERSION, Tempo};

const BLOCK: usize = 65_536;

/// A tempo as saved in `meta.json`: which version of the algorithm made it, and the result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredTempo {
    pub version: u8,
    pub tempo: Tempo,
}

/// One stem as mono (the mean of both channels) and its sample rate.
fn read_mono(store: &StemStore, id: &str, kind: StemKind) -> Result<(u32, Vec<f32>), String> {
    let mut pcm = Pcm16::open(&store.stem_path(id, kind)?)?;
    let mut mono = Vec::with_capacity(pcm.frames as usize);
    let (mut left, mut right) = (Vec::new(), Vec::new());
    loop {
        left.clear();
        right.clear();
        if pcm.read_block(&mut left, &mut right, BLOCK)? == 0 {
            break;
        }
        mono.extend(left.iter().zip(&right).map(|(l, r)| 0.5 * (l + r)));
    }
    Ok((pcm.rate, mono))
}

/// The song's tempo from its stems: the drums stem (if it has one) next to the sum of all
/// stems, which is the original mix.
pub fn analyse_song(
    store: &StemStore,
    song: &StemSong,
    stop: &AtomicBool,
) -> Result<Tempo, String> {
    let cancelled = || stop.load(Ordering::Relaxed);
    let mut rate = song.sample_rate;
    let mut mix: Vec<f32> = Vec::new();
    let mut drums: Option<Vec<f32>> = None;
    for info in &song.stems {
        if cancelled() {
            return Err(tempo::STOPPED.into());
        }
        let (stem_rate, mono) = read_mono(store, &song.id, info.kind)?;
        rate = stem_rate;
        if mix.len() < mono.len() {
            mix.resize(mono.len(), 0.0);
        }
        for (m, s) in mix.iter_mut().zip(&mono) {
            *m += s;
        }
        if info.kind == StemKind::Drums {
            drums = Some(mono);
        }
    }
    if let Some(d) = drums.as_mut() {
        d.resize(mix.len(), 0.0);
    }
    tempo::analyse(&mix, drums.as_deref(), rate, &cancelled)
        .map(|a| a.tempo)
        .map_err(|_| tempo::STOPPED.to_string())
}

/// The tempo of the song `id`: the saved one when it is from this version of the algorithm,
/// else a fresh analysis, saved.
pub fn detect(store: &StemStore, id: &str, stop: &AtomicBool) -> Result<Tempo, CommandError> {
    let song = store.get(id).ok_or_else(|| {
        CommandError::new(ErrorKind::NotFound, "That song is not saved any more.")
    })?;
    if let Some(saved) = song
        .tempo
        .as_ref()
        .filter(|t| t.version == ALGORITHM_VERSION)
    {
        return Ok(saved.tempo.clone());
    }
    let found = analyse_song(store, &song, stop).map_err(error)?;
    let stored = StoredTempo {
        version: ALGORITHM_VERSION,
        tempo: found.clone(),
    };
    // A song deleted while it was analysed just does not keep the result.
    let _ = store.update(id, |s| s.tempo = Some(stored));
    Ok(found)
}

/// The tempo of a separated song (see [`tempo::Tempo`]); the result is cached in the song.
/// Stopped by `stems_cancel`.
#[tauri::command]
pub async fn stems_detect_tempo(
    store: State<'_, StemStore>,
    run: State<'_, StemsRun>,
    id: String,
) -> Result<Tempo, CommandError> {
    let store = store.inner().clone();
    let stop: Arc<AtomicBool> = run.start_tempo();
    let worker = {
        let stop = stop.clone();
        tauri::async_runtime::spawn_blocking(move || detect(&store, &id, &stop))
    };
    let result = worker.await;
    run.finish_tempo(&stop);
    result.unwrap_or_else(|_| Err(error("The tempo could not be detected.")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::separation::StemSink;
    use crate::separation::tempo as dsp;
    use crate::stems::wav::WavSink;
    use crate::stems::{StemEngine, StemInfo};

    const RATE: u32 = 44_100;

    /// A song folder with a drums stem (clicks at `bpm`) and an "other" stem (a held tone).
    fn song_with_clicks(store: &StemStore, id: &str, bpm: f64, mono: bool) -> StemSong {
        let seconds = 20.0;
        let len = (seconds * f64::from(RATE)) as usize;
        let mut drums = vec![0.0f32; len];
        let period = 60.0 / bpm;
        let mut t = 0.4;
        while t < seconds - 0.1 {
            let start = (t * f64::from(RATE)) as usize;
            for i in 0..(0.02 * f64::from(RATE)) as usize {
                let x = i as f32 / RATE as f32;
                drums[start + i] +=
                    (std::f32::consts::TAU * 1500.0 * x).sin() * (-x * 250.0).exp() * 0.8;
            }
            t += period;
        }
        let tone: Vec<f32> = (0..len)
            .map(|i| 0.1 * (std::f32::consts::TAU * 220.0 * i as f32 / RATE as f32).sin())
            .collect();
        let staging = store.staging(id).unwrap();
        let mut sink = WavSink::new(staging.path(), RATE);
        let right: Vec<f32> = if mono {
            drums.clone()
        } else {
            drums.iter().map(|d| d * 0.5).collect()
        };
        sink.write(StemKind::Drums, &drums, &right).unwrap();
        sink.write(StemKind::Other, &tone, &tone).unwrap();
        let stems: Vec<StemInfo> = sink.finish().unwrap();
        let song = StemSong {
            id: id.into(),
            name: "Clicks".into(),
            duration_seconds: seconds,
            sample_rate: RATE,
            engine: StemEngine::Fast,
            strong_drums: false,
            bytes: stems.iter().map(|s| s.bytes).sum(),
            stems,
            mono,
            skipped: vec![],
            panned_share: 0.0,
            created_at_ms: 1,
            pinned: false,
            last_opened: None,
            saved_path: None,
            has_original: false,
            tempo: None,
        };
        store.commit(staging, &song).unwrap();
        song
    }

    #[test]
    fn the_tempo_is_measured_from_the_stems_cached_and_recomputed_for_a_new_version() {
        let dir = tempfile::tempdir().unwrap();
        let store = StemStore::new(dir.path().to_path_buf());
        let id = "00000000000000aa";
        song_with_clicks(&store, id, 124.0, false);
        let stop = AtomicBool::new(false);

        let first = detect(&store, id, &stop).unwrap();
        assert!((first.bpm - 124.0).abs() < 0.5, "got {}", first.bpm);
        assert!((first.first_beat_sec - 0.4).abs() < 0.03);
        let saved = store.get(id).unwrap().tempo.unwrap();
        assert_eq!((saved.version, &saved.tempo), (ALGORITHM_VERSION, &first));

        // A saved result of this version is returned as is, whatever the audio says.
        let mut doctored = first.clone();
        doctored.bpm = 99.0;
        store
            .update(id, |s| {
                s.tempo = Some(StoredTempo {
                    version: ALGORITHM_VERSION,
                    tempo: doctored.clone(),
                })
            })
            .unwrap();
        assert_eq!(detect(&store, id, &stop).unwrap().bpm, 99.0);

        // Another version is analysed again.
        store
            .update(id, |s| {
                s.tempo = Some(StoredTempo {
                    version: dsp::ALGORITHM_VERSION + 1,
                    tempo: doctored.clone(),
                })
            })
            .unwrap();
        let again = detect(&store, id, &stop).unwrap();
        assert!((again.bpm - 124.0).abs() < 0.5);
        assert_eq!(
            store.get(id).unwrap().tempo.unwrap().version,
            ALGORITHM_VERSION
        );
    }

    #[test]
    fn older_meta_files_without_a_tempo_still_load() {
        let dir = tempfile::tempdir().unwrap();
        let store = StemStore::new(dir.path().to_path_buf());
        let id = "00000000000000bb";
        song_with_clicks(&store, id, 100.0, true);
        let meta = dir.path().join(id).join("meta.json");
        let mut json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&meta).unwrap()).unwrap();
        json.as_object_mut().unwrap().remove("tempo");
        std::fs::write(&meta, serde_json::to_vec(&json).unwrap()).unwrap();
        let song = store.get(id).unwrap();
        assert!(song.tempo.is_none());
        let t = detect(&store, id, &AtomicBool::new(false)).unwrap();
        assert!((t.bpm - 100.0).abs() < 0.5, "got {}", t.bpm);
    }

    #[test]
    fn a_stopped_analysis_is_reported_and_not_saved() {
        let dir = tempfile::tempdir().unwrap();
        let store = StemStore::new(dir.path().to_path_buf());
        let id = "00000000000000cc";
        song_with_clicks(&store, id, 110.0, false);
        let err = detect(&store, id, &AtomicBool::new(true)).unwrap_err();
        assert_eq!(err.message, tempo::STOPPED);
        assert!(store.get(id).unwrap().tempo.is_none());
    }

    #[test]
    fn an_unknown_song_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let store = StemStore::new(dir.path().to_path_buf());
        assert!(detect(&store, "00000000000000dd", &AtomicBool::new(false)).is_err());
        assert!(detect(&store, "../etc", &AtomicBool::new(false)).is_err());
    }
}
