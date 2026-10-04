/**
 * Where a drum note sits in the drum tab (#53). In Guitar Pro 3–5 the user
 * puts each drum on a string of the drum track's tab (e.g. a crash and the
 * kick stacked on two strings, the snare on a third); Smart Beat keeps that
 * placement, shows it, lets the user move a drum to another line and saves it.
 *
 * The line is stored in the note's `fret`, which alphaTab does not use for
 * percussion notes (they are played and drawn from their articulation) and
 * copies whenever it clones a note, so edits, undo and copy/paste keep it.
 * Lines are alphaTab string numbers: 1 is the bottom line, 6 the top one.
 */
import { Environment, type model } from "@coderline/alphatab";

import type { DrumLine } from "@/lib/tauri";

type Note = model.Note;
type Score = model.Score;

/** Lines of the drum tab (Guitar Pro 5 drum tracks have six strings). */
export const DRUM_TAB_LINES = 6;

const isLine = (value: number) => Number.isInteger(value) && value >= 1 && value <= DRUM_TAB_LINES;

/** The line a drum note was placed on, or null (then it goes on its usual line). */
export function drumLine(note: Note): number | null {
  return note.isPercussion && isLine(note.fret) ? note.fret : null;
}

/** Places a drum note on a line of the drum tab (null: its usual line). */
export function setDrumLine(note: Note, line: number | null) {
  if (!note.isPercussion) return;
  note.fret = line !== null && isLine(line) ? line : -1;
}

/**
 * Teaches alphaTab's Guitar Pro 3–5 reader to keep the string each drum note
 * was written on (it reads it and then throws it away). Runs once.
 */
let reading = false;
export function keepGp5DrumStrings() {
  if (reading) return;
  reading = true;
  const gp5 = Environment.buildImporters().find((i) => /Guitar Pro 3-5/i.test(i.name));
  if (!gp5) return;
  const prototype = Object.getPrototypeOf(gp5) as {
    readNote?: (track: unknown, bar: unknown, voice: unknown, beat: unknown, index: number) => Note;
  };
  const readNote = prototype.readNote;
  if (typeof readNote !== "function") return;
  prototype.readNote = function (track, bar, voice, beat, stringIndex) {
    const note = readNote.call(this, track, bar, voice, beat, stringIndex);
    // `stringIndex` 0 is the file's top string, which is our top line.
    if (note.percussionArticulation >= 0 && note.string < 0) {
      note.fret = Math.min(DRUM_TAB_LINES, Math.max(1, DRUM_TAB_LINES - stringIndex));
    }
    return note;
  };
}

/** Every drum note that has a line, by position (for a song's settings). */
export function collectDrumLines(score: Score): DrumLine[] {
  const lines: DrumLine[] = [];
  score.tracks.forEach((track, t) => {
    const staff = track.staves[0];
    if (!staff?.isPercussion) return;
    staff.bars.forEach((bar, b) =>
      bar.voices.forEach((voice, v) =>
        voice.beats.forEach((beat, i) =>
          beat.notes.forEach((note, n) => {
            const line = drumLine(note);
            if (line !== null) lines.push({ track: t, bar: b, voice: v, beat: i, note: n, line });
          }),
        ),
      ),
    );
  });
  return lines;
}

/** Puts back the lines saved with a song (positions that no longer exist are skipped). */
export function applyDrumLines(score: Score, lines: readonly DrumLine[]) {
  for (const { track, bar, voice, beat, note, line } of lines) {
    const target =
      score.tracks[track]?.staves[0]?.bars[bar]?.voices[voice]?.beats[beat]?.notes[note];
    if (target) setDrumLine(target, line);
  }
}
