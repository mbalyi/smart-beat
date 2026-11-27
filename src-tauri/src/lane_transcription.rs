//! "Sheet from an audio lane" (#235): the audio of a lane, one of its clips or a time range of it
//! becomes notes, on this computer. The clips are rendered offline the way the engine plays
//! them (offset, trim, playrate, stretch, reverse, clip and lane pitch) but without the lane's
//! volume, pan, filter, effects and mute: the model should hear the instrument, not the mix
//! settings. The mono result goes through the same engines as Record to tab
//! (`recording::EngineSelection`). Note times are seconds on the audio timeline, so the page
//! can map them to bars with the song's sync points.
use crate::audio::backing::DecodedAudio;
use crate::audio::lanes::voice::{ClipPlan, ClipVoice};
use crate::audio::{AudioState, LaneAudio};
use crate::audio_lanes::{AudioClip, AudioLane};
use crate::error::{CommandError, ErrorKind};
use crate::recording::{EngineSelection, Instrument, RecordedNote};
use crate::transcription::{Running, Start};
use serde::Serialize;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Emitter, Runtime, State};

/// The rate the lane is rendered at. Basic Pitch runs at 22 050 Hz; the other engines resample.
pub const RENDER_RATE: u32 = 22_050;
/// The longest span of a lane that is transcribed at once, in ms.
pub const MAX_SPAN_MS: f64 = 10.0 * 60.0 * 1000.0;
/// Frames rendered per step (the cancel check and the progress report come once per step).
const BLOCK: usize = 1_024;
/// The share of the progress bar that rendering takes; the engine fills the rest.
const RENDER_SHARE: f32 = 0.1;
const STOPPED: &str = "Transcription stopped.";

fn error(message: impl Into<String>) -> CommandError {
    CommandError::new(ErrorKind::Audio, message)
}

/// What is transcribed: a span of the audio timeline and the clips that play in it.
#[derive(Debug, Clone, PartialEq)]
pub struct Span {
    pub start_ms: f64,
    pub end_ms: f64,
    /// The clips that are rendered, in timeline order. Muted clips are not among them.
    pub clip_ids: Vec<String>,
}

/// The span of `lane` the request asks for. A `clip_id` takes exactly that clip, wherever it is.
/// Otherwise the range `start_ms` to `end_ms` (a missing end is the end of the lane's audio, a
/// missing start its start; neither means the whole lane) with every clip that plays in it.
/// Muted clips are skipped.
pub fn resolve_span(
    lane: &AudioLane,
    clip_id: Option<&str>,
    start_ms: Option<f64>,
    end_ms: Option<f64>,
) -> Result<Span, CommandError> {
    if lane.folder {
        return Err(error(
            "A folder has no audio of its own. Choose one of its lanes.",
        ));
    }
    if let Some(id) = clip_id {
        let clip = lane.clips.iter().find(|c| c.id == id).ok_or_else(|| {
            CommandError::new(
                ErrorKind::NotFound,
                "That clip is not in the lane any more.",
            )
        })?;
        if clip.mute {
            return Err(error("That clip is muted. Unmute it to transcribe it."));
        }
        return Ok(Span {
            start_ms: clip.start_ms,
            end_ms: clip.end_ms(),
            clip_ids: vec![clip.id.clone()],
        });
    }
    if lane.clips.is_empty() {
        return Err(error("This lane has no audio."));
    }
    let mut live: Vec<&AudioClip> = lane.clips.iter().filter(|c| !c.mute).collect();
    if live.is_empty() {
        return Err(error(
            "All the clips of this lane are muted. Unmute one to transcribe it.",
        ));
    }
    live.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
    let first = live.iter().map(|c| c.start_ms).fold(f64::MAX, f64::min);
    let last = live.iter().map(|c| c.end_ms()).fold(f64::MIN, f64::max);
    let given = [start_ms, end_ms].into_iter().flatten();
    if given.into_iter().any(|ms| !ms.is_finite() || ms < 0.0) {
        return Err(error("Choose a range inside the song."));
    }
    if start_ms.is_none() && end_ms.is_none() {
        return Ok(Span {
            start_ms: first,
            end_ms: last,
            clip_ids: live.iter().map(|c| c.id.clone()).collect(),
        });
    }
    let (start, end) = (start_ms.unwrap_or(first), end_ms.unwrap_or(last));
    if end <= start {
        return Err(error("Choose a range that ends after it starts."));
    }
    let clip_ids: Vec<String> = live
        .iter()
        .filter(|c| c.start_ms < end && c.end_ms() > start)
        .map(|c| c.id.clone())
        .collect();
    if clip_ids.is_empty() {
        return Err(error("There is no audio in that range."));
    }
    Ok(Span {
        start_ms: start,
        end_ms: end,
        clip_ids,
    })
}

/// Refuses a span over ten minutes. Ten minutes exactly is fine.
pub fn check_span(span: &Span) -> Result<(), CommandError> {
    if span.end_ms - span.start_ms > MAX_SPAN_MS {
        Err(error(
            "Choose up to 10 minutes of the lane at a time. Pick a shorter range or a clip.",
        ))
    } else {
        Ok(())
    }
}

/// The clips of `span` as voices at `RENDER_RATE`. A clip's gain, fades and envelope are left
/// out (a quiet or faded clip is still the same notes); its timing and pitch are kept.
fn voices(audio: &LaneAudio, span: &Span) -> Result<Vec<ClipVoice>, CommandError> {
    let lane = &audio.lane;
    span.clip_ids
        .iter()
        .filter_map(|id| lane.clips.iter().find(|clip| &clip.id == id))
        .map(|clip| {
            let source = &clip.active_take().source_id;
            let decoded: Option<&Arc<DecodedAudio>> = if clip.reversed {
                audio.reversed.get(source)
            } else {
                audio.sources.get(source)
            };
            let decoded = decoded.ok_or_else(|| {
                CommandError::new(
                    ErrorKind::NotFound,
                    "An audio file of this lane is not loaded. Open it again and try once more.",
                )
            })?;
            let mut plan = ClipPlan::from_clip(clip, lane.params.semitones, lane.params.cents);
            plan.gain = 1.0;
            plan.fade_in.0 = 0.0;
            plan.fade_out.0 = 0.0;
            plan.envelope.clear();
            Ok(ClipVoice::new(
                clip.id.clone(),
                plan,
                decoded.clone(),
                RENDER_RATE as f32,
                BLOCK,
            ))
        })
        .collect()
}

/// Renders the span to mono samples at `RENDER_RATE`: the clips summed, left and right
/// averaged, silence where no clip plays. `progress` reports 0 to 1; `cancelled` is checked
/// before every step and stops the render with "Transcription stopped.".
pub fn render_span(
    audio: &LaneAudio,
    span: &Span,
    progress: &mut dyn FnMut(f32),
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<f32>, CommandError> {
    let mut voices = voices(audio, span)?;
    let rate = f64::from(RENDER_RATE);
    let frames = (((span.end_ms - span.start_ms) / 1_000.0 * rate).round() as usize).max(1);
    let from = span.start_ms / 1_000.0;
    let mut mono = Vec::with_capacity(frames);
    let (mut left, mut right) = (vec![0.0f32; BLOCK], vec![0.0f32; BLOCK]);
    let mut times = vec![0.0f64; BLOCK];
    while mono.len() < frames {
        if cancelled() {
            return Err(error(STOPPED));
        }
        let done = mono.len();
        let n = BLOCK.min(frames - done);
        for (i, time) in times[..n].iter_mut().enumerate() {
            *time = from + (done + i) as f64 / rate;
        }
        left[..n].fill(0.0);
        right[..n].fill(0.0);
        for voice in &mut voices {
            voice.render(&times[..n], (&mut left[..n], &mut right[..n]));
        }
        mono.extend((0..n).map(|i| (left[i] + right[i]) * 0.5));
        progress(mono.len() as f32 / frames as f32);
    }
    Ok(mono)
}

/// Notes found in a render, moved from "seconds into the span" to seconds on the audio timeline.
pub fn map_notes(notes: Vec<RecordedNote>, span_start_ms: f64) -> Vec<RecordedNote> {
    let shift = span_start_ms / 1_000.0;
    notes
        .into_iter()
        .map(|note| RecordedNote {
            start: note.start + shift,
            end: note.end + shift,
            ..note
        })
        .collect()
}

/// The instrument the page asks for. Bass uses the guitar engine settings, as Record to tab does.
fn parse_instrument(value: &str) -> Result<Instrument, CommandError> {
    match value.trim().to_ascii_lowercase().as_str() {
        "guitar" | "bass" => Ok(Instrument::Guitar),
        "piano" => Ok(Instrument::Piano),
        "drums" => Ok(Instrument::Drums),
        _ => Err(error("Choose guitar, bass, piano or drums.")),
    }
}

/// What `transcribe_lane` returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneTranscription {
    /// Start and end in seconds on the audio timeline.
    pub notes: Vec<RecordedNote>,
    /// The span that was transcribed, in ms on the audio timeline.
    pub start_ms: f64,
    pub end_ms: f64,
    /// The clips that were heard.
    pub clip_ids: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    operation_id: &'a str,
    fraction: f32,
}

/// Transcribes an audio lane, a clip of it (`clipId`) or a range (`startMs` to `endMs`, in ms on
/// the audio timeline; none means the whole lane). `instrument` is `guitar`, `bass`, `piano` or
/// `drums`; `engine` and `modelSize` are the values Record to tab sends. The run is stopped
/// with `cancel_transcription(operationId)`. Emits `lane-transcription-progress`
/// (`{ operationId, fraction }`).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn transcribe_lane<R: Runtime>(
    app: AppHandle<R>,
    audio: State<'_, AudioState>,
    running: State<'_, Running>,
    operation_id: String,
    lane_id: String,
    clip_id: Option<String>,
    start_ms: Option<f64>,
    end_ms: Option<f64>,
    instrument: String,
    engine: Option<String>,
    model_size: Option<String>,
) -> Result<LaneTranscription, CommandError> {
    let instrument = parse_instrument(&instrument)?;
    let lane = audio.lane_for_transcription(&lane_id)?;
    let span = resolve_span(&lane.lane, clip_id.as_deref(), start_ms, end_ms)?;
    check_span(&span)?;
    let selection =
        EngineSelection::resolve(&app, engine.as_deref(), model_size.as_deref(), instrument)?;
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let abort = Box::new(move || flag.store(true, Ordering::Relaxed));
    let started = if selection.uses_muscriptor() {
        running.start_exclusive(&operation_id, abort)
    } else if running.start(&operation_id, abort) {
        Start::Started
    } else {
        Start::Cancelled
    };
    match started {
        Start::Started => {}
        Start::Cancelled => return Err(error(STOPPED)),
        Start::Busy => {
            return Err(error(
                "Another transcription is running. Wait for it to finish or stop it first.",
            ));
        }
    }
    let worker = {
        let (id, stop) = (operation_id.clone(), stop.clone());
        tauri::async_runtime::spawn_blocking(move || {
            let mut last = -1.0f32;
            let mut emit = |fraction: f32| {
                // About one event per percent is enough for a progress bar.
                if fraction - last >= 0.01 || fraction >= 1.0 {
                    last = fraction;
                    let _ = app.emit(
                        "lane-transcription-progress",
                        Progress {
                            operation_id: &id,
                            fraction,
                        },
                    );
                }
            };
            let cancelled = || stop.load(Ordering::Relaxed);
            let samples = render_span(&lane, &span, &mut |f| emit(f * RENDER_SHARE), &cancelled)?;
            let notes = selection.run(
                &samples,
                RENDER_RATE,
                &mut |f| emit(RENDER_SHARE + f * (1.0 - RENDER_SHARE)),
                &cancelled,
            )?;
            emit(1.0);
            Ok(LaneTranscription {
                notes: map_notes(notes, span.start_ms),
                start_ms: span.start_ms,
                end_ms: span.end_ms,
                clip_ids: span.clip_ids,
            })
        })
    };
    let result = worker.await;
    running.finish(&operation_id);
    result.unwrap_or_else(|_| Err(error("Could not detect notes in the lane.")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::backing::BackingParams;
    use crate::audio::lanes::voice::reversed;
    use crate::audio_lanes::{AudioTake, ClipFade};
    use std::collections::HashMap;

    const SOURCE: &str = "source-a";

    /// A source whose value is `0.1 * seconds`, so what was rendered tells where it was read.
    fn ramp(seconds: f64) -> DecodedAudio {
        let rate = RENDER_RATE;
        let left: Vec<f32> = (0..(seconds * f64::from(rate)) as usize)
            .map(|i| 0.1 * i as f32 / rate as f32)
            .collect();
        DecodedAudio {
            rate,
            channels: 2,
            right: left.clone(),
            left,
        }
    }

    fn clip(id: &str, start_ms: f64, offset_ms: f64, length_ms: f64) -> AudioClip {
        AudioClip {
            id: id.into(),
            takes: vec![AudioTake {
                name: "take".into(),
                source_id: SOURCE.into(),
                offset_ms,
            }],
            take: 0,
            start_ms,
            length_ms,
            gain_db: 0.0,
            mute: false,
            locked: false,
            reversed: false,
            semitones: 0,
            cents: 0,
            playrate: 1.0,
            preserve_pitch: true,
            fade_in: ClipFade::default(),
            fade_out: ClipFade::default(),
            envelope: vec![],
            stretch: vec![],
            group_id: None,
            midi: None,
        }
    }

    fn lane(clips: Vec<AudioClip>) -> AudioLane {
        AudioLane {
            id: "lane".into(),
            name: "Lead".into(),
            color: None,
            params: BackingParams::default(),
            follow_transposition: true,
            effects: vec![],
            auto_bypass: false,
            automation: vec![],
            sends: vec![],
            parent: None,
            folder: false,
            collapsed: false,
            group: 0,
            height: None,
            clips,
            shown_in_score: false,
            kind: None,
            instrument: None,
        }
    }

    fn lane_audio(lane: AudioLane, source: DecodedAudio) -> LaneAudio {
        let source = Arc::new(source);
        LaneAudio {
            lane,
            reversed: HashMap::from([(SOURCE.to_string(), Arc::new(reversed(&source)))]),
            sources: HashMap::from([(SOURCE.to_string(), source)]),
        }
    }

    fn render(audio: &LaneAudio, span: &Span) -> Vec<f32> {
        render_span(audio, span, &mut |_| {}, &|| false).unwrap()
    }

    fn span_of(audio: &LaneAudio, clip: Option<&str>, from: Option<f64>, to: Option<f64>) -> Span {
        resolve_span(&audio.lane, clip, from, to).unwrap()
    }

    fn near(actual: f32, expected: f32) {
        assert!(
            (actual - expected).abs() < 0.004,
            "{actual} is not near {expected}"
        );
    }

    fn at(samples: &[f32], ms: f64) -> f32 {
        samples[(ms / 1_000.0 * f64::from(RENDER_RATE)) as usize]
    }

    #[test]
    fn a_clip_becomes_mono_samples_at_the_render_rate() {
        // Left and right differ: the result is their average.
        let mut source = ramp(2.0);
        source.right.iter_mut().for_each(|s| *s = 0.0);
        let audio = lane_audio(lane(vec![clip("a", 0.0, 0.0, 2_000.0)]), source);
        let samples = render(&audio, &span_of(&audio, None, None, None));
        assert_eq!(samples.len(), 2 * RENDER_RATE as usize);
        near(at(&samples, 1_000.0), 0.05);
    }

    #[test]
    fn offset_and_trim_pick_the_part_of_the_file_that_plays() {
        // 0.5 s of the file from 1.0 s, placed at 2.0 s on the timeline.
        let audio = lane_audio(lane(vec![clip("a", 2_000.0, 1_000.0, 500.0)]), ramp(3.0));
        let span = span_of(&audio, None, None, None);
        assert_eq!((span.start_ms, span.end_ms), (2_000.0, 2_500.0));
        let samples = render(&audio, &span);
        assert_eq!(samples.len(), RENDER_RATE as usize / 2);
        near(at(&samples, 10.0), 0.101);
        near(at(&samples, 400.0), 0.14);
    }

    #[test]
    fn a_range_renders_only_that_slice() {
        let audio = lane_audio(lane(vec![clip("a", 2_000.0, 1_000.0, 1_000.0)]), ramp(3.0));
        let span = span_of(&audio, None, Some(2_200.0), Some(2_400.0));
        assert_eq!((span.start_ms, span.end_ms), (2_200.0, 2_400.0));
        let samples = render(&audio, &span);
        assert_eq!(samples.len(), RENDER_RATE as usize / 5);
        near(samples[100], 0.1 * (1.2 + 100.0 / RENDER_RATE as f32));
    }

    #[test]
    fn gaps_between_clips_are_silent() {
        let audio = lane_audio(
            lane(vec![
                clip("a", 0.0, 1.0, 400.0),
                clip("b", 1_000.0, 1.0, 400.0),
            ]),
            ramp(3.0),
        );
        let samples = render(&audio, &span_of(&audio, None, None, None));
        near(at(&samples, 600.0), 0.0);
        near(at(&samples, 800.0), 0.0);
        assert!(at(&samples, 1_200.0) > 0.0);
    }

    #[test]
    fn a_reversed_clip_plays_backwards() {
        let mut backwards = clip("a", 0.0, 0.0, 1_000.0);
        backwards.reversed = true;
        let audio = lane_audio(lane(vec![backwards]), ramp(1.0));
        let samples = render(&audio, &span_of(&audio, None, None, None));
        assert!(at(&samples, 100.0) > at(&samples, 800.0));
        near(at(&samples, 100.0), 0.1 * 0.9);
    }

    #[test]
    fn the_playrate_shortens_the_span_and_reads_the_file_faster() {
        let mut fast = clip("a", 0.0, 0.0, 1_000.0);
        fast.playrate = 2.0;
        let audio = lane_audio(lane(vec![fast]), ramp(1.0));
        let span = span_of(&audio, None, None, None);
        assert_eq!(span.end_ms, 500.0);
        let samples = render(&audio, &span);
        assert_eq!(samples.len(), RENDER_RATE as usize / 2);
        // 0.25 s into the clip reads the file at 0.5 s.
        near(at(&samples, 250.0), 0.05);
    }

    #[test]
    fn gain_fades_and_the_lane_mix_are_ignored() {
        let plain = lane_audio(lane(vec![clip("a", 0.0, 0.0, 1_000.0)]), ramp(1.0));
        let mut loud = clip("a", 0.0, 0.0, 1_000.0);
        loud.gain_db = -30.0;
        loud.fade_in = ClipFade {
            ms: 500.0,
            ..ClipFade::default()
        };
        let mut mixed = lane(vec![loud]);
        mixed.params.volume = 0.1;
        mixed.params.pan = 1.0;
        mixed.params.mute = true;
        mixed.params.enabled = false;
        let mixed = lane_audio(mixed, ramp(1.0));
        let (a, b) = (
            render(&plain, &span_of(&plain, None, None, None)),
            render(&mixed, &span_of(&mixed, None, None, None)),
        );
        assert_eq!(a.len(), b.len());
        for (x, y) in a.iter().zip(&b) {
            assert!((x - y).abs() < 1e-6);
        }
    }

    #[test]
    fn overlapping_clips_are_summed() {
        let one = lane_audio(lane(vec![clip("a", 0.0, 0.0, 1_000.0)]), ramp(1.0));
        let two = lane_audio(
            lane(vec![
                clip("a", 0.0, 0.0, 1_000.0),
                clip("b", 0.0, 0.0, 1_000.0),
            ]),
            ramp(1.0),
        );
        let single = render(&one, &span_of(&one, None, None, None));
        let double = render(&two, &span_of(&two, None, None, None));
        near(at(&double, 500.0), 2.0 * at(&single, 500.0));
    }

    #[test]
    fn muted_clips_are_skipped_and_all_muted_is_a_clear_message() {
        let mut muted = clip("a", 0.0, 0.0, 1_000.0);
        muted.mute = true;
        let two = lane(vec![muted.clone(), clip("b", 2_000.0, 0.0, 1_000.0)]);
        let span = resolve_span(&two, None, None, None).unwrap();
        assert_eq!(span.clip_ids, ["b"]);
        assert_eq!((span.start_ms, span.end_ms), (2_000.0, 3_000.0));
        let all = lane(vec![muted]);
        assert_eq!(
            resolve_span(&all, None, None, None).unwrap_err().message,
            "All the clips of this lane are muted. Unmute one to transcribe it."
        );
        assert_eq!(
            resolve_span(&all, Some("a"), None, None)
                .unwrap_err()
                .message,
            "That clip is muted. Unmute it to transcribe it."
        );
    }

    #[test]
    fn a_clip_request_takes_exactly_that_clip() {
        let two = lane(vec![
            clip("a", 0.0, 0.0, 1_000.0),
            clip("b", 500.0, 0.0, 1_000.0),
        ]);
        let span = resolve_span(&two, Some("b"), Some(0.0), Some(10.0)).unwrap();
        assert_eq!(
            span,
            Span {
                start_ms: 500.0,
                end_ms: 1_500.0,
                clip_ids: vec!["b".into()]
            }
        );
    }

    #[test]
    fn a_range_takes_the_clips_that_play_in_it() {
        let lane = lane(vec![
            clip("late", 5_000.0, 0.0, 1_000.0),
            clip("a", 0.0, 0.0, 1_000.0),
            clip("b", 2_000.0, 0.0, 1_000.0),
        ]);
        let all = resolve_span(&lane, None, None, None).unwrap();
        assert_eq!(all.clip_ids, ["a", "b", "late"]);
        assert_eq!((all.start_ms, all.end_ms), (0.0, 6_000.0));
        let from = resolve_span(&lane, None, Some(2_500.0), None).unwrap();
        assert_eq!(from.clip_ids, ["b", "late"]);
        assert_eq!((from.start_ms, from.end_ms), (2_500.0, 6_000.0));
        let to = resolve_span(&lane, None, None, Some(1_500.0)).unwrap();
        assert_eq!(to.clip_ids, ["a"]);
        assert_eq!((to.start_ms, to.end_ms), (0.0, 1_500.0));
        // A range is kept as asked, even past the clips.
        let wide = resolve_span(&lane, None, Some(1_000.0), Some(2_000.5)).unwrap();
        assert_eq!(wide.clip_ids, ["b"]);
        assert_eq!((wide.start_ms, wide.end_ms), (1_000.0, 2_000.5));
    }

    #[test]
    fn the_errors_say_what_is_wrong() {
        let empty = lane(vec![]);
        let one = lane(vec![clip("a", 1_000.0, 0.0, 1_000.0)]);
        let message = |lane: &AudioLane, id, from, to| {
            let err = resolve_span(lane, id, from, to).unwrap_err();
            (err.kind, err.message)
        };
        assert_eq!(
            message(&empty, None, None, None),
            (ErrorKind::Audio, "This lane has no audio.".into())
        );
        assert_eq!(
            message(&one, Some("zzz"), None, None),
            (
                ErrorKind::NotFound,
                "That clip is not in the lane any more.".into()
            )
        );
        assert_eq!(
            message(&one, None, Some(5_000.0), Some(6_000.0)).1,
            "There is no audio in that range."
        );
        assert_eq!(
            message(&one, None, Some(1_500.0), Some(1_500.0)).1,
            "Choose a range that ends after it starts."
        );
        for bad in [-1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(
                message(&one, None, Some(bad), None).1,
                "Choose a range inside the song."
            );
        }
        let mut folder = lane(vec![]);
        folder.folder = true;
        assert_eq!(
            message(&folder, None, None, None).1,
            "A folder has no audio of its own. Choose one of its lanes."
        );
    }

    #[test]
    fn a_missing_audio_file_is_reported_when_a_clip_needs_it() {
        let mut audio = lane_audio(lane(vec![clip("a", 0.0, 0.0, 1_000.0)]), ramp(1.0));
        audio.sources.clear();
        let span = span_of(&audio, None, None, None);
        let err = render_span(&audio, &span, &mut |_| {}, &|| false).unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotFound);
        assert!(err.message.contains("not loaded"));
    }

    #[test]
    fn ten_minutes_are_allowed_and_one_millisecond_more_is_not() {
        let span = |end_ms| Span {
            start_ms: 1_000.0,
            end_ms: 1_000.0 + end_ms,
            clip_ids: vec![],
        };
        assert!(check_span(&span(600_000.0)).is_ok());
        let err = check_span(&span(600_001.0)).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Audio);
        assert_eq!(
            err.message,
            "Choose up to 10 minutes of the lane at a time. Pick a shorter range or a clip."
        );
    }

    #[test]
    fn notes_move_to_timeline_seconds() {
        let note = |start, end, pitch| RecordedNote {
            start,
            end,
            pitch,
            velocity: 90,
        };
        let mapped = map_notes(vec![note(0.0, 0.5, 40), note(1.25, 2.0, 45)], 48_000.0);
        assert_eq!(mapped, vec![note(48.0, 48.5, 40), note(49.25, 50.0, 45)]);
        assert!(map_notes(vec![], 1_000.0).is_empty());
    }

    #[test]
    fn the_instrument_maps_bass_to_the_guitar_engine() {
        assert_eq!(parse_instrument("guitar").unwrap(), Instrument::Guitar);
        assert_eq!(parse_instrument(" Bass ").unwrap(), Instrument::Guitar);
        assert_eq!(parse_instrument("piano").unwrap(), Instrument::Piano);
        assert_eq!(parse_instrument("DRUMS").unwrap(), Instrument::Drums);
        assert_eq!(
            parse_instrument("kazoo").unwrap_err().message,
            "Choose guitar, bass, piano or drums."
        );
    }

    #[test]
    fn progress_climbs_to_one_and_a_cancel_stops_the_render() {
        let audio = lane_audio(lane(vec![clip("a", 0.0, 0.0, 2_000.0)]), ramp(2.0));
        let span = span_of(&audio, None, None, None);
        let mut seen = vec![];
        render_span(&audio, &span, &mut |f| seen.push(f), &|| false).unwrap();
        assert!(seen.windows(2).all(|w| w[0] <= w[1]));
        assert_eq!(seen.last(), Some(&1.0));
        let calls = std::cell::Cell::new(0);
        let err = render_span(&audio, &span, &mut |_| {}, &|| {
            calls.set(calls.get() + 1);
            calls.get() > 3
        })
        .unwrap_err();
        assert_eq!(err.message, STOPPED);
        assert_eq!(calls.get(), 4, "it stops at the first check that says so");
        let first = render_span(&audio, &span, &mut |_| {}, &|| true).unwrap_err();
        assert_eq!(first.message, STOPPED);
    }
}
