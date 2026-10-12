// A stub: the real module (notes to tab) replaces this file when the work is merged.
import type { Score } from "@/lib/score/model";

/** A note heard in a take. Times are seconds from the start of the take. */
export interface RecordedNote {
  start: number;
  end: number;
  pitch: number;
  velocity: number;
}

export function alignOffset(
  _notes: readonly RecordedNote[],
  _beatSeconds: number,
  _maxShift?: number,
): number {
  throw new Error("stub");
}

export function recordingToSong(
  _notes: readonly RecordedNote[],
  _options: { tuning: number[]; trackName: string; program: number },
): { score: Score; warnings: string[] } {
  throw new Error("stub");
}

export function writeRecording(
  _score: Score,
  _notes: readonly RecordedNote[],
  _options: { trackIndex: number; startBar: number },
): { warnings: string[] } {
  throw new Error("stub");
}
