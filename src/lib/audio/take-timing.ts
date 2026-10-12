/**
 * Timing of a take played against the click (Record to Tab, click mode).
 *
 * The recorder and the player run on different clocks. Both relate to the page's
 * `performance.now()` clock: the recorder reports when its first sample was taken, and the
 * workspace notes when playback started. From those, the start bar's downbeat falls at a known
 * second of the take, and every note moves back by that many seconds. The calls here are pure.
 */
import type { RecordedNote } from "@/lib/import/recording";

/** A pair from `AudioContext.getOutputTimestamp()`: the same instant on both clocks. */
export interface ClockStamp {
  /** Seconds on the audio context's clock. */
  contextTime: number;
  /** Milliseconds on `performance.now()`'s clock. */
  performanceTime: number;
}

/** The performance clock's time (ms) of a moment on an audio context's clock (seconds). */
export function contextToPerformance(contextTime: number, stamp: ClockStamp): number {
  return stamp.performanceTime + (contextTime - stamp.contextTime) * 1000;
}

/** How long a count-in lasts: `beats` clicks at the score's pace, slowed down by `speed` (1 = as written). */
export function countInSeconds(beats: number, beatSeconds: number, speed = 1): number {
  return (beats * beatSeconds) / speed;
}

export interface TakeTiming {
  /** When playback was started (`performance.now()`, ms). */
  playStartedAt: number;
  /** How long the count-in lasts before the start bar (seconds, as played). */
  countIn: number;
  /** When the take's first sample was taken (`performance.now()`, ms). */
  takeStartedAt: number;
  /** Seconds between the player's output and the speakers (what the browser reports). */
  outputLatency: number;
  /** Seconds between a sound and its sample (what the input reports). */
  inputLatency: number;
}

/**
 * The second of the take at which the start bar's downbeat was played and heard. The click is
 * heard `outputLatency` after the player started it. A sample taken at second `t` of the take
 * holds what was played `inputLatency` earlier, so the same instant is `inputLatency` later in
 * the take.
 */
export function downbeatInTake(timing: TakeTiming): number {
  const heardAt = timing.playStartedAt + (timing.countIn + timing.outputLatency) * 1000;
  return (heardAt - timing.takeStartedAt) / 1000 + timing.inputLatency;
}

/** Drops notes that ended before time 0, and starts the ones that began before it at 0. */
function fromZero(notes: RecordedNote[]): RecordedNote[] {
  return notes
    .filter((note) => note.end > 0)
    .map((note) => (note.start < 0 ? { ...note, start: 0 } : note));
}

/**
 * The notes as written: time 0 is the start bar's downbeat. `speed` is the playback speed (1 =
 * as written): a take played at half speed lasts twice as long as the music. Notes from the
 * count-in are dropped.
 */
export function shiftNotes(
  notes: readonly RecordedNote[],
  downbeat: number,
  speed = 1,
): RecordedNote[] {
  return fromZero(
    notes.map((note) => ({
      ...note,
      start: (note.start - downbeat) * speed,
      end: (note.end - downbeat) * speed,
    })),
  );
}

/** The notes moved by `offset` seconds (the best fit to the grid), never before time 0. */
export function offsetNotes(notes: readonly RecordedNote[], offset: number): RecordedNote[] {
  return fromZero(
    notes.map((note) => ({ ...note, start: note.start + offset, end: note.end + offset })),
  );
}
