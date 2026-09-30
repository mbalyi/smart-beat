/**
 * Transposing music by semitones, and re-mapping tab positions when a track's
 * tuning changes while its pitches must stay.
 *
 * Both work in two steps so a change is all or nothing: a plan says where
 * every note goes (or that one does not fit), and only a complete plan is
 * applied.
 */
import { model } from "@coderline/alphatab";

import { harmonicValue } from "@/lib/score/effects";
import type { ScoreEditor } from "@/lib/score/editor";
import {
  barContent,
  isStringed,
  trackContent,
  tuningOf,
  type Beat,
  type Note,
  type Score,
  type Staff,
  type Track,
} from "@/lib/score/model";
import { MAX_FRET } from "@/lib/score/music";

/** Highest MIDI pitch. */
const MAX_PITCH = 127;

/** Most a song can be moved at once (two octaves each way). */
export const MAX_TRANSPOSE = 24;

export type TransposeScope = "selection" | "track" | "score";

export interface TransposeRequest {
  scope: TransposeScope;
  semitones: number;
  /** Also move key signatures (whole track or song only). */
  keySignatures: boolean;
}

/** Where a stringed note goes. */
interface Placement {
  note: Note;
  string: number;
  fret: number;
}

export interface TransposePlan {
  /** Stringed notes and where they go. */
  placements: Placement[];
  /** Pitched notes and their new pitch. */
  pitched: { note: Note; pitch: number }[];
  /** Notes that cannot be moved: they would leave the fretboard or the piano. */
  unplayable: number;
  /** Notes left alone (drums). */
  skipped: number;
}

/** Sounding pitch of a fretted note. */
const fretPitch = (staff: Staff, string: number, fret: number) =>
  tuningOf(staff)[tuningOf(staff).length - string]! + staff.capo + fret;

function staffOf(note: Note): Staff {
  return note.beat.voice.bar.staff;
}

/** A fret position for `pitch` on the staff, near `preferred` string and not on a taken one. */
export function findPosition(
  staff: Staff,
  pitch: number,
  preferred: number,
  taken: ReadonlySet<number>,
): { string: number; fret: number } | null {
  const strings = tuningOf(staff).length;
  const candidates: { string: number; fret: number }[] = [];
  for (let string = 1; string <= strings; string++) {
    const fret = pitch - fretPitch(staff, string, 0);
    if (fret >= 0 && fret <= MAX_FRET && !taken.has(string)) candidates.push({ string, fret });
  }
  candidates.sort(
    (a, b) => Math.abs(a.string - preferred) - Math.abs(b.string - preferred) || a.fret - b.fret,
  );
  return candidates[0] ?? null;
}

/** All beats of a track (every voice). */
function trackBeats(track: Track): Beat[] {
  return track.staves.flatMap((staff) =>
    staff.bars.flatMap((bar) => bar.voices.flatMap((voice) => voice.beats)),
  );
}

/** The beats a request moves. `selected` are the selection's beats (shown track). */
export function beatsFor(
  score: Score,
  scope: TransposeScope,
  shownTrack: number,
  selected: readonly Beat[],
): Beat[] {
  if (scope === "selection") return [...selected];
  if (scope === "track") return trackBeats(score.tracks[shownTrack]!);
  return score.tracks.flatMap(trackBeats);
}

/** Works out where every note goes when moved by `semitones`. */
export function planTranspose(beats: readonly Beat[], semitones: number): TransposePlan {
  const plan: TransposePlan = { placements: [], pitched: [], unplayable: 0, skipped: 0 };
  for (const beat of beats.filter((b) => !b.isEmpty)) {
    const taken = new Set<number>();
    const stringed = beat.notes.filter((note) => note.isStringed);
    // Keep each note on its string when the fret stays on the fretboard.
    const moved: Placement[] = [];
    const unplaced: Note[] = [];
    for (const note of stringed) {
      const fret = note.fret + semitones;
      if (fret >= 0 && fret <= MAX_FRET) {
        moved.push({ note, string: note.string, fret });
        taken.add(note.string);
      } else {
        unplaced.push(note);
      }
    }
    // Others move to another string, if there is room for them.
    for (const note of unplaced) {
      const staff = staffOf(note);
      const pitch = fretPitch(staff, note.string, note.fret) + semitones;
      const position = findPosition(staff, pitch, note.string, taken);
      if (position) {
        moved.push({ note, ...position });
        taken.add(position.string);
      } else {
        plan.unplayable++;
      }
    }
    plan.placements.push(...moved);

    for (const note of beat.notes) {
      if (note.isStringed) continue;
      if (note.isPercussion) {
        plan.skipped++;
        continue;
      }
      const pitch = note.realValue + semitones;
      if (pitch < 0 || pitch > MAX_PITCH) plan.unplayable++;
      else plan.pitched.push({ note, pitch });
    }
  }
  return plan;
}

/** Writes a plan into the model. Throws if it contains notes that do not fit. */
export function applyTransposePlan(plan: TransposePlan): void {
  if (plan.unplayable > 0) throw new Error(`${plan.unplayable} notes do not fit.`);
  for (const { note, string, fret } of plan.placements) {
    note.string = string;
    setFret(note, fret);
  }
  for (const { note, pitch } of plan.pitched) {
    note.octave = Math.floor(pitch / 12);
    note.tone = pitch % 12;
  }
}

/** A natural harmonic rings at the fret played: it moves with the note. */
function setFret(note: Note, fret: number) {
  note.fret = fret;
  if (note.harmonicType === model.HarmonicType.Natural) note.harmonicValue = harmonicValue(fret);
}

/**
 * A key signature moved by `semitones`: the number of flats (negative) or
 * sharps (positive) on the circle of fifths, folded to the side with fewer
 * accidentals (-6…+5).
 */
export function transposeKey(key: number, semitones: number): number {
  const fifths = key + 7 * semitones;
  return ((((fifths + 6) % 12) + 12) % 12) - 6;
}

/** Objects a transposition changes, for undo: bars of the moved beats (and every bar for keys). */
export function transposeTargets(
  score: Score,
  beats: readonly Beat[],
  scope: TransposeScope,
  shownTrack: number,
): object[] {
  if (scope === "selection") {
    const bars = new Set(beats.map((beat) => beat.voice.bar));
    return [...bars].flatMap((bar) => [...barContent(bar)]);
  }
  const tracks = scope === "track" ? [score.tracks[shownTrack]!] : score.tracks;
  return tracks.flatMap((track) => [...trackContent(track)]);
}

/** Moves key signatures of the tracks' bars (not drums). */
export function transposeKeySignatures(
  score: Score,
  scope: TransposeScope,
  shownTrack: number,
  semitones: number,
) {
  if (scope === "selection") return;
  const tracks = scope === "track" ? [score.tracks[shownTrack]!] : score.tracks;
  for (const track of tracks) {
    if (track.isPercussion) continue;
    for (const staff of track.staves) {
      for (const bar of staff.bars) bar.keySignature = transposeKey(bar.keySignature, semitones);
    }
  }
}

/** A sentence for the status line: "Moved 12 notes up 2 semitones". */
export function describeTranspose(count: number, semitones: number): string {
  const steps = Math.abs(semitones);
  const direction = semitones > 0 ? "up" : "down";
  return `Moved ${count} ${count === 1 ? "note" : "notes"} ${direction} ${steps} ${steps === 1 ? "semitone" : "semitones"}`;
}

// --- Changing the tuning and keeping the pitches -------------------------------

export interface RetunePlan {
  placements: Placement[];
  /** Notes that cannot be played in the new tuning. */
  unplayable: Note[];
}

/**
 * Where every note of the staff goes when its tuning (and capo) become
 * `tuning`/`capo`, keeping pitches. A note stays on its string when it fits
 * there, and otherwise moves to the nearest string where it does.
 */
export function planRetune(staff: Staff, tuning: readonly number[], capo: number): RetunePlan {
  const plan: RetunePlan = { placements: [], unplayable: [] };
  if (!isStringed(staff) || tuning.length === 0) return plan;
  const openPitch = (string: number) => tuning[tuning.length - string]! + capo;
  const oldTuning = tuningOf(staff);
  const oldPitch = (note: Note) =>
    oldTuning[oldTuning.length - note.string]! + staff.capo + note.fret;

  for (const bar of staff.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        const taken = new Set<number>();
        const pending: { note: Note; pitch: number }[] = [];
        for (const note of beat.notes) {
          if (!note.isStringed) continue;
          const pitch = oldPitch(note);
          const fret = pitch - openPitch(note.string);
          if (
            note.string <= tuning.length &&
            fret >= 0 &&
            fret <= MAX_FRET &&
            !taken.has(note.string)
          ) {
            plan.placements.push({ note, string: note.string, fret });
            taken.add(note.string);
          } else {
            pending.push({ note, pitch });
          }
        }
        for (const { note, pitch } of pending) {
          let best: { string: number; fret: number } | null = null;
          for (let string = 1; string <= tuning.length; string++) {
            const fret = pitch - openPitch(string);
            if (fret < 0 || fret > MAX_FRET || taken.has(string)) continue;
            if (!best || Math.abs(string - note.string) < Math.abs(best.string - note.string)) {
              best = { string, fret };
            }
          }
          if (best) {
            plan.placements.push({ note, ...best });
            taken.add(best.string);
          } else {
            plan.unplayable.push(note);
          }
        }
      }
    }
  }
  return plan;
}

/**
 * Writes a retune plan into the model: notes move to their new strings and
 * frets, and notes that do not fit are removed. Returns how many were removed.
 * The staff's tuning itself is changed by the caller.
 */
export function applyRetunePlan(plan: RetunePlan): number {
  for (const { note, string, fret } of plan.placements) {
    note.string = string;
    setFret(note, fret);
  }
  for (const note of plan.unplayable) note.beat.removeNote(note);
  return plan.unplayable.length;
}

export type TransposeResult =
  { ok: true; moved: number; message: string } | { ok: false; unplayable: number; message: string };

/**
 * Transposes as one undo step. Nothing changes (and the reason is returned)
 * when some notes would leave the fretboard or the piano.
 */
export function transposeMusic(editor: ScoreEditor, request: TransposeRequest): TransposeResult {
  const { score } = editor;
  const { scope, semitones } = request;
  const shown = editor.cursor.track;
  if (semitones === 0 || !Number.isInteger(semitones) || Math.abs(semitones) > MAX_TRANSPOSE) {
    return {
      ok: false,
      unplayable: 0,
      message: `Choose 1 to ${MAX_TRANSPOSE} semitones up or down.`,
    };
  }
  const cursorBeat = editor.cursorBeat();
  const selected = editor.selection ? editor.selectedBeatList() : cursorBeat ? [cursorBeat] : [];
  const beats = beatsFor(score, scope, shown, selected);
  const plan = planTranspose(beats, semitones);
  if (plan.unplayable > 0) {
    const n = plan.unplayable;
    return {
      ok: false,
      unplayable: n,
      message: `${n} ${n === 1 ? "note does" : "notes do"} not fit on the instrument after moving ${Math.abs(semitones)} ${Math.abs(semitones) === 1 ? "semitone" : "semitones"} ${semitones > 0 ? "up" : "down"}. Nothing was changed.`,
    };
  }
  const moved = plan.placements.length + plan.pitched.length;
  if (moved === 0) return { ok: false, unplayable: 0, message: "There are no notes to move." };
  const message = describeTranspose(moved, semitones);
  const keys = request.keySignatures && scope !== "selection";
  editor.run(
    "Transpose",
    () => transposeTargets(score, beats, scope, shown),
    () => {
      applyTransposePlan(plan);
      if (keys) transposeKeySignatures(score, scope, shown, semitones);
    },
    message,
  );
  return { ok: true, moved, message };
}
