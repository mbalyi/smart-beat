//! Basic Pitch note creation, ported to Rust.
//!
//! Ported from Spotify's Basic Pitch (https://github.com/spotify/basic-pitch, Apache-2.0,
//! commit fa5997af0a8210982619003269994a1be25eddf3): `basic_pitch/note_creation.py`
//! (`output_to_notes_polyphonic`, `get_infered_onsets`, `constrain_frequency`,
//! `model_frames_to_time`) and `basic_pitch/constants.py`. Copyright 2022 Spotify AB.
//! Licensed under the Apache License, Version 2.0: see `models/basic-pitch/LICENSE` and
//! `NOTICE`. Changes from upstream:
//!
//! - Pitch bends are not estimated. A note keeps the pitch of its onset.
//! - `max_pitch` includes its own key. Upstream's `max_freq` cuts the key it names.
//! - Inferred onsets are skipped when the frames never rise. Upstream divides by zero there
//!   and loses every onset.
//! - Candidate cells for the melodia pass are sorted once instead of searching the whole
//!   matrix for each note. The notes are the same.

use super::RecordedNote;

/// MIDI pitch of the lowest model bin (A0).
pub const MIDI_OFFSET: u8 = 21;
/// Pitch bins in the model output (the 88 piano keys).
pub const N_BINS: usize = 88;
/// Samples between two model frames.
pub const FFT_HOP: usize = 256;
/// The rate the model works at.
pub const SAMPLE_RATE: u32 = 22_050;
/// Frames in the output of one audio window.
pub const FRAMES_PER_WINDOW: usize = 172;
/// Samples in one audio window.
pub const WINDOW_SAMPLES: usize = SAMPLE_RATE as usize * 2 - FFT_HOP;

const MAX_BIN: usize = N_BINS - 1;
/// Frames of silence that end a note.
const ENERGY_TOLERANCE: usize = 11;
/// Upstream's empirical shift between frame times and the audio, in seconds.
const ALIGNMENT_OFFSET: f64 = 0.0018;

/// A row-major matrix of model activations: one row per frame, one column per pitch bin.
#[derive(Debug, Clone, PartialEq)]
pub struct Matrix {
    pub rows: usize,
    pub cols: usize,
    pub data: Vec<f32>,
}
impl Matrix {
    pub fn zeros(rows: usize, cols: usize) -> Self {
        Self {
            rows,
            cols,
            data: vec![0.0; rows * cols],
        }
    }
    pub fn from_rows(rows: usize, cols: usize, data: Vec<f32>) -> Self {
        assert_eq!(rows * cols, data.len(), "matrix size");
        Self { rows, cols, data }
    }
    fn at(&self, row: usize, col: usize) -> f32 {
        self.data[row * self.cols + col]
    }
    fn set(&mut self, row: usize, col: usize, value: f32) {
        self.data[row * self.cols + col] = value;
    }
}

/// How the model output becomes notes. `Default` is Basic Pitch's own defaults.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NoteOptions {
    /// Smallest onset activation that starts a note.
    pub onset_threshold: f32,
    /// Smallest frame activation that keeps a note sounding.
    pub frame_threshold: f32,
    /// Notes this long or shorter are dropped, in milliseconds.
    pub min_note_ms: f64,
    /// Add onsets where the frame activation jumps.
    pub infer_onsets: bool,
    /// Find notes that have no onset peak, from the frames alone.
    pub melodia: bool,
    /// Lowest and highest MIDI pitch to keep. `None` keeps everything the model hears.
    ///
    /// A guitar in standard tuning spans E2 (40) to about E6 (88), and a range of E1 (28) to
    /// E7 (100) leaves room for lower tunings and harmonics. Upstream sets no limit, and so
    /// does the default here: the limit only matters for out-of-range model noise, and the
    /// caller can decide that with real recordings.
    pub min_pitch: Option<u8>,
    pub max_pitch: Option<u8>,
}
impl Default for NoteOptions {
    fn default() -> Self {
        Self {
            onset_threshold: 0.5,
            frame_threshold: 0.3,
            min_note_ms: 127.7,
            infer_onsets: true,
            melodia: true,
            min_pitch: None,
            max_pitch: None,
        }
    }
}
impl NoteOptions {
    /// The shortest note in frames, as upstream rounds it.
    fn min_note_frames(&self) -> usize {
        (self.min_note_ms / 1000.0 * f64::from(SAMPLE_RATE) / FFT_HOP as f64)
            .round()
            .max(0.0) as usize
    }
}

/// A note in frames, before it gets seconds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameNote {
    pub start: usize,
    pub end: usize,
    pub pitch: u8,
    /// Mean frame activation over the note, 0 to 1.
    pub amplitude: f32,
}

/// Zeroes bins outside the pitch limits.
fn constrain_pitch(onsets: &mut Matrix, frames: &mut Matrix, options: &NoteOptions) {
    let low = options
        .min_pitch
        .map_or(0, |p| usize::from(p.saturating_sub(MIDI_OFFSET)));
    let high = options.max_pitch.map_or(N_BINS, |p| {
        (usize::from(p.saturating_sub(MIDI_OFFSET)) + 1).min(N_BINS)
    });
    for matrix in [onsets, frames] {
        for row in 0..matrix.rows {
            for col in (0..low.min(N_BINS)).chain(high..N_BINS) {
                matrix.set(row, col, 0.0);
            }
        }
    }
}

/// The larger of the onsets and the frame activation's rise over the last one and two frames,
/// the rise scaled to the strongest onset.
fn inferred_onsets(onsets: &Matrix, frames: &Matrix) -> Matrix {
    let (rows, cols) = (frames.rows, frames.cols);
    let mut rise = Matrix::zeros(rows, cols);
    let mut top = 0.0f32;
    for row in 2..rows {
        for col in 0..cols {
            let now = frames.at(row, col);
            let one = now - frames.at(row - 1, col);
            let two = now - frames.at(row - 2, col);
            let value = one.min(two).max(0.0);
            rise.set(row, col, value);
            top = top.max(value);
        }
    }
    let strongest = onsets.data.iter().copied().fold(0.0f32, f32::max);
    let mut merged = onsets.clone();
    if top > 0.0 {
        for (slot, &value) in merged.data.iter_mut().zip(&rise.data) {
            *slot = slot.max(strongest * value / top);
        }
    }
    merged
}

/// Frame notes from the model's frame and onset activations (`output_to_notes_polyphonic`).
pub fn frame_notes(frames: &Matrix, onsets: &Matrix, options: &NoteOptions) -> Vec<FrameNote> {
    assert_eq!((frames.rows, frames.cols), (onsets.rows, onsets.cols));
    assert_eq!(frames.cols, N_BINS);
    let n_frames = frames.rows;
    let (mut onsets, mut frames) = (onsets.clone(), frames.clone());
    constrain_pitch(&mut onsets, &mut frames, options);
    if options.infer_onsets {
        onsets = inferred_onsets(&onsets, &frames);
    }
    let min_len = options.min_note_frames();
    let frame_threshold = options.frame_threshold;

    // Onset peaks: strictly above both neighbours in time. Newest first, and highest bin
    // first within a frame, as upstream orders them.
    let mut peaks = Vec::new();
    for row in 1..n_frames.saturating_sub(1) {
        for col in 0..N_BINS {
            let value = onsets.at(row, col);
            if value >= options.onset_threshold
                && value > onsets.at(row - 1, col)
                && value > onsets.at(row + 1, col)
            {
                peaks.push((row, col));
            }
        }
    }
    peaks.reverse();

    let mut remaining = frames.clone();
    let mut notes = Vec::new();
    for (start, col) in peaks {
        if start >= n_frames - 1 {
            continue;
        }
        // Follow the bin until it stays below the threshold for `ENERGY_TOLERANCE` frames.
        let mut i = start + 1;
        let mut quiet = 0;
        while i < n_frames - 1 && quiet < ENERGY_TOLERANCE {
            if remaining.at(i, col) < frame_threshold {
                quiet += 1;
            } else {
                quiet = 0;
            }
            i += 1;
        }
        i -= quiet;
        if i - start <= min_len {
            continue;
        }
        for row in start..i {
            clear_around(&mut remaining, row, col);
        }
        notes.push(FrameNote {
            start,
            end: i,
            pitch: col as u8 + MIDI_OFFSET,
            amplitude: mean(&frames, start, i, col),
        });
    }

    if options.melodia {
        // Strongest leftover activation first. Ties go to the lowest row and column, like
        // `numpy.argmax`. Cells only ever drop to zero, so a stale entry is easy to spot.
        let mut cells: Vec<(f32, usize)> = remaining
            .data
            .iter()
            .enumerate()
            .filter(|&(_, &value)| value > frame_threshold)
            .map(|(index, &value)| (value, index))
            .collect();
        cells.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        for (_, index) in cells {
            let (middle, col) = (index / N_BINS, index % N_BINS);
            if remaining.at(middle, col) <= frame_threshold {
                continue;
            }
            remaining.set(middle, col, 0.0);

            let mut i = middle + 1;
            let mut quiet = 0;
            while i < n_frames - 1 && quiet < ENERGY_TOLERANCE {
                if remaining.at(i, col) < frame_threshold {
                    quiet += 1;
                } else {
                    quiet = 0;
                }
                clear_around(&mut remaining, i, col);
                i += 1;
            }
            let end = i - 1 - quiet;

            let mut i = middle.wrapping_sub(1);
            let mut quiet = 0;
            while i > 0 && i < n_frames && quiet < ENERGY_TOLERANCE {
                if remaining.at(i, col) < frame_threshold {
                    quiet += 1;
                } else {
                    quiet = 0;
                }
                clear_around(&mut remaining, i, col);
                i -= 1;
            }
            let start = i.wrapping_add(1 + quiet);

            if start > end || end - start <= min_len {
                continue;
            }
            notes.push(FrameNote {
                start,
                end,
                pitch: col as u8 + MIDI_OFFSET,
                amplitude: mean(&frames, start, end, col),
            });
        }
    }
    notes
}

/// Zeroes a bin and its two neighbours at one frame.
fn clear_around(matrix: &mut Matrix, row: usize, col: usize) {
    matrix.set(row, col, 0.0);
    if col < MAX_BIN {
        matrix.set(row, col + 1, 0.0);
    }
    if col > 0 {
        matrix.set(row, col - 1, 0.0);
    }
}

fn mean(matrix: &Matrix, start: usize, end: usize, col: usize) -> f32 {
    let sum: f32 = (start..end).map(|row| matrix.at(row, col)).sum();
    sum / (end - start) as f32
}

/// Seconds at the start of each model frame, after upstream's per-window drift correction
/// (`model_frames_to_time`). Each window of output is a little shorter than its frame count
/// says, so the time runs ahead by a small step per window.
pub fn frame_time(frame: usize) -> f64 {
    let hop = FFT_HOP as f64 / f64::from(SAMPLE_RATE);
    let step = hop * (FRAMES_PER_WINDOW as f64 - WINDOW_SAMPLES as f64 / FFT_HOP as f64)
        + ALIGNMENT_OFFSET;
    frame as f64 * hop - step * (frame / FRAMES_PER_WINDOW) as f64
}

/// Notes in seconds, sorted by start time and then pitch. Velocity is the mean frame
/// activation scaled to 1 to 127.
pub fn recorded_notes(
    frames: &Matrix,
    onsets: &Matrix,
    options: &NoteOptions,
) -> Vec<RecordedNote> {
    let mut notes: Vec<RecordedNote> = frame_notes(frames, onsets, options)
        .into_iter()
        .map(|note| RecordedNote {
            start: frame_time(note.start),
            end: frame_time(note.end),
            pitch: note.pitch,
            velocity: (127.0 * note.amplitude).round().clamp(1.0, 127.0) as u8,
        })
        .collect();
    notes.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.pitch.cmp(&b.pitch)));
    notes
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Activations from `(bin, first frame, last frame, value)` blocks.
    fn matrix(rows: usize, blocks: &[(usize, usize, usize, f32)]) -> Matrix {
        let mut m = Matrix::zeros(rows, N_BINS);
        for &(col, from, to, value) in blocks {
            for row in from..=to {
                m.set(row, col, value);
            }
        }
        m
    }
    fn plain() -> NoteOptions {
        NoteOptions {
            infer_onsets: false,
            ..NoteOptions::default()
        }
    }

    #[test]
    fn defaults_match_basic_pitch() {
        let options = NoteOptions::default();
        assert_eq!(options.onset_threshold, 0.5);
        assert_eq!(options.frame_threshold, 0.3);
        assert_eq!(options.min_note_frames(), 11);
        assert!(options.melodia && options.infer_onsets);
        assert_eq!((options.min_pitch, options.max_pitch), (None, None));
    }

    #[test]
    fn an_onset_with_sustained_frames_is_one_note() {
        let frames = matrix(100, &[(19, 10, 39, 0.8)]);
        let onsets = matrix(100, &[(19, 10, 10, 0.9)]);
        let notes = frame_notes(&frames, &onsets, &plain());
        assert_eq!(notes.len(), 1);
        let note = notes[0];
        assert_eq!((note.start, note.pitch), (10, 40));
        // Ends after the quiet tolerance runs out, then steps back to the last loud frame.
        assert_eq!(note.end, 40);
        assert!((note.amplitude - 0.8).abs() < 1e-6);
    }

    #[test]
    fn a_short_note_is_dropped() {
        // Ten frames long: not above the 11 frame minimum.
        let frames = matrix(100, &[(19, 10, 20, 0.8)]);
        let onsets = matrix(100, &[(19, 10, 10, 0.9)]);
        assert!(frame_notes(&frames, &onsets, &plain()).is_empty());
    }

    #[test]
    fn a_weak_onset_is_not_a_note_but_melodia_finds_the_frames() {
        let frames = matrix(100, &[(19, 10, 49, 0.6)]);
        let onsets = matrix(100, &[(19, 10, 10, 0.2)]);
        let without = NoteOptions {
            melodia: false,
            ..plain()
        };
        assert!(frame_notes(&frames, &onsets, &without).is_empty());
        let notes = frame_notes(&frames, &onsets, &plain());
        assert_eq!(notes.len(), 1);
        assert_eq!((notes[0].start, notes[0].end, notes[0].pitch), (10, 49, 40));
    }

    #[test]
    fn two_onsets_on_one_bin_make_two_notes() {
        let frames = matrix(120, &[(19, 10, 39, 0.8), (19, 42, 79, 0.8)]);
        let onsets = matrix(120, &[(19, 10, 10, 0.9), (19, 42, 42, 0.9)]);
        let mut notes = frame_notes(&frames, &onsets, &plain());
        notes.sort_by_key(|n| n.start);
        // The second onset is the later one, so it claims its frames first.
        assert_eq!(notes.len(), 2);
        assert_eq!((notes[0].start, notes[0].pitch), (10, 40));
        assert_eq!((notes[1].start, notes[1].pitch), (42, 40));
    }

    #[test]
    fn a_chord_gives_one_note_per_pitch() {
        let frames = matrix(
            100,
            &[(19, 10, 49, 0.8), (23, 10, 49, 0.7), (26, 10, 49, 0.6)],
        );
        let onsets = matrix(
            100,
            &[(19, 10, 10, 0.9), (23, 10, 10, 0.8), (26, 10, 10, 0.7)],
        );
        let notes = frame_notes(&frames, &onsets, &plain());
        let mut pitches: Vec<u8> = notes.iter().map(|n| n.pitch).collect();
        pitches.sort_unstable();
        assert_eq!(pitches, [40, 44, 47]);
    }

    #[test]
    fn a_neighbouring_bin_does_not_become_a_second_note() {
        // Leakage one semitone up is cleared with the note, so melodia does not find it.
        let frames = matrix(100, &[(19, 10, 49, 0.8), (20, 10, 49, 0.5)]);
        let onsets = matrix(100, &[(19, 10, 10, 0.9)]);
        let notes = frame_notes(&frames, &onsets, &plain());
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].pitch, 40);
    }

    #[test]
    fn a_gap_inside_the_tolerance_keeps_the_note_going() {
        let mut frames = matrix(100, &[(19, 10, 60, 0.8)]);
        for row in 30..38 {
            frames.set(row, 19, 0.0);
        }
        let onsets = matrix(100, &[(19, 10, 10, 0.9)]);
        let notes = frame_notes(&frames, &onsets, &plain());
        assert_eq!(notes.len(), 1);
        assert_eq!((notes[0].start, notes[0].end), (10, 61));
    }

    #[test]
    fn an_inferred_onset_starts_a_note_when_the_model_gives_none() {
        // The frame activation jumps at frame 20 and the onset matrix is quiet there.
        let frames = matrix(100, &[(19, 20, 59, 0.9), (30, 5, 6, 0.1)]);
        let onsets = matrix(100, &[(30, 5, 5, 0.6)]);
        let notes = frame_notes(&frames, &onsets, &NoteOptions::default());
        assert!(notes.iter().any(|n| n.pitch == 40 && n.start == 20));
        // Without inference and melodia, the quiet onset matrix gives no note.
        let without = NoteOptions {
            infer_onsets: false,
            melodia: false,
            ..NoteOptions::default()
        };
        assert!(frame_notes(&frames, &onsets, &without).is_empty());
    }

    #[test]
    fn silence_gives_no_notes_and_no_division_by_zero() {
        let silent = Matrix::zeros(50, N_BINS);
        assert!(frame_notes(&silent, &silent, &NoteOptions::default()).is_empty());
        assert!(
            frame_notes(
                &Matrix::zeros(0, N_BINS),
                &Matrix::zeros(0, N_BINS),
                &NoteOptions::default()
            )
            .is_empty()
        );
    }

    #[test]
    fn pitch_limits_drop_notes_outside_them() {
        let frames = matrix(100, &[(19, 10, 49, 0.8), (60, 10, 49, 0.8)]);
        let onsets = matrix(100, &[(19, 10, 10, 0.9), (60, 10, 10, 0.9)]);
        let limited = NoteOptions {
            min_pitch: Some(40),
            max_pitch: Some(60),
            ..plain()
        };
        let notes = frame_notes(&frames, &onsets, &limited);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].pitch, 40);
        let limited = NoteOptions {
            max_pitch: Some(81),
            ..plain()
        };
        // Bin 60 is pitch 81, and the upper limit includes its own pitch.
        assert_eq!(frame_notes(&frames, &onsets, &limited).len(), 2);
        let limited = NoteOptions {
            max_pitch: Some(80),
            ..plain()
        };
        assert_eq!(frame_notes(&frames, &onsets, &limited).len(), 1);
    }

    #[test]
    fn frame_time_runs_at_the_hop_and_corrects_each_window() {
        assert_eq!(frame_time(0), 0.0);
        let hop = 256.0 / 22_050.0;
        assert!((frame_time(100) - 100.0 * hop).abs() < 1e-12);
        // One window later the time is behind the plain hop by about 10 ms.
        let drift = 172.0 * hop - frame_time(172);
        assert!((drift - 0.010_35).abs() < 0.000_1, "{drift}");
    }

    #[test]
    fn recorded_notes_are_sorted_and_scaled() {
        let frames = matrix(200, &[(19, 100, 149, 1.0), (23, 10, 59, 0.5)]);
        let onsets = matrix(200, &[(19, 100, 100, 0.9), (23, 10, 10, 0.9)]);
        let notes = recorded_notes(&frames, &onsets, &plain());
        assert_eq!(notes.len(), 2);
        assert_eq!((notes[0].pitch, notes[0].velocity), (44, 64));
        assert_eq!((notes[1].pitch, notes[1].velocity), (40, 127));
        assert!(notes[0].start < notes[1].start && notes[0].end > notes[0].start);
    }
}
