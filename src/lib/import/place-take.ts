/**
 * Writes transcribed notes into a song: onto an existing track or a new one (a piano gets a
 * track for each hand). Record to tab and "Sheet from an audio lane" share this one function, and
 * the lane dialog's preview runs it on a copy of the song, so the preview and the real write
 * cannot differ.
 */
import type { RecordInstrument } from "@/lib/audio/record-prefs";
import { splitHands } from "@/lib/import/hand-split";
import { writeRecording, type RecordedNote } from "@/lib/import/recording";
import type { Score } from "@/lib/score/model";
import { getPreset } from "@/lib/score/music";
import { createTrack, insertTrack, uniqueTrackName } from "@/lib/score/tracks";

/** The name of a new track and of the song a free take becomes. */
export const RECORDING_NAME = "Recording";
export const DRUMS_NAME = "Drums";

/** The General MIDI program a take is written with, so a bass sounds like a bass. */
export function programFor(instrument: RecordInstrument): number {
  // A drum track plays on channel 10, where the program is not used.
  if (instrument === "drums") return 0;
  if (instrument === "piano") return getPreset("piano")?.program ?? 0;
  if (instrument === "bass") return getPreset("bass-4")?.program ?? 33;
  return getPreset("guitar")?.program ?? 25;
}

/** Where and how notes are written. */
export interface TakePlan {
  instrument: RecordInstrument;
  /** The tuning of a new track (strings, highest first). Unused for a piano and drums. */
  tuning: number[];
  /** The track to write on (an index), or null for a new track. */
  track: number | null;
  /** The bar to start at (0-based). */
  startBar: number;
  /** The name of a new track; the default is "Recording" (or "Drums"). */
  trackName?: string;
}

/** What {@link placeTake} did. */
export interface PlacedTake {
  /** The track written to (the first one, for a piano's two hands). */
  track: number;
  /** What could not be written exactly. */
  warnings: string[];
  /** The bars written (0-based), and how many were appended to the song. */
  firstBar: number;
  lastBar: number;
  appended: number;
}

/**
 * Writes `notes` (seconds from the downbeat of `plan.startBar`) into `score`. This changes the
 * model without an undo step: run it inside `editor.run`, or on `cloneScore(score)` for a preview.
 */
export function placeTake(
  score: Score,
  notes: readonly RecordedNote[],
  plan: TakePlan,
): PlacedTake {
  let warnings: string[] = [];
  let index = plan.track ?? -1;
  const barsBefore = score.masterBars.length;
  // The bars written across every write (a piano's two hands can reach different bars).
  let range: { firstBar: number; lastBar: number } | null = null;
  const remember = (written: { firstBar: number; lastBar: number }) => {
    range = range
      ? {
          firstBar: Math.min(range.firstBar, written.firstBar),
          lastBar: Math.max(range.lastBar, written.lastBar),
        }
      : { firstBar: written.firstBar, lastBar: written.lastBar };
  };
  const piano = plan.instrument === "piano";
  const drums = plan.instrument === "drums";
  if (plan.track === null) {
    // A piano gets a track for each hand; a hand with no notes gets none.
    const hands = piano ? splitHands(notes) : null;
    const made = (hands ? [hands.right, hands.left] : [notes]).map((list, hand) => ({
      list,
      bass: hand === 1,
    }));
    const used = made.filter(({ list }) => list.length > 0 || !hands);
    const base = plan.trackName ?? (drums ? DRUMS_NAME : RECORDING_NAME);
    for (const { list, bass } of used) {
      const created = createTrack(
        score,
        drums
          ? { kind: "drums", name: uniqueTrackName(score, base), program: 0 }
          : piano
            ? {
                kind: "pitched",
                name: uniqueTrackName(score, bass ? `${base} (left hand)` : base),
                program: programFor("piano"),
                bass,
              }
            : {
                kind: "stringed",
                name: uniqueTrackName(score, base),
                program: programFor(plan.instrument),
                tuning: plan.tuning,
              },
      );
      insertTrack(score, created);
      const at = score.tracks.indexOf(created);
      if (index < 0) index = at;
      const written = writeRecording(score, list, { trackIndex: at, startBar: plan.startBar });
      remember(written);
      warnings = [...warnings, ...written.warnings];
    }
    warnings = [...new Set(warnings)];
  } else {
    const written = writeRecording(score, notes, {
      trackIndex: plan.track,
      startBar: plan.startBar,
    });
    remember(written);
    warnings = written.warnings;
  }
  const { firstBar, lastBar } = range ?? { firstBar: plan.startBar, lastBar: plan.startBar - 1 };
  // The growth of the song over the whole placement, not of one hand's write.
  const appended = Math.max(0, score.masterBars.length - barsBefore);
  return { track: index, warnings, firstBar, lastBar, appended };
}
