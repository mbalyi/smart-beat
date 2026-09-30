/**
 * What the fretboard, piano keyboard and drum pads show: plain data computed
 * from a track's tuning and the notes being played (no alphaTab objects).
 */
import type { NoteInfo } from "@/lib/score/editor";
import { model } from "@coderline/alphatab";

import { soundOf, type Beat, type Track } from "@/lib/score/model";
import {
  DRUM_KIT,
  DRUM_NOTATION,
  instrumentName,
  pitchName,
  tuningName,
  type TrackKind,
} from "@/lib/score/music";
import type { TrackSummary } from "@/lib/score/score";

/** Frets shown on the fretboard (0 = open strings). */
export const FRET_COUNT = 24;
/** Frets with an inlay dot (12 and 24 get two). */
export const FRET_MARKERS = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24];

export interface FretboardString {
  /** alphaTab's string number (1 = lowest). */
  string: number;
  /** Guitarists' number (1 = highest). */
  number: number;
  /** MIDI pitch of the open string, capo excluded. */
  open: number;
  label: string;
}

/** Strings from the highest (top of the fretboard, as in tab) to the lowest. */
export function fretboardStrings(tuning: readonly number[]): FretboardString[] {
  return tuning.map((open, i) => ({
    string: tuning.length - i,
    number: i + 1,
    open,
    label: pitchName(open, { octave: false }),
  }));
}

/** A note on the fretboard, at its position counted from the nut. */
export interface FretPosition {
  string: number;
  /** Fret from the nut (capo included), e.g. 5 for fret 3 with a capo on 2. */
  fret: number;
}

export function fretPositions(notes: readonly NoteInfo[], capo: number): FretPosition[] {
  return notes
    .filter((note) => note.string !== null && note.fret !== null)
    .map((note) => ({ string: note.string!, fret: note.fret! + capo }));
}

/** Plain data for the notes of some beats (e.g. the ones being played). */
export function notesOf(beats: readonly Beat[]): NoteInfo[] {
  return beats.flatMap((beat) =>
    beat.isEmpty
      ? []
      : beat.notes.map((note) => ({
          string: note.isStringed ? note.string : null,
          fret: note.isStringed ? note.fret : null,
          pitch: soundOf(note),
          tied: note.isTieDestination,
        })),
  );
}

export const isBlackKey = (pitch: number) => [1, 3, 6, 8, 10].includes(((pitch % 12) + 12) % 12);

/**
 * Keys to show: C3–C6 by default, widened (to whole octaves) so every
 * `pitches` fits, within the piano's range.
 */
export function keyboardRange(pitches: readonly number[]): { low: number; high: number } {
  let low = 48;
  let high = 84;
  for (const pitch of pitches) {
    if (pitch < low) low = pitch - (((pitch % 12) + 12) % 12);
    if (pitch > high) high = pitch + ((12 - (((pitch % 12) + 12) % 12)) % 12);
  }
  return { low: Math.max(21, low), high: Math.min(108, high) };
}

/** Drum pads: the standard kit, plus any other sound the track uses. */
export function drumPads(
  extra: readonly number[] = [],
): { id: number; name: string; short: string }[] {
  const known = new Set(DRUM_KIT.map((d) => d.id));
  const others = [...new Set(extra)]
    .filter((id) => !known.has(id))
    .sort((a, b) => a - b)
    .map((id) => ({ id, name: `Drum sound ${id}`, short: String(id) }));
  return [...DRUM_KIT, ...others];
}

/** One row of a drum track's notation map (see the Track settings dialog). */
export interface DrumMapping {
  name: string;
  /** General MIDI key it plays. */
  midi: number;
  /** Staff position (0 = top line, counting half steps down). */
  staffLine: number;
  notehead: string;
}

/** "NoteheadXBlack" → "X black", "NoteheadCircleX" → "Circle X". */
function noteheadName(symbol: model.MusicFontSymbol): string {
  const name = (model.MusicFontSymbol[symbol] ?? "").replace(/^Notehead/, "");
  const words = name.split(/(?=[A-Z])/).filter(Boolean);
  if (words.length === 0 || name === "Black") return "Normal";
  return words.map((w, i) => (i === 0 || w.length === 1 ? w : w.toLowerCase())).join(" ");
}

/**
 * How a drum track writes each sound: its own map (Guitar Pro 6+ files) or
 * the standard drum kit.
 */
export function drumKitOf(track: Track | null): DrumMapping[] {
  const own = track?.percussionArticulations ?? [];
  if (own.length > 0) {
    return own.map((a) => ({
      name: a.elementType || `Sound ${a.outputMidiNumber}`,
      midi: a.outputMidiNumber,
      staffLine: a.staffLine,
      notehead: noteheadName(a.noteHeadDefault),
    }));
  }
  return DRUM_KIT.map((drum) => ({
    name: drum.name,
    midi: drum.id,
    staffLine: DRUM_NOTATION[drum.id]!.staffLine,
    notehead: DRUM_NOTATION[drum.id]!.notehead,
  }));
}

/** What the instrument view is called for a kind of track. */
export const instrumentViewName = (kind: TrackKind) =>
  kind === "stringed" ? "Fretboard" : kind === "drums" ? "Drum pads" : "Keyboard";

/** "Electric Guitar (clean) · Guitar Dropped D Tuning · Capo 2", "Drums". */
export function describeInstrument(track: TrackSummary): string {
  if (track.kind === "drums") return "Drums";
  const parts: string[] = [instrumentName(track.program)];
  if (track.kind === "stringed") {
    parts.push(
      tuningName(track.tuning) ??
        `${track.tuning.length} strings: ${track.tuning.map((p) => pitchName(p, { octave: false })).join(" ")}`,
    );
    if (track.capo > 0) parts.push(`Capo ${track.capo}`);
  }
  return parts.join(" · ");
}
