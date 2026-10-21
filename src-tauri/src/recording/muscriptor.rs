//! MuScriptor (issue #150) as a `Transcriber`: the downloaded GGUF model runs on this computer
//! through muscriptor.cpp (`muscriptor_ffi.rs`). The model stays loaded between runs, since
//! loading takes seconds. Both Record to tab (AI mode) and Import from Audio use it.

use super::muscriptor_ffi::{Failure, Model, Note};
use super::muscriptor_model::{self as files, Size};
use super::{Instrument, RecordedNote, Transcriber, error, resample};
use crate::error::CommandError;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The model's own sample rate.
pub const SAMPLE_RATE: u32 = 16_000;
const STOPPED: &str = "Transcription stopped.";
/// Velocity of every note: MuScriptor predicts none.
const VELOCITY: u8 = 90;

/// The loaded model and its size. One transcription at a time uses it.
static LOADED: Mutex<Option<(Size, Model)>> = Mutex::new(None);

/// Frees the loaded model. The app calls it on exit: ggml's Metal backend asserts at process
/// exit while a model still holds GPU buffers.
pub fn unload() {
    *LOADED.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// The MuScriptor instrument groups a Record to tab instrument limits the model to.
/// 0 and 1 are the pianos, 4 to 6 the guitars, 7 and 8 the basses, 36 the drums.
pub fn groups(instrument: Instrument) -> &'static [i32] {
    match instrument {
        Instrument::Guitar => &[4, 5, 6, 7, 8],
        Instrument::Piano => &[0, 1],
        Instrument::Drums => &[36],
    }
}

/// The group id of an `instrument-ids.json` entry (its position, except drums which is 36).
pub fn group_of(index: usize) -> i32 {
    const DRUMS_INDEX: usize = 34;
    if index == DRUMS_INDEX {
        36
    } else {
        index as i32
    }
}

fn stopped(failure: Failure) -> CommandError {
    match failure {
        Failure::Cancelled => error(STOPPED),
        Failure::Failed(why) => error(format!("MuScriptor could not transcribe this: {why}")),
    }
}

/// Transcribes 16 kHz mono `samples` with the downloaded model of `size`. Refuses until the user
/// accepted the terms and confirmed their rights, and while the model is not downloaded.
pub fn run(
    folder: &Path,
    size: Size,
    samples: &[f32],
    groups: &[i32],
    progress: &mut dyn FnMut(Stage, f32),
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<Note>, CommandError> {
    files::require_terms(folder, size)?;
    if !files::is_installed(folder, size) {
        return Err(error("Download the MuScriptor model first."));
    }
    let mut slot = LOADED.lock().unwrap_or_else(|e| e.into_inner());
    if slot.as_ref().is_none_or(|(loaded, _)| *loaded != size) {
        *slot = None;
        progress(Stage::Loading, 0.0);
        let model = Model::load(&folder.join(size.file()), cancelled).map_err(stopped)?;
        *slot = Some((size, model));
    }
    let (_, model) = slot.as_mut().expect("loaded above");
    progress(Stage::Transcribing, 0.0);
    model
        .transcribe(
            samples,
            groups,
            &mut |fraction| progress(Stage::Transcribing, fraction),
            cancelled,
        )
        .map_err(stopped)
}

/// What the engine is doing, for the progress message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Loading,
    Transcribing,
}

/// Record to tab's AI mode.
pub struct Muscriptor {
    pub folder: PathBuf,
    pub size: Size,
    pub instrument: Instrument,
}
impl Transcriber for Muscriptor {
    fn transcribe(
        &self,
        samples: &[f32],
        sample_rate: u32,
        progress: &mut dyn FnMut(f32),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<RecordedNote>, CommandError> {
        let samples = resample(samples, sample_rate, SAMPLE_RATE);
        let notes = run(
            &self.folder,
            self.size,
            &samples,
            groups(self.instrument),
            // Loading is a few seconds; the bar starts with the transcription.
            &mut |stage, fraction| {
                if stage == Stage::Transcribing {
                    progress(fraction);
                }
            },
            cancelled,
        )?;
        Ok(recorded(&notes, self.instrument))
    }
}

/// Drum hits keep their General MIDI number, as `DrumOnsets` does.
fn recorded(notes: &[Note], instrument: Instrument) -> Vec<RecordedNote> {
    let mut out: Vec<RecordedNote> = notes
        .iter()
        .filter(|n| (instrument == Instrument::Drums) == n.is_drum)
        .map(|n| RecordedNote {
            start: n.onset,
            end: n.offset.max(n.onset),
            pitch: n.pitch,
            velocity: VELOCITY,
        })
        .collect();
    out.sort_by(|a, b| a.start.total_cmp(&b.start));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(onset: f64, pitch: u8, is_drum: bool) -> Note {
        Note {
            onset,
            offset: onset + 0.5,
            pitch,
            program: if is_drum { 128 } else { 24 },
            is_drum,
        }
    }

    #[test]
    fn an_instrument_limits_the_model_to_its_groups() {
        assert_eq!(groups(Instrument::Piano), [0, 1]);
        assert_eq!(groups(Instrument::Drums), [36]);
        assert!(groups(Instrument::Guitar).contains(&4));
        assert_eq!(group_of(0), 0);
        assert_eq!(group_of(33), 33);
        assert_eq!(group_of(34), 36, "drums");
    }

    #[test]
    fn notes_become_recorded_notes_in_time_order() {
        let notes = [
            note(2.0, 40, false),
            note(1.0, 45, false),
            note(0.5, 38, true),
        ];
        let guitar = recorded(&notes, Instrument::Guitar);
        assert_eq!(guitar.iter().map(|n| n.pitch).collect::<Vec<_>>(), [45, 40]);
        assert!(guitar.iter().all(|n| n.velocity == VELOCITY));
        let drums = recorded(&notes, Instrument::Drums);
        assert_eq!(drums.len(), 1);
        assert_eq!(drums[0].pitch, 38);
    }

    #[test]
    fn it_refuses_before_the_terms_and_before_the_download() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_path_buf();
        let err = run(
            &folder,
            Size::Small,
            &[0.0; 16],
            &[],
            &mut |_, _| {},
            &|| false,
        )
        .unwrap_err();
        assert!(err.message.contains("Accept the MuScriptor terms"));
        std::fs::write(
            folder.join("terms-small.json"),
            format!(
                r#"{{"version":{},"rightsConfirmed":true,"acceptedAt":1}}"#,
                files::TERMS_VERSION
            ),
        )
        .unwrap();
        let err = run(
            &folder,
            Size::Small,
            &[0.0; 16],
            &[],
            &mut |_, _| {},
            &|| false,
        )
        .unwrap_err();
        assert!(err.message.contains("Download the MuScriptor model first"));
    }

    /// Downloads the small model (210 MB) and transcribes the WAV in SMART_BEAT_MUSCRIPTOR_WAV. Run it by
    /// hand: `cargo test --lib real_model -- --ignored --nocapture`.
    #[test]
    #[ignore = "downloads 210 MB"]
    fn real_model_transcribes_a_recording() {
        let dir = std::env::var("SMART_BEAT_MUSCRIPTOR_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("smart-beat-muscriptor-test"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("terms-small.json"),
            format!(
                r#"{{"version":{},"rightsConfirmed":true,"acceptedAt":1}}"#,
                files::TERMS_VERSION
            ),
        )
        .unwrap();
        files::download_size(&dir, "", Size::Small, &mut |_| {}, &|| false).unwrap();
        // The upstream 15 s fixture (16 kHz mono WAV) named by the environment.
        let wav = std::env::var("SMART_BEAT_MUSCRIPTOR_WAV").expect("path of a 16 kHz mono WAV");
        let mut reader = hound::WavReader::open(wav).unwrap();
        let samples: Vec<f32> = match reader.spec().sample_format {
            hound::SampleFormat::Float => reader.samples::<f32>().map(Result::unwrap).collect(),
            hound::SampleFormat::Int => reader
                .samples::<i16>()
                .map(|v| f32::from(v.unwrap()) / 32768.0)
                .collect(),
        };
        let mut last = 0.0;
        let notes = run(
            &dir,
            Size::Small,
            &samples,
            &[],
            &mut |_, f| last = f,
            &|| false,
        )
        .unwrap();
        println!("{} notes, progress {last}: {notes:?}", notes.len());
        unload();
        assert!(last > 0.9);
        assert!(!notes.is_empty(), "the model should hear the plucked notes");
    }
}
