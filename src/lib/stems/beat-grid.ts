/**
 * The beats a metronome clicks for a song: a steady grid from a first beat at one tempo, or a
 * grid with a tempo per part of the song. Everything here is in seconds of the song; the player
 * turns them into moments on the audio clock (see `createStemPlayer`).
 */

/** Beats in a bar, for the accent (the click on the first beat of each bar is higher). */
export const BEATS_PER_BAR = 4;

/** A tempo that holds from `startSec` until the next segment starts. */
export interface TempoSegment {
  startSec: number;
  bpm: number;
}

export interface BeatGrid {
  /**
   * Where a beat falls. The first segment's beats are counted from here, forwards and
   * backwards, so a seek before it still clicks in time.
   */
  firstBeatSec: number;
  /** Ascending by `startSec`. The first one's start is ignored: it holds from the start. */
  segments: readonly TempoSegment[];
  beatsPerBar?: number;
}

/** One beat to click. */
export interface Beat {
  /** Seconds into the song. */
  time: number;
  /** The first beat of a bar. */
  accent: boolean;
}

/** One steady tempo for the whole song. */
export function steadyGrid(bpm: number, firstBeatSec: number): BeatGrid {
  return { firstBeatSec, segments: [{ startSec: 0, bpm }] };
}

/**
 * A grid that follows tempo changes: the first part counts from `firstBeatSec`, each later part
 * starts a beat (and a bar) at its own start. Parts with no tempo are dropped.
 */
export function sectionGrid(
  sections: readonly { startSec: number; bpm: number }[],
  firstBeatSec: number,
): BeatGrid | null {
  const segments = sections
    .filter((section) => section.bpm > 0 && Number.isFinite(section.startSec))
    .sort((a, b) => a.startSec - b.startSec)
    .map(({ startSec, bpm }) => ({ startSec, bpm }));
  return segments.length > 0 ? { firstBeatSec, segments } : null;
}

/** Seconds between two beats. */
export const beatSeconds = (bpm: number) => 60 / bpm;

/**
 * The beats with `from <= time < to`, in order. The range is half open so that a caller that
 * walks forward (`to` of one call is `from` of the next) never gets a beat twice or misses one.
 */
export function beatsBetween(grid: BeatGrid, from: number, to: number): Beat[] {
  const perBar = grid.beatsPerBar ?? BEATS_PER_BAR;
  const out: Beat[] = [];
  const { segments } = grid;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    if (!(segment.bpm > 0)) continue;
    const first = index === 0;
    const start = first ? -Infinity : segment.startSec;
    const end = segments[index + 1]?.startSec ?? Infinity;
    const lo = Math.max(from, start);
    const hi = Math.min(to, end);
    if (!(lo < hi)) continue;
    const step = beatSeconds(segment.bpm);
    const anchor = first ? grid.firstBeatSec : segment.startSec;
    // Beat k is at anchor + k * step; the first whole k at or after `lo`. The small tolerance
    // keeps a beat that floating point puts a hair before `lo` from being skipped.
    let k = Math.ceil((lo - anchor) / step - 1e-9);
    for (; ; k++) {
      const time = anchor + k * step;
      if (time >= hi) break;
      if (time < lo) continue;
      out.push({ time, accent: ((k % perBar) + perBar) % perBar === 0 });
    }
  }
  return out;
}

/** The tempo in force at `seconds` (the first segment holds before its start). */
export function bpmAt(grid: BeatGrid, seconds: number): number {
  let bpm = grid.segments[0]?.bpm ?? 0;
  for (const segment of grid.segments) {
    if (segment.startSec <= seconds) bpm = segment.bpm;
  }
  return bpm;
}
