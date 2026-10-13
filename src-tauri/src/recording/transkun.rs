//! Transkun (Yujia Yan, MIT) through `tract`: piano notes from a recording.
//!
//! A port of the inference path of https://github.com/Yujia-Yan/Transkun (`ModelTransformer.py`
//! `TransKun.transcribe` and `transcribeFrames`, `Util.py` `MelSpectrum`, `CRF/NeuralSemiCRFInterval.py`
//! `viterbiBackward`, `Data.py` `resolveOverlapping`), version 2.0 (`pretrained/2.0.pt`). Copyright
//! (c) 2021 Yujia Yan, MIT: see `models/transkun/LICENSE`.
//!
//! The network runs as two ONNX graphs made by `research/record-to-tab/piano/export_transkun.py`:
//! the backbone (mel features to per-pitch context, and the interval scorer's query and key) and
//! the small heads (velocity and edge refinement). Everything around them is here:
//!
//! 1. The audio becomes 44.1 kHz mono, in 16 s segments that advance 8 s.
//! 2. Each segment becomes log mel features with six windows per frame (the model's own
//!    Hann and Gaussian windows, and its mel filter bank, are in `transkun-front.bin`).
//! 3. The backbone gives, for each of 90 events (two pedals and 88 keys), a score for every
//!    interval of frames: the dot product of a query at its end and a key at its start times
//!    its length, plus a score for a one-frame interval. A semi-CRF Viterbi pass picks the
//!    best set of non-overlapping intervals for each key.
//! 4. The heads read the features at both ends of each interval and give the velocity and the
//!    sub-frame position of the edges.
//! 5. Notes cut by a segment edge are joined, overlaps on one key are resolved.

use super::resample::resample;
use super::{RecordedNote, STOPPED, Transcriber, error};
use crate::error::CommandError;
use realfft::RealFftPlanner;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use tract_onnx::prelude::*;

/// The rate the model works at.
const FS: u32 = 44_100;
const HOP: usize = 1024;
const WINDOW: usize = 4096;
const BINS: usize = WINDOW / 2 + 1;
const MELS: usize = 229;
/// The Hann window and five Gaussian windows.
const WINDOWS: usize = 6;
/// Seconds in a segment, and between the starts of two.
const SEGMENT_SECONDS: f64 = 16.0;
const STEP_SECONDS: f64 = 8.0;
/// Frames in a segment: `ceil(16 s * 44100 / 1024) + 1`.
const FRAMES: usize = 691;
/// Events the model tracks: the pedals 64 and 67, then the keys 21 to 108.
const EVENTS: usize = 90;
const FIRST_KEY: i32 = 21;
/// Width of a query or key, and of the context.
const DIM: usize = 256;
/// Rows the heads graph takes at once.
const HEAD_ROWS: usize = 256;
const MEL_EPS: f32 = 1e-5;

/// The MIDI numbers of the 90 events; the pedals are negative as in the model.
fn event_pitch(event: usize) -> i32 {
    match event {
        0 => -64,
        1 => -67,
        key => FIRST_KEY + key as i32 - 2,
    }
}

type Plan = Arc<TypedRunnableModel>;

/// The model: two graphs and the constants of the audio front end.
pub struct Transkun {
    net: Plan,
    heads: Plan,
    /// The six windows of the front end, `[WINDOWS, WINDOW]`.
    windows: Vec<f32>,
    /// The mel filter bank, `[BINS, MELS]`.
    bank: Vec<f32>,
}

/// The model loaded from `dir`, kept for the next take: reading and optimising 55 MB takes a few
/// seconds.
pub fn cached(dir: &Path) -> Result<Arc<Transkun>, CommandError> {
    static LOADED: std::sync::Mutex<Option<(std::path::PathBuf, Arc<Transkun>)>> =
        std::sync::Mutex::new(None);
    let mut slot = LOADED.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((path, model)) = slot.as_ref()
        && path == dir
    {
        return Ok(model.clone());
    }
    let model = Arc::new(Transkun::load(dir)?);
    *slot = Some((dir.to_path_buf(), model.clone()));
    Ok(model)
}

fn load_failed(what: &str, reason: impl std::fmt::Display) -> CommandError {
    error(format!("Could not load the piano model ({what}): {reason}"))
}

impl Transkun {
    /// See [`cached`].
    pub fn cached(dir: &Path) -> Result<Arc<Transkun>, CommandError> {
        cached(dir)
    }

    /// Loads `transkun-net.onnx`, `transkun-heads.onnx` and `transkun-front.bin` from a folder.
    pub fn load(dir: &Path) -> Result<Self, CommandError> {
        let net = tract_onnx::onnx()
            .model_for_path(dir.join("transkun-net.onnx"))
            .and_then(|m| m.with_input_fact(0, f32::fact([1, FRAMES, MELS, WINDOWS]).into()))
            .and_then(|m| m.into_optimized())
            .and_then(|m| m.into_runnable())
            .map_err(|e| load_failed("network", e))?;
        let heads = tract_onnx::onnx()
            .model_for_path(dir.join("transkun-heads.onnx"))
            .and_then(|m| m.with_input_fact(0, f32::fact([HEAD_ROWS, 3 * DIM]).into()))
            .and_then(|m| m.into_optimized())
            .and_then(|m| m.into_runnable())
            .map_err(|e| load_failed("heads", e))?;
        let front = std::fs::read(dir.join("transkun-front.bin"))
            .map_err(|e| load_failed("front end", e))?;
        let floats: Vec<f32> = front
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| f32::from_le_bytes(*b))
            .collect();
        if floats.len() != WINDOWS * WINDOW + BINS * MELS {
            return Err(load_failed("front end", "the file has the wrong size"));
        }
        let (windows, bank) = floats.split_at(WINDOWS * WINDOW);
        Ok(Self {
            net,
            heads,
            windows: windows.to_vec(),
            bank: bank.to_vec(),
        })
    }
}

// --- Audio to log mel features ---------------------------------------------------------------

/// Number of worker threads for the heavy loops.
fn threads() -> usize {
    std::thread::available_parallelism().map_or(2, |n| n.get().clamp(1, 8))
}

/// The frames of one padded segment: `FRAMES` rows of `WINDOW` samples (`makeFrame`).
fn frames_of(segment: &[f32]) -> Vec<f32> {
    let left = WINDOW / 2;
    let mut padded = vec![0.0f32; left + segment.len() + WINDOW];
    padded[left..left + segment.len()].copy_from_slice(segment);
    let mut frames = Vec::with_capacity(FRAMES * WINDOW);
    for t in 0..FRAMES {
        frames.extend_from_slice(&padded[t * HOP..t * HOP + WINDOW]);
    }
    frames
}

/// Log mel features `[FRAMES, MELS, WINDOWS]` of a segment, after the model's gain
/// normalisation (mean and unbiased standard deviation over all the frames' samples).
fn features(model: &Transkun, segment: &[f32]) -> Vec<f32> {
    let frames = frames_of(segment);
    let n = frames.len() as f64;
    let mean = frames.iter().map(|&x| f64::from(x)).sum::<f64>() / n;
    let var = frames
        .iter()
        .map(|&x| (f64::from(x) - mean).powi(2))
        .sum::<f64>()
        / (n - 1.0);
    let (mean, scale) = (mean as f32, (1.0 / (var.sqrt() + 1e-8)) as f32);

    let mut out = vec![0.0f32; FRAMES * MELS * WINDOWS];
    let next = AtomicUsize::new(0);
    let chunks: Vec<std::sync::Mutex<&mut [f32]>> = out
        .chunks_mut(MELS * WINDOWS)
        .map(std::sync::Mutex::new)
        .collect();
    let log_eps = MEL_EPS.ln();
    std::thread::scope(|scope| {
        for _ in 0..threads() {
            scope.spawn(|| {
                let fft = RealFftPlanner::<f32>::new().plan_fft_forward(WINDOW);
                let mut input = fft.make_input_vec();
                let mut spectrum = fft.make_output_vec();
                let mut scratch = fft.make_scratch_vec();
                let mut power = vec![0.0f32; BINS];
                // `norm="ortho"`.
                let ortho = 1.0 / (WINDOW as f32).sqrt();
                loop {
                    let t = next.fetch_add(1, Ordering::Relaxed);
                    if t >= FRAMES {
                        break;
                    }
                    let frame = &frames[t * WINDOW..(t + 1) * WINDOW];
                    let mut row = chunks[t].lock().unwrap_or_else(|e| e.into_inner());
                    for w in 0..WINDOWS {
                        let window = &model.windows[w * WINDOW..(w + 1) * WINDOW];
                        for i in 0..WINDOW {
                            input[i] = (frame[i] - mean) * scale * window[i];
                        }
                        fft.process_with_scratch(&mut input, &mut spectrum, &mut scratch)
                            .expect("fft sizes match");
                        for (p, c) in power.iter_mut().zip(&spectrum) {
                            *p = c.norm_sqr() * ortho * ortho;
                        }
                        for m in 0..MELS {
                            let mut sum = 0.0f32;
                            for (f, &p) in power.iter().enumerate() {
                                sum += p * model.bank[f * MELS + m];
                            }
                            row[m * WINDOWS + w] = ((sum + MEL_EPS).ln() - log_eps) / -log_eps;
                        }
                    }
                }
            });
        }
    });
    out
}

// --- The backbone and the interval search ----------------------------------------------------

/// What the backbone gives for a segment.
struct Context {
    /// `[EVENTS, FRAMES, DIM]`.
    ctx: Vec<f32>,
    q: Vec<f32>,
    k: Vec<f32>,
    /// `[EVENTS, FRAMES]`.
    diag: Vec<f32>,
}

fn run_net(model: &Transkun, features: Vec<f32>) -> Result<Context, CommandError> {
    let failed = |e: TractError| error(format!("Could not detect notes: {e}"));
    let input = tract_ndarray::Array4::from_shape_vec((1, FRAMES, MELS, WINDOWS), features)
        .map_err(|e| error(format!("Could not detect notes: {e}")))?
        .into_tensor();
    let outputs = model.net.run(tvec!(input.into())).map_err(failed)?;
    let read = |index: usize, len: usize| -> Result<Vec<f32>, CommandError> {
        let view = outputs[index]
            .to_plain_array_view::<f32>()
            .map_err(failed)?;
        let values: Vec<f32> = view.iter().copied().collect();
        if values.len() == len {
            Ok(values)
        } else {
            Err(error("The piano model returned an unexpected shape."))
        }
    };
    Ok(Context {
        ctx: read(0, EVENTS * FRAMES * DIM)?,
        q: read(1, EVENTS * FRAMES * DIM)?,
        k: read(2, EVENTS * FRAMES * DIM)?,
        diag: read(3, EVENTS * FRAMES)?,
    })
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut lanes = [0.0f32; 8];
    for (x, y) in a.as_chunks::<8>().0.iter().zip(b.as_chunks::<8>().0) {
        for i in 0..8 {
            lanes[i] += x[i] * y[i];
        }
    }
    lanes.iter().sum()
}

/// `viterbiBackward` for one event: the best set of intervals `(begin, end)` of frames, taking
/// the path from frame `start` on. The score of an interval is `q[end] . k[begin] * (end -
/// begin)`, of a single frame `diag[frame]` when it is above 0, and skipping a frame costs
/// nothing.
fn best_intervals(q: &[f32], k: &[f32], diag: &[f32], start: usize) -> Vec<(usize, usize)> {
    let t = FRAMES;
    let single = |i: usize| diag[i].max(0.0);
    // value[i]: the best score of everything from frame i on. Backpointers: -1 skip, else the
    // distance from begin + 1 to the end of the interval.
    let mut value = vec![0.0f32; t];
    value[t - 1] = single(t - 1);
    let mut pointer = vec![-1i32; t];
    for s in (start.min(t - 2)..t - 1).rev() {
        let ks = &k[s * DIM..(s + 1) * DIM];
        let mut best = value[s + 1];
        let mut choice = -1i32;
        for e in s + 1..t {
            let score = value[e] + dot(&q[e * DIM..(e + 1) * DIM], ks) * (e - s) as f32;
            if score > best {
                best = score;
                choice = (e - s - 1) as i32;
            }
        }
        pointer[s] = choice;
        value[s] = best + single(s);
    }
    let mut path = Vec::new();
    let mut j = start;
    while j < t - 1 {
        if diag[j] > 0.0 {
            path.push((j, j));
        }
        let choice = pointer[j];
        if choice < 0 {
            j += 1;
        } else {
            let end = choice as usize + j + 1;
            path.push((j, end));
            j = end;
        }
    }
    if diag[t - 1] > 0.0 {
        path.push((t - 1, t - 1));
    }
    path
}

/// The intervals of all events of a segment, one thread per few events.
fn all_intervals(context: &Context, starts: &[usize]) -> Vec<Vec<(usize, usize)>> {
    let next = AtomicUsize::new(0);
    let results: Vec<std::sync::Mutex<Vec<(usize, usize)>>> = (0..EVENTS)
        .map(|_| std::sync::Mutex::new(Vec::new()))
        .collect();
    std::thread::scope(|scope| {
        for _ in 0..threads() {
            scope.spawn(|| {
                loop {
                    let event = next.fetch_add(1, Ordering::Relaxed);
                    if event >= EVENTS {
                        break;
                    }
                    let range = event * FRAMES * DIM..(event + 1) * FRAMES * DIM;
                    let path = best_intervals(
                        &context.q[range.clone()],
                        &context.k[range],
                        &context.diag[event * FRAMES..(event + 1) * FRAMES],
                        starts[event],
                    );
                    *results[event].lock().unwrap_or_else(|e| e.into_inner()) = path;
                }
            });
        }
    });
    results
        .into_iter()
        .map(|m| m.into_inner().unwrap_or_else(|e| e.into_inner()))
        .collect()
}

// --- Heads and notes -------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
struct Event {
    start: f64,
    end: f64,
    pitch: i32,
    velocity: u8,
    has_onset: bool,
    has_offset: bool,
}

/// Velocity and edge positions for each interval, and the events of a segment, in seconds from
/// its first frame. Also the frame each event's last interval ended on, for the next segment.
fn segment_events(
    model: &Transkun,
    context: &Context,
    intervals: &[Vec<(usize, usize)>],
) -> Result<(Vec<Event>, Vec<usize>), CommandError> {
    let failed = |e: TractError| error(format!("Could not detect notes: {e}"));
    let rows: Vec<(usize, usize, usize)> = intervals
        .iter()
        .enumerate()
        .flat_map(|(event, list)| list.iter().map(move |&(a, b)| (event, a, b)))
        .collect();
    let mut velocity = Vec::with_capacity(rows.len());
    let mut offsets: Vec<[f32; 4]> = Vec::with_capacity(rows.len());
    for chunk in rows.chunks(HEAD_ROWS) {
        let mut input = vec![0.0f32; HEAD_ROWS * 3 * DIM];
        for (i, &(event, a, b)) in chunk.iter().enumerate() {
            let at = |frame: usize| &context.ctx[(event * FRAMES + frame) * DIM..][..DIM];
            let (ca, cb) = (at(a), at(b));
            let row = &mut input[i * 3 * DIM..(i + 1) * 3 * DIM];
            row[..DIM].copy_from_slice(ca);
            row[DIM..2 * DIM].copy_from_slice(cb);
            for d in 0..DIM {
                row[2 * DIM + d] = ca[d] * cb[d];
            }
        }
        let tensor = tract_ndarray::Array2::from_shape_vec((HEAD_ROWS, 3 * DIM), input)
            .map_err(|e| error(format!("Could not detect notes: {e}")))?
            .into_tensor();
        let outputs = model.heads.run(tvec!(tensor.into())).map_err(failed)?;
        let logits = outputs[0].to_plain_array_view::<f32>().map_err(failed)?;
        let logits: Vec<f32> = logits.iter().copied().collect();
        let edges = outputs[1].to_plain_array_view::<f32>().map_err(failed)?;
        let edges: Vec<f32> = edges.iter().copied().collect();
        for i in 0..chunk.len() {
            let row = &logits[i * 128..(i + 1) * 128];
            let mut best = 0;
            for (v, &l) in row.iter().enumerate() {
                if l > row[best] {
                    best = v;
                }
            }
            velocity.push(best as u8);
            offsets.push([
                edges[i * 4],
                edges[i * 4 + 1],
                edges[i * 4 + 2],
                edges[i * 4 + 3],
            ]);
        }
    }

    let frame_seconds = HOP as f64 / f64::from(FS);
    let last_frame = (SEGMENT_SECONDS * f64::from(FS) / HOP as f64).round() as usize;
    let mut events = Vec::with_capacity(rows.len());
    let mut last_end = vec![0.0f64; EVENTS];
    let mut last_edge = vec![0usize; EVENTS];
    for (i, &(event, a, b)) in rows.iter().enumerate() {
        let off = offsets[i];
        let mut start = (a as f64 + f64::from(off[0])) * frame_seconds;
        let mut end = (b as f64 + f64::from(off[1])) * frame_seconds;
        let has_onset = a > 0 || off[2] > 0.0;
        let has_offset = b < last_frame || off[3] > 0.0;
        start = start.max(last_end[event]);
        end = end.max(start + 1e-8);
        last_end[event] = end;
        if has_offset {
            last_edge[event] = b;
        }
        events.push(Event {
            start,
            end,
            pitch: event_pitch(event),
            velocity: velocity[i],
            has_onset,
            has_offset,
        });
    }
    events.sort_by(|x, y| {
        x.start
            .total_cmp(&y.start)
            .then(x.end.total_cmp(&y.end))
            .then(x.pitch.cmp(&y.pitch))
    });
    Ok((events, last_edge))
}

/// `resolveOverlapping`: a note ends where the next one on the same key starts, and notes with
/// no length go.
fn resolve_overlapping(mut events: Vec<Event>) -> Vec<Event> {
    let order = |x: &Event, y: &Event| {
        x.start
            .total_cmp(&y.start)
            .then(x.end.total_cmp(&y.end))
            .then(x.pitch.cmp(&y.pitch))
    };
    events.sort_by(order);
    let mut last: HashMap<i32, usize> = HashMap::new();
    for i in 0..events.len() {
        let pitch = events[i].pitch;
        if let Some(&before) = last.get(&pitch)
            && events[before].end > events[i].start
        {
            events[before].end = events[i].start;
        }
        last.insert(pitch, i);
    }
    events.sort_by(order);
    events.retain(|e| e.start < e.end);
    events
}

// --- The whole recording ---------------------------------------------------------------------

impl Transcriber for Transkun {
    fn transcribe(
        &self,
        samples: &[f32],
        sample_rate: u32,
        progress: &mut dyn FnMut(f32),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<RecordedNote>, CommandError> {
        let audio = resample(samples, sample_rate, FS);
        let pad = ((SEGMENT_SECONDS - STEP_SECONDS) * f64::from(FS)).ceil() as usize;
        let mut x = vec![0.0f32; pad];
        x.extend_from_slice(&audio);
        x.extend(std::iter::repeat_n(0.0, pad));
        let step = (STEP_SECONDS * f64::from(FS) / HOP as f64).ceil() as usize * HOP;
        let segment = (SEGMENT_SECONDS * f64::from(FS)).ceil() as usize;
        let start_frame =
            (((SEGMENT_SECONDS - STEP_SECONDS) * f64::from(FS)) / HOP as f64).floor() as usize;
        let count = x.len().div_ceil(step);

        let mut starts = vec![start_frame; EVENTS];
        let mut by_pitch: HashMap<i32, Vec<Event>> = HashMap::new();
        for (index, i) in (0..x.len()).step_by(step).enumerate() {
            if cancelled() {
                return Err(error(STOPPED));
            }
            let j = (i + segment).min(x.len());
            let begin = i as f64 / f64::from(FS) - (SEGMENT_SECONDS - STEP_SECONDS);
            let mut slice = x[i..j].to_vec();
            slice.resize(segment, 0.0);

            let context = run_net(self, features(self, &slice))?;
            if cancelled() {
                return Err(error(STOPPED));
            }
            let intervals = all_intervals(&context, &starts);
            if cancelled() {
                return Err(error(STOPPED));
            }
            let total: usize = intervals.iter().map(Vec::len).sum();
            let (mut events, last_edge) = if total == 0 {
                (Vec::new(), vec![0; EVENTS])
            } else {
                segment_events(self, &context, &intervals)?
            };
            starts = last_edge
                .iter()
                .map(|&k| k.saturating_sub(step / HOP))
                .collect();

            for e in &mut events {
                e.start = (e.start + begin).max(0.0);
                e.end = (e.end + begin).max(e.start);
            }
            for e in events {
                let list = by_pitch.entry(e.pitch).or_default();
                if let Some(previous) = list.last_mut()
                    && e.start < previous.end
                {
                    if e.has_onset {
                        *previous = e;
                    } else {
                        previous.has_offset = e.has_offset;
                        previous.end = e.end.max(previous.end);
                    }
                    continue;
                }
                if e.has_onset {
                    list.push(e);
                }
            }
            progress((index + 1) as f32 / count as f32);
        }
        for list in by_pitch.values_mut() {
            if let Some(last) = list.last_mut() {
                last.has_offset = true;
            }
        }
        let all: Vec<Event> = by_pitch
            .into_values()
            .flatten()
            .filter(|e| e.has_offset)
            .collect();
        Ok(resolve_overlapping(all)
            .into_iter()
            .filter(|e| e.pitch >= FIRST_KEY)
            .map(|e| RecordedNote {
                start: e.start,
                end: e.end,
                pitch: e.pitch as u8,
                velocity: e.velocity.clamp(1, 127),
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_are_two_pedals_then_the_88_keys() {
        assert_eq!(event_pitch(0), -64);
        assert_eq!(event_pitch(1), -67);
        assert_eq!(event_pitch(2), 21);
        assert_eq!(event_pitch(EVENTS - 1), 108);
    }

    fn event(start: f64, end: f64, pitch: i32) -> Event {
        Event {
            start,
            end,
            pitch,
            velocity: 80,
            has_onset: true,
            has_offset: true,
        }
    }

    #[test]
    fn overlaps_on_one_key_are_cut_and_empty_notes_go() {
        let out = resolve_overlapping(vec![
            event(0.0, 2.0, 60),
            event(1.0, 3.0, 60),
            event(0.5, 1.0, 64),
            event(2.0, 2.0, 70),
        ]);
        let spans: Vec<_> = out.iter().map(|e| (e.pitch, e.start, e.end)).collect();
        assert_eq!(spans, vec![(60, 0.0, 1.0), (64, 0.5, 1.0), (60, 1.0, 3.0)]);
    }

    /// Unit vectors on a few frames: an interval scores `q . k * length`.
    fn scores(pairs: &[(usize, usize, f32)], singles: &[(usize, f32)]) -> Vec<(usize, usize)> {
        let mut q = vec![0.0f32; FRAMES * DIM];
        let mut k = vec![0.0f32; FRAMES * DIM];
        let mut diag = vec![-1.0f32; FRAMES];
        for (n, &(begin, end, strength)) in pairs.iter().enumerate() {
            // A different axis per pair, so pairs do not score each other.
            k[begin * DIM + n] = 1.0;
            q[end * DIM + n] = strength;
        }
        for &(frame, value) in singles {
            diag[frame] = value;
        }
        best_intervals(&q, &k, &diag, 0)
    }

    #[test]
    fn viterbi_takes_the_intervals_that_score_and_skips_the_rest() {
        let got = scores(&[(10, 20, 1.0), (30, 40, 1.0)], &[]);
        assert_eq!(got, vec![(10, 20), (30, 40)]);
    }

    #[test]
    fn viterbi_leaves_out_a_negative_interval_and_keeps_single_frames() {
        let got = scores(&[(10, 20, -1.0)], &[(50, 2.0)]);
        assert_eq!(got, vec![(50, 50)]);
    }

    #[test]
    fn viterbi_starts_where_it_is_told_to() {
        let mut q = vec![0.0f32; FRAMES * DIM];
        let mut k = vec![0.0f32; FRAMES * DIM];
        k[10 * DIM] = 1.0;
        q[20 * DIM] = 1.0;
        k[100 * DIM + 1] = 1.0;
        q[110 * DIM + 1] = 1.0;
        let diag = vec![-1.0f32; FRAMES];
        assert_eq!(best_intervals(&q, &k, &diag, 50), vec![(100, 110)]);
        assert_eq!(best_intervals(&q, &k, &diag, 0).len(), 2);
    }
}
