/**
 * Bars whose notes do not add up to the time signature ("incomplete bars" in
 * Guitar Pro), and the fix: fill short bars with rests, shorten long ones.
 *
 * Only voices with written music are judged. The first voice of a bar must
 * always be full; a second voice that is empty is fine.
 */
import { model } from "@coderline/alphatab";

import {
  barContent,
  newBeat,
  type Bar,
  type Beat,
  type Score,
  type Voice,
} from "@/lib/score/model";
import { durationTicks, NOTE_VALUES, type Duration } from "@/lib/score/music";

const { GraceType } = model;

/** Shortest note value the fix writes (64th): anything shorter is left alone. */
const MIN_TICKS = 60;

/** Differences below this are rounding noise from tuplets. */
const TOLERANCE = 0.5;

export interface BarProblem {
  /** 0-based bar index. */
  bar: number;
  /** 0-based track index. */
  track: number;
  /** 0-based voice index. */
  voice: number;
  /** Ticks the notes add up to. */
  actual: number;
  /** Ticks the time signature asks for. */
  expected: number;
}

export const isShort = (problem: BarProblem) => problem.actual < problem.expected;

/** Ticks a beat takes. Grace notes take none: they steal time from their neighbour. */
export function beatTicks(beat: Beat): number {
  if (beat.graceType !== GraceType.None) return 0;
  return durationTicks(beat.duration, beat.dots, {
    numerator: beat.tupletNumerator,
    denominator: beat.tupletDenominator,
  });
}

export const voiceTicks = (voice: Voice): number =>
  voice.beats.reduce((sum, beat) => sum + beatTicks(beat), 0);

/** Whether a voice holds written music (notes, or rests in a voice that is not a placeholder). */
function isWritten(voice: Voice): boolean {
  if (voice.beats.every((beat) => beat.isEmpty)) return false;
  return voice.index === 0 || voice.beats.some((beat) => beat.notes.length > 0);
}

function barProblemsOf(bar: Bar): BarProblem[] {
  const masterBar = bar.masterBar;
  if (masterBar.isAnacrusis) return []; // a pickup bar is meant to be short
  const expected = masterBar.calculateDuration();
  const problems: BarProblem[] = [];
  for (const voice of bar.voices) {
    if (!isWritten(voice)) continue;
    const actual = voiceTicks(voice);
    if (Math.abs(actual - expected) > TOLERANCE) {
      problems.push({
        bar: bar.index,
        track: bar.staff.track.index,
        voice: voice.index,
        actual,
        expected,
      });
    }
  }
  return problems;
}

/** Every bar voice with the wrong length, in every track (or only `trackIndex`). */
export function barProblems(score: Score, trackIndex?: number): BarProblem[] {
  return score.tracks
    .filter((track) => trackIndex === undefined || track.index === trackIndex)
    .flatMap((track) => track.staves.flatMap((staff) => staff.bars.flatMap(barProblemsOf)));
}

/** "Bar 3 is 1/4 too short", for messages. */
export function describeProblem(problem: BarProblem): string {
  const diff = Math.abs(problem.expected - problem.actual);
  const quarters = diff / 960;
  const amount =
    quarters === Math.round(quarters)
      ? `${quarters} beat${quarters === 1 ? "" : "s"}`
      : `${+quarters.toFixed(2)} beats`;
  return `Bar ${problem.bar + 1} is ${amount} too ${isShort(problem) ? "short" : "long"}`;
}

/** Note values (with at most one dot) that add up to `ticks`, longest first. */
export function fillDurations(ticks: number): { duration: Duration; dots: number }[] {
  const result: { duration: Duration; dots: number }[] = [];
  let remaining = ticks;
  while (remaining >= MIN_TICKS - TOLERANCE) {
    let placed = false;
    for (const { duration } of NOTE_VALUES) {
      for (const dots of [1, 0]) {
        const length = durationTicks(duration, dots);
        if (length <= remaining + TOLERANCE) {
          result.push({ duration, dots });
          remaining -= length;
          placed = true;
          break;
        }
      }
      if (placed) break;
    }
    if (!placed) break;
  }
  return result;
}

function fixVoice(voice: Voice, expected: number): void {
  let kept = 0;
  const beats: Beat[] = [];
  for (const beat of voice.beats) {
    const length = beatTicks(beat);
    if (kept + length <= expected + TOLERANCE) {
      beats.push(beat);
      kept += length;
      continue;
    }
    // A beat that crosses the end of the bar keeps its notes with a shorter length.
    const room = expected - kept;
    const [first] = fillDurations(room);
    if (first && beat.notes.length > 0) {
      beat.duration = first.duration;
      beat.dots = first.dots;
      beat.tupletNumerator = 1;
      beat.tupletDenominator = 1;
      beats.push(beat);
      kept += beatTicks(beat);
    }
    break; // everything after it is cut
  }
  for (const { duration, dots } of fillDurations(expected - kept)) {
    beats.push(newBeat(duration, dots));
  }
  voice.beats = [];
  for (const beat of beats) voice.addBeat(beat);
}

/** The objects a fix of these problems changes (for undo). */
export function fixTargets(score: Score, problems: readonly BarProblem[]): object[] {
  const bars = new Set<Bar>();
  for (const { track, bar } of problems) {
    const staff = score.tracks[track]?.staves[0];
    const target = staff?.bars[bar];
    if (target) bars.add(target);
  }
  return [...bars].flatMap((bar) => [...barContent(bar)]);
}

/** Fills short bars with rests and shortens long ones. Returns how many voices were fixed. */
export function fixBarDurations(score: Score, problems: readonly BarProblem[]): number {
  let fixed = 0;
  for (const problem of problems) {
    const voice = score.tracks[problem.track]?.staves[0]?.bars[problem.bar]?.voices[problem.voice];
    if (!voice) continue;
    fixVoice(voice, problem.expected);
    fixed++;
  }
  return fixed;
}
