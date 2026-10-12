//! Basic Pitch (Spotify, Apache-2.0) through `tract`. Windowing follows `run_inference`,
//! `window_audio_file` and `unwrap_output` in `basic_pitch/inference.py` of
//! https://github.com/spotify/basic-pitch at commit fa5997af0a8210982619003269994a1be25eddf3.
//! The model is `basic_pitch/saved_models/icassp_2022/nmp.onnx` from the same commit. See
//! `models/basic-pitch/LICENSE` and `NOTICE`.

use super::notes::{
    FFT_HOP, FRAMES_PER_WINDOW, Matrix, N_BINS, NoteOptions, SAMPLE_RATE, WINDOW_SAMPLES,
    recorded_notes,
};
use super::resample::resample;
use super::{RecordedNote, STOPPED, Transcriber, error};
use crate::error::CommandError;
use std::sync::{Arc, OnceLock};
use tract_onnx::prelude::*;

/// The ONNX model, 230 KB.
static MODEL: &[u8] = include_bytes!("../../models/basic-pitch/nmp.onnx");

/// Frames each window shares with its neighbours (`DEFAULT_OVERLAPPING_FRAMES`).
const OVERLAP_FRAMES: usize = 30;
const OVERLAP_SAMPLES: usize = OVERLAP_FRAMES * FFT_HOP;
/// Samples between the starts of two windows.
const HOP_SAMPLES: usize = WINDOW_SAMPLES - OVERLAP_SAMPLES;
/// Frames of a window's output that are kept: the overlap is trimmed evenly from both ends.
const KEPT_FRAMES: usize = FRAMES_PER_WINDOW - OVERLAP_FRAMES;
/// The graph's output nodes for the two activations we use. The third is the contour output.
const NOTE_OUTPUT: &str = "StatefulPartitionedCall:1";
const ONSET_OUTPUT: &str = "StatefulPartitionedCall:2";

/// The signal with half the overlap of silence in front, so the first frames of the take
/// have a full window around them.
pub fn pad_front(audio: &[f32]) -> Vec<f32> {
    let mut padded = vec![0.0; OVERLAP_SAMPLES / 2];
    padded.extend_from_slice(audio);
    padded
}

/// How many windows cover the padded signal.
pub fn window_count(padded_len: usize) -> usize {
    padded_len.div_ceil(HOP_SAMPLES)
}

/// The `index`th window of the padded signal, zero padded at the end.
pub fn window(padded: &[f32], index: usize) -> Vec<f32> {
    let start = (index * HOP_SAMPLES).min(padded.len());
    let end = (start + WINDOW_SAMPLES).min(padded.len());
    let mut window = padded[start..end].to_vec();
    window.resize(WINDOW_SAMPLES, 0.0);
    window
}

/// The rows of one window's output to keep, which drops half the overlap at each end.
pub fn trim_window(output: &[f32], cols: usize) -> &[f32] {
    &output[OVERLAP_FRAMES / 2 * cols..(FRAMES_PER_WINDOW - OVERLAP_FRAMES / 2) * cols]
}

/// Joins the trimmed windows, then drops the frames that belong to the padding at the end
/// (`unwrap_output`). `windows` holds the output of each window, `FRAMES_PER_WINDOW` rows of
/// `cols` values.
pub fn unwrap_windows(windows: &[Vec<f32>], cols: usize, original_len: usize) -> Matrix {
    let mut data = Vec::with_capacity(windows.len() * KEPT_FRAMES * cols);
    for window in windows {
        data.extend_from_slice(trim_window(window, cols));
    }
    let expected = (original_len as f64 / HOP_SAMPLES as f64 * KEPT_FRAMES as f64) as usize;
    let rows = (data.len() / cols).min(expected);
    data.truncate(rows * cols);
    Matrix::from_rows(rows, cols, data)
}

type Plan = Arc<TypedRunnableModel>;
/// The optimized model and the positions of its outputs.
struct Net {
    plan: Plan,
    note: usize,
    onset: usize,
}
fn load_net() -> TractResult<Net> {
    let model = tract_onnx::onnx().model_for_read(&mut &MODEL[..])?;
    let position = |name: &str| -> TractResult<usize> {
        model
            .output_outlets()?
            .iter()
            .position(|outlet| model.node(outlet.node).name == name)
            .ok_or_else(|| TractError::msg(format!("the model has no output {name}")))
    };
    let (note, onset) = (position(NOTE_OUTPUT)?, position(ONSET_OUTPUT)?);
    let plan = model
        .with_input_fact(0, f32::fact([1, WINDOW_SAMPLES, 1]).into())?
        .into_optimized()?
        .into_runnable()?;
    Ok(Net { plan, note, onset })
}
/// Loading and optimizing the model takes a moment, so it happens once.
fn net() -> Result<&'static Net, CommandError> {
    static NET: OnceLock<Result<Net, String>> = OnceLock::new();
    NET.get_or_init(|| load_net().map_err(|e| e.to_string()))
        .as_ref()
        .map_err(|reason| error(format!("Could not load the note detection model: {reason}")))
}

/// Runs one window. Returns the note and onset activations, `FRAMES_PER_WINDOW` rows each.
fn run_window(net: &Net, window: Vec<f32>) -> Result<(Vec<f32>, Vec<f32>), CommandError> {
    let failed = |e: TractError| error(format!("Could not detect notes: {e}"));
    let input = tract_ndarray::Array3::from_shape_vec((1, WINDOW_SAMPLES, 1), window)
        .map_err(|e| error(format!("Could not detect notes: {e}")))?
        .into_tensor();
    let outputs = net.plan.run(tvec!(input.into())).map_err(failed)?;
    let read = |index: usize| -> Result<Vec<f32>, CommandError> {
        let values = outputs[index]
            .to_plain_array_view::<f32>()
            .map_err(failed)?;
        let values: Vec<f32> = values.iter().copied().collect();
        if values.len() != FRAMES_PER_WINDOW * N_BINS {
            return Err(error(
                "The note detection model returned an unexpected shape.",
            ));
        }
        Ok(values)
    };
    Ok((read(net.note)?, read(net.onset)?))
}

/// Spotify's Basic Pitch: polyphonic notes from any single instrument.
#[derive(Debug, Clone, Copy, Default)]
pub struct BasicPitch {
    pub options: NoteOptions,
}

impl BasicPitch {
    /// The note and onset activations for a take at the model's own rate (22,050 Hz mono).
    /// Progress runs from 0 to 1 over the windows.
    pub fn activations(
        audio: &[f32],
        progress: &mut dyn FnMut(f32),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<(Matrix, Matrix), CommandError> {
        let net = net()?;
        let padded = pad_front(audio);
        let count = window_count(padded.len());
        let (mut notes, mut onsets) = (Vec::with_capacity(count), Vec::with_capacity(count));
        for index in 0..count {
            if cancelled() {
                return Err(error(STOPPED));
            }
            let (note, onset) = run_window(net, window(&padded, index))?;
            notes.push(note);
            onsets.push(onset);
            progress((index + 1) as f32 / count as f32);
        }
        Ok((
            unwrap_windows(&notes, N_BINS, audio.len()),
            unwrap_windows(&onsets, N_BINS, audio.len()),
        ))
    }
}

impl Transcriber for BasicPitch {
    fn transcribe(
        &self,
        samples: &[f32],
        sample_rate: u32,
        progress: &mut dyn FnMut(f32),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<RecordedNote>, CommandError> {
        let audio = resample(samples, sample_rate, SAMPLE_RATE);
        if cancelled() {
            return Err(error(STOPPED));
        }
        // The windows take nearly all the time. Leave the last bit of progress for the notes.
        let mut windows = |fraction: f32| progress(fraction * 0.98);
        let (frames, onsets) = Self::activations(&audio, &mut windows, cancelled)?;
        Ok(recorded_notes(&frames, &onsets, &self.options))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_match_basic_pitch() {
        assert_eq!(WINDOW_SAMPLES, 43_844);
        assert_eq!(OVERLAP_SAMPLES, 7_680);
        assert_eq!(HOP_SAMPLES, 36_164);
        assert_eq!(KEPT_FRAMES, 142);
    }

    #[test]
    fn padding_adds_half_the_overlap_in_front() {
        let padded = pad_front(&[1.0, 2.0]);
        assert_eq!(padded.len(), 3_842);
        assert_eq!(&padded[3_840..], &[1.0, 2.0]);
        assert!(padded[..3_840].iter().all(|&s| s == 0.0));
    }

    #[test]
    fn windows_hop_and_pad_the_end() {
        assert_eq!(window_count(1), 1);
        assert_eq!(window_count(HOP_SAMPLES), 1);
        assert_eq!(window_count(HOP_SAMPLES + 1), 2);
        let signal: Vec<f32> = (0..50_000).map(|n| n as f32).collect();
        let first = window(&signal, 0);
        let second = window(&signal, 1);
        assert_eq!(first.len(), WINDOW_SAMPLES);
        assert_eq!(second.len(), WINDOW_SAMPLES);
        assert_eq!(first[0], 0.0);
        assert_eq!(second[0], HOP_SAMPLES as f32);
        // Consecutive windows share the overlap.
        assert_eq!(first[HOP_SAMPLES], second[0]);
        // The second window runs out of signal at 50,000 and pads with silence.
        let valid = 50_000 - HOP_SAMPLES;
        assert_eq!(second[valid - 1], 49_999.0);
        assert!(second[valid..].iter().all(|&s| s == 0.0));
    }

    #[test]
    fn a_window_past_the_end_is_silent() {
        assert!(window(&[1.0; 10], 5).iter().all(|&s| s == 0.0));
    }

    #[test]
    fn trimming_drops_fifteen_frames_in_total_from_each_window() {
        let output: Vec<f32> = (0..FRAMES_PER_WINDOW * 2).map(|n| (n / 2) as f32).collect();
        let kept = trim_window(&output, 2);
        assert_eq!(kept.len(), KEPT_FRAMES * 2);
        assert_eq!(kept[0], 15.0);
        assert_eq!(*kept.last().unwrap(), 156.0);
    }

    #[test]
    fn unwrapping_joins_windows_and_cuts_the_padding() {
        let window = |value: f32| vec![value; FRAMES_PER_WINDOW * 2];
        let windows = [window(1.0), window(2.0), window(3.0)];
        // Two and a half hops of audio: 2.5 * 142 frames.
        let matrix = unwrap_windows(&windows, 2, HOP_SAMPLES * 5 / 2);
        assert_eq!((matrix.rows, matrix.cols), (355, 2));
        assert_eq!(matrix.data[0], 1.0);
        assert_eq!(matrix.data[142 * 2], 2.0);
        assert_eq!(matrix.data[284 * 2], 3.0);
        // Never more than the windows hold.
        assert_eq!(unwrap_windows(&windows, 2, HOP_SAMPLES * 100).rows, 3 * 142);
    }

    #[test]
    fn the_model_runs_on_silence() {
        let net = net().unwrap();
        let (note, onset) = run_window(net, vec![0.0; WINDOW_SAMPLES]).unwrap();
        assert_eq!(note.len(), FRAMES_PER_WINDOW * N_BINS);
        assert!(note.iter().chain(&onset).all(|v| (0.0..=1.0).contains(v)));
        assert!(onset.iter().all(|&v| v < 0.5));
    }

    #[test]
    fn a_stop_request_ends_the_run() {
        let result =
            BasicPitch::default().transcribe(&[0.0; 22_050], 22_050, &mut |_| {}, &|| true);
        assert_eq!(result.unwrap_err().message, STOPPED);
    }

    #[test]
    fn progress_reaches_the_end_in_order() {
        let mut seen = Vec::new();
        BasicPitch::default()
            .transcribe(
                &vec![0.0; 22_050 * 5],
                22_050,
                &mut |f| seen.push(f),
                &|| false,
            )
            .unwrap();
        assert!(seen.len() >= 2);
        assert!(seen.windows(2).all(|pair| pair[0] <= pair[1]));
        assert!(*seen.last().unwrap() <= 1.0);
    }
}
