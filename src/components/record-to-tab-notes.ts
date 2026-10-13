/**
 * What Record to Tab can and can't do, written once for the dialog and the welcome page.
 * The README's Record to tab cell repeats it; keep the two the same.
 */
import type { PianoEngine, RecordInstrument } from "@/lib/audio/record-prefs";

/** The guitar accuracy, measured on GuitarSet (docs/record-to-tab-spike.md), in plain words. */
export const RECORD_TO_TAB_ACCURACY =
  "Guitar: roughly 7 of 10 notes are found (note F1 about 72%), and the right string is picked for about 64% of them.";

/** The piano accuracy of the built-in model, measured on rendered piano music (docs/record-to-tab-piano.md). */
export const PIANO_STANDARD_ACCURACY =
  "Piano, built-in model: roughly 9 of 10 notes are found (note F1 about 86%).";

/** The piano accuracy of the High accuracy model, and what it costs. */
export const PIANO_ACCURATE_ACCURACY =
  "Piano, High accuracy model (a one-time 55 MB download): nearly every note is found (note F1 about 99%), and a take is processed in about half its own length.";

/** The caveat for the piano numbers. */
export const PIANO_CAVEAT = "Measured on rendered piano music: a real recording will score lower.";

/** The short note under the dialog's title, for what is chosen in the dialog. */
export function recordToTabBetaNote(instrument: RecordInstrument, engine: PianoEngine): string {
  if (instrument === "guitar") {
    return `Beta. Guitar and bass. ${RECORD_TO_TAB_ACCURACY} Review the tab and correct it.`;
  }
  const accuracy = engine === "accurate" ? PIANO_ACCURATE_ACCURACY : PIANO_STANDARD_ACCURACY;
  return `Beta. Piano is written as a right-hand and a left-hand track, without frets. ${accuracy} ${PIANO_CAVEAT} Review the notes and correct them.`;
}

/** The limits, one per line, for the welcome page. */
export const RECORD_TO_TAB_LIMITS: readonly string[] = [
  "Guitar, bass and piano. A piano take becomes a right-hand and a left-hand track.",
  "No cloud AI: a small note-finding model runs on your computer. For strings, Smart Beat's own rules pick the string and fret.",
  "Record inside the app, or use an existing recording.",
  RECORD_TO_TAB_ACCURACY,
  PIANO_STANDARD_ACCURACY,
  PIANO_ACCURATE_ACCURACY,
  PIANO_CAVEAT,
  "Review the result afterwards. You will probably need to correct it by hand.",
];
