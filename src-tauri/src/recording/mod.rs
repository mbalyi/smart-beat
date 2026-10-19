//! Record to tab, the audio-to-notes step: a recorded mono take becomes note events, with no
//! network and no account. The page records in the web view and uploads the raw samples. This
//! module resamples them and runs Basic Pitch (`basic_pitch.rs`) on the CPU through `tract`.
//! The notes then go through the page's MIDI import path. Other engines can sit behind
//! `Transcriber`.
mod basic_pitch;
pub mod drums;
pub mod muscriptor;
pub mod muscriptor_ffi;
pub mod muscriptor_model;
mod notes;
pub mod piano_model;
mod resample;
mod transkun;

pub use basic_pitch::BasicPitch;
pub use drums::{DrumOnsets, DrumOptions};
pub use notes::NoteOptions;
pub use resample::resample;
pub use transkun::Transkun;

use crate::error::{CommandError, ErrorKind};
use serde::{Deserialize, Serialize};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Runtime, State};

/// A take longer than this is refused. Ten minutes take well under a minute on a laptop.
pub const MAX_SECONDS: f64 = 10.0 * 60.0;
/// The range of rates a browser or sound card reports.
const RATES: std::ops::RangeInclusive<u32> = 8_000..=192_000;
/// Same wording as `transcription.rs`, so the page shows one message for both.
const STOPPED: &str = "Transcription stopped.";

fn error(message: impl Into<String>) -> CommandError {
    CommandError::new(ErrorKind::Audio, message)
}

/// One note of a take.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedNote {
    /// Seconds from the start of the take.
    pub start: f64,
    pub end: f64,
    /// MIDI pitch.
    pub pitch: u8,
    /// 1 to 127.
    pub velocity: u8,
}

/// Turns audio into notes. An engine reports progress from 0 to 1 and checks `cancelled`
/// between steps. A stopped run returns an error with the message "Transcription stopped.".
pub trait Transcriber {
    fn transcribe(
        &self,
        samples: &[f32],
        sample_rate: u32,
        progress: &mut dyn FnMut(f32),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<RecordedNote>, CommandError>;
}

/// What was played. A piano gets stricter note settings than the default (guitar and bass),
/// and drums go through their own hit finder.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Instrument {
    #[default]
    Guitar,
    Piano,
    /// Drum hits (`drums.rs`): the notes are General MIDI drum numbers, not pitches.
    Drums,
}
impl Instrument {
    /// The `x-instrument` header value. A missing or unknown value means guitar.
    pub fn parse(value: Option<&str>) -> Self {
        match value.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
            Some("piano") => Self::Piano,
            Some("drums") => Self::Drums,
            _ => Self::Guitar,
        }
    }
    pub fn engine(self) -> BasicPitch {
        BasicPitch {
            options: match self {
                // Drums never come through here: `transcribe_recording` uses `DrumOnsets`.
                Self::Guitar | Self::Drums => NoteOptions::default(),
                Self::Piano => NoteOptions::piano(),
            },
        }
    }
}

/// What `transcribe_recording` returns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Transcribed {
    pub notes: Vec<RecordedNote>,
}

/// Checks a take, then transcribes it. The command and the `transcribe_wav` example both
/// come through here.
pub fn transcribe_take(
    transcriber: &dyn Transcriber,
    samples: &[f32],
    sample_rate: u32,
    progress: &mut dyn FnMut(f32),
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<RecordedNote>, CommandError> {
    check_rate(sample_rate)?;
    check_length(samples.len())?;
    check_duration(samples.len(), sample_rate)?;
    if samples.iter().any(|sample| !sample.is_finite()) {
        return Err(error("The recording has invalid audio values."));
    }
    transcriber.transcribe(samples, sample_rate, progress, cancelled)
}

fn check_rate(rate: u32) -> Result<(), CommandError> {
    if RATES.contains(&rate) {
        Ok(())
    } else {
        Err(error("The recording has an unsupported sample rate."))
    }
}
fn check_length(samples: usize) -> Result<(), CommandError> {
    if samples == 0 {
        Err(error("The recording is empty."))
    } else {
        Ok(())
    }
}
fn check_duration(samples: usize, rate: u32) -> Result<(), CommandError> {
    if samples as f64 / f64::from(rate) > MAX_SECONDS {
        Err(error("Record up to 10 minutes at a time."))
    } else {
        Ok(())
    }
}

/// Little-endian 32-bit float samples.
fn decode_samples(body: &[u8]) -> Result<Vec<f32>, CommandError> {
    if !body.len().is_multiple_of(4) {
        return Err(error("The recording is not 32-bit float audio."));
    }
    let (chunks, _) = body.as_chunks::<4>();
    Ok(chunks
        .iter()
        .map(|bytes| f32::from_le_bytes(*bytes))
        .collect())
}

/// The stop switch of the running transcription. A new run stops the old one, so the page
/// never waits on a take it has given up.
#[derive(Default)]
pub struct RecordingRun(Mutex<Option<Arc<AtomicBool>>>);
impl RecordingRun {
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
    fn cancel(&self) {
        if let Some(stop) = self.0.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            stop.store(true, Ordering::Relaxed);
        }
    }
}

#[derive(Clone, Copy, Serialize)]
struct Progress {
    fraction: f32,
}

/// The take is the raw body: little-endian 32-bit float mono samples. The header
/// `x-sample-rate` carries their rate in Hz, and the optional `x-instrument` (`guitar`, `piano` or `drums`) picks the note settings, and `x-engine: transkun` the downloaded piano model, `x-engine: muscriptor` (with `x-model-size`) the downloaded MuScriptor model. Emits `recording-transcription-progress`.
#[tauri::command]
pub async fn transcribe_recording<R: Runtime>(
    app: AppHandle<R>,
    run: State<'_, RecordingRun>,
    request: Request<'_>,
) -> Result<Transcribed, CommandError> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err(error("The recording is missing."));
    };
    let rate = request
        .headers()
        .get("x-sample-rate")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u32>().ok())
        .ok_or_else(|| error("Missing x-sample-rate."))?;
    // `x-engine: transkun` runs the downloaded piano model instead of Basic Pitch;
    // `x-engine: muscriptor` runs the downloaded MuScriptor model (`x-model-size`).
    let engine = request
        .headers()
        .get("x-engine")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_ascii_lowercase());
    let model_dir = if engine.as_deref() == Some("transkun") {
        let folder = piano_model::dir(&app)?;
        if !piano_model::is_installed(&folder) {
            return Err(error("Download the piano model first."));
        }
        Some(folder)
    } else {
        None
    };
    let ai = if engine.as_deref() == Some("muscriptor") {
        let size = request
            .headers()
            .get("x-model-size")
            .and_then(|value| value.to_str().ok())
            .and_then(muscriptor_model::Size::parse)
            .unwrap_or(muscriptor_model::Size::Medium);
        let folder = muscriptor_model::dir(&app)?;
        muscriptor_model::require_terms(&folder)?;
        if !muscriptor_model::is_installed(&folder, size) {
            return Err(error("Download the MuScriptor model first."));
        }
        Some((folder, size))
    } else {
        None
    };
    let instrument = Instrument::parse(
        request
            .headers()
            .get("x-instrument")
            .and_then(|value| value.to_str().ok()),
    );
    // The length check comes first, so a huge body is not decoded.
    check_rate(rate)?;
    check_length(body.len() / 4)?;
    check_duration(body.len() / 4, rate)?;
    let samples = decode_samples(body)?;
    let stop = run.start();
    let worker = {
        let stop = stop.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut last = -1.0f32;
            let mut progress = |fraction: f32| {
                // About one event per percent is enough for a progress bar.
                if fraction - last >= 0.01 || fraction >= 1.0 {
                    last = fraction;
                    let _ = app.emit("recording-transcription-progress", Progress { fraction });
                }
            };
            let cancelled = || stop.load(Ordering::Relaxed);
            let result = match model_dir {
                _ if ai.is_some() => {
                    let (folder, size) = ai.clone().expect("checked");
                    let engine = muscriptor::Muscriptor {
                        folder,
                        size,
                        instrument,
                    };
                    transcribe_take(&engine, &samples, rate, &mut progress, &cancelled)
                }
                _ if instrument == Instrument::Drums => transcribe_take(
                    &DrumOnsets::default(),
                    &samples,
                    rate,
                    &mut progress,
                    &cancelled,
                ),
                Some(folder) => Transkun::cached(&folder).and_then(|model| {
                    transcribe_take(&*model, &samples, rate, &mut progress, &cancelled)
                }),
                None => transcribe_take(
                    &instrument.engine(),
                    &samples,
                    rate,
                    &mut progress,
                    &cancelled,
                ),
            };
            if result.is_ok() {
                progress(1.0);
            }
            result
        })
    };
    let result = worker.await;
    run.finish(&stop);
    match result {
        Ok(notes) => Ok(Transcribed { notes: notes? }),
        Err(_) => Err(error("Could not detect notes in the recording.")),
    }
}

/// Stops the running transcription. Its call returns the error "Transcription stopped.".
#[tauri::command]
pub fn cancel_recording_transcription(run: State<'_, RecordingRun>) {
    run.cancel();
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed(Vec<RecordedNote>);
    impl Transcriber for Fixed {
        fn transcribe(
            &self,
            _: &[f32],
            _: u32,
            _: &mut dyn FnMut(f32),
            _: &dyn Fn() -> bool,
        ) -> Result<Vec<RecordedNote>, CommandError> {
            Ok(self.0.clone())
        }
    }
    fn take(samples: &[f32], rate: u32) -> Result<Vec<RecordedNote>, CommandError> {
        transcribe_take(&Fixed(vec![]), samples, rate, &mut |_| {}, &|| false)
    }

    #[test]
    fn the_instrument_header_picks_the_note_settings() {
        assert_eq!(Instrument::parse(Some(" Piano ")), Instrument::Piano);
        assert_eq!(Instrument::parse(Some("DRUMS")), Instrument::Drums);
        assert_eq!(Instrument::parse(Some("guitar")), Instrument::Guitar);
        assert_eq!(Instrument::parse(Some("kazoo")), Instrument::Guitar);
        assert_eq!(Instrument::parse(None), Instrument::Guitar);
        assert_eq!(Instrument::Piano.engine().options, NoteOptions::piano());
        assert_eq!(Instrument::Guitar.engine().options, NoteOptions::default());
    }

    #[test]
    fn notes_serialize_in_camel_case() {
        let note = RecordedNote {
            start: 0.5,
            end: 1.0,
            pitch: 40,
            velocity: 90,
        };
        assert_eq!(
            serde_json::to_value(Transcribed { notes: vec![note] }).unwrap(),
            serde_json::json!({ "notes": [{ "start": 0.5, "end": 1.0, "pitch": 40, "velocity": 90 }] })
        );
    }

    #[test]
    fn rejects_empty_and_invalid_takes() {
        let empty = take(&[], 48_000).unwrap_err();
        assert_eq!(
            (empty.kind, empty.message.as_str()),
            (ErrorKind::Audio, "The recording is empty.")
        );
        assert!(
            take(&[0.0, f32::NAN], 48_000)
                .unwrap_err()
                .message
                .contains("invalid")
        );
        assert!(take(&[0.0, f32::INFINITY], 48_000).is_err());
        assert!(take(&[0.0; 10], 0).is_err());
        assert!(take(&[0.0; 10], 1_000_000).is_err());
    }

    #[test]
    fn rejects_takes_over_ten_minutes() {
        let limit = 48_000 * 600;
        assert!(check_duration(limit, 48_000).is_ok());
        let error = check_duration(limit + 1, 48_000).unwrap_err();
        assert_eq!(error.kind, ErrorKind::Audio);
        assert!(error.message.contains("10 minutes"));
    }

    #[test]
    fn accepts_a_valid_take() {
        assert!(take(&[0.0, 0.5, -0.5], 44_100).unwrap().is_empty());
    }

    #[test]
    fn decodes_little_endian_floats() {
        let body: Vec<u8> = [0.25f32, -1.0]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        assert_eq!(decode_samples(&body).unwrap(), [0.25, -1.0]);
        assert!(decode_samples(&[0, 0, 0]).is_err());
    }

    #[test]
    fn a_new_run_stops_the_old_one_and_cancel_stops_the_current() {
        let run = RecordingRun::default();
        let first = run.start();
        let second = run.start();
        assert!(first.load(Ordering::Relaxed));
        assert!(!second.load(Ordering::Relaxed));
        // The old run finishing does not clear the new run's switch.
        run.finish(&first);
        run.cancel();
        assert!(second.load(Ordering::Relaxed));
        run.finish(&second);
        run.cancel();
    }
}
