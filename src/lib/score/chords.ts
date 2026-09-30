/**
 * Chords: naming a set of notes ("Am7", "C/E"), chord diagrams (which fret
 * each string plays), and attaching chords to beats in alphaTab's model.
 */
import { model } from "@coderline/alphatab";

import { spellPitchClass, spokenNoteName } from "@/lib/score/keys";
import type { Beat, Staff } from "@/lib/score/model";

interface Quality {
  suffix: string;
  spoken: string;
  /** Semitones above the root. */
  intervals: readonly number[];
}

/** Chord qualities, most common first (earlier wins when several fit). */
const QUALITIES: Quality[] = [
  { suffix: "", spoken: "major", intervals: [0, 4, 7] },
  { suffix: "m", spoken: "minor", intervals: [0, 3, 7] },
  { suffix: "5", spoken: "power chord", intervals: [0, 7] },
  { suffix: "7", spoken: "seventh", intervals: [0, 4, 7, 10] },
  { suffix: "maj7", spoken: "major seventh", intervals: [0, 4, 7, 11] },
  { suffix: "m7", spoken: "minor seventh", intervals: [0, 3, 7, 10] },
  { suffix: "sus4", spoken: "suspended fourth", intervals: [0, 5, 7] },
  { suffix: "sus2", spoken: "suspended second", intervals: [0, 2, 7] },
  { suffix: "6", spoken: "sixth", intervals: [0, 4, 7, 9] },
  { suffix: "m6", spoken: "minor sixth", intervals: [0, 3, 7, 9] },
  { suffix: "add9", spoken: "add nine", intervals: [0, 2, 4, 7] },
  { suffix: "madd9", spoken: "minor add nine", intervals: [0, 2, 3, 7] },
  { suffix: "9", spoken: "ninth", intervals: [0, 2, 4, 7, 10] },
  { suffix: "m9", spoken: "minor ninth", intervals: [0, 2, 3, 7, 10] },
  { suffix: "maj9", spoken: "major ninth", intervals: [0, 2, 4, 7, 11] },
  { suffix: "7sus4", spoken: "seventh suspended fourth", intervals: [0, 5, 7, 10] },
  { suffix: "dim", spoken: "diminished", intervals: [0, 3, 6] },
  { suffix: "m7b5", spoken: "half-diminished", intervals: [0, 3, 6, 10] },
  { suffix: "dim7", spoken: "diminished seventh", intervals: [0, 3, 6, 9] },
  { suffix: "aug", spoken: "augmented", intervals: [0, 4, 8] },
  { suffix: "m(maj7)", spoken: "minor major seventh", intervals: [0, 3, 7, 11] },
];

export interface ChordName {
  /** "Am7", "C/E". */
  name: string;
  /** "A minor seventh", "C major over E". */
  spoken: string;
  /** Pitch class of the root. */
  root: number;
  /** Pitch class of the lowest note. */
  bass: number;
}

const pitchClass = (pitch: number) => ((pitch % 12) + 12) % 12;

const sameSet = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((value) => b.includes(value));

/**
 * Names the chord the pitches (MIDI) form, best guess first: every note is
 * tried as the root, a root in the bass is preferred, and the fifth may be
 * left out of four-note chords (as guitarists often do). Returns nothing for
 * fewer than two different notes or no known chord.
 */
export function recognizeChord(
  pitches: readonly number[],
  { preferFlats = false }: { preferFlats?: boolean } = {},
): ChordName[] {
  const classes = [...new Set(pitches.map(pitchClass))];
  if (classes.length < 2) return [];
  const bass = pitchClass(Math.min(...pitches));
  const matches: { score: number; root: number; quality: Quality }[] = [];

  for (const root of classes) {
    const intervals = classes.map((pc) => pitchClass(pc - root));
    QUALITIES.forEach((quality, rank) => {
      const full = sameSet(intervals, quality.intervals);
      const noFifth =
        !full &&
        quality.intervals.length >= 4 &&
        quality.intervals.includes(7) &&
        sameSet(
          intervals,
          quality.intervals.filter((i) => i !== 7),
        );
      if (!full && !noFifth) return;
      const score = rank + (root === bass ? 0 : 50) + (noFifth ? 20 : 0);
      matches.push({ score, root, quality });
    });
  }

  const names = new Map<string, ChordName>();
  for (const { root, quality } of matches.sort((a, b) => a.score - b.score)) {
    const rootName = spellPitchClass(root, preferFlats);
    const bassName = spellPitchClass(bass, preferFlats);
    const slash = root === bass ? "" : `/${bassName}`;
    const name = `${rootName}${quality.suffix}${slash}`;
    if (names.has(name)) continue;
    names.set(name, {
      name,
      spoken: `${spokenNoteName(rootName)} ${quality.spoken}${
        slash ? ` over ${spokenNoteName(bassName)}` : ""
      }`,
      root,
      bass,
    });
  }
  return [...names.values()];
}

/** Frets shown in a chord diagram. */
export const DIAGRAM_FRETS = 5;

export interface ChordDiagram {
  /** Fret per string, highest string first: -1 = not played, 0 = open. */
  strings: number[];
  /** The fret at the top of the diagram (1 = the nut). */
  firstFret: number;
}

/** Where a diagram starts: at the nut when it fits there, else at its lowest fret. */
export function autoFirstFret(strings: readonly number[]): number {
  const fretted = strings.filter((fret) => fret > 0);
  if (fretted.length === 0 || Math.max(...fretted) <= DIAGRAM_FRETS - 1) return 1;
  return Math.min(...fretted);
}

/** The diagram of the notes on a tab beat (`string` 1 = lowest, as in alphaTab). */
export function diagramFromNotes(
  notes: readonly { string: number; fret: number }[],
  stringCount: number,
): ChordDiagram {
  const strings = Array.from({ length: stringCount }, () => -1);
  for (const { string, fret } of notes) {
    const index = stringCount - string;
    if (index >= 0 && index < stringCount) strings[index] = fret;
  }
  return { strings, firstFret: autoFirstFret(strings) };
}

/** The pitches a diagram sounds, with the track's tuning (highest string first) and capo. */
export function diagramPitches(
  diagram: ChordDiagram,
  tuning: readonly number[],
  capo = 0,
): number[] {
  return diagram.strings.flatMap((fret, i) =>
    fret >= 0 && tuning[i] !== undefined ? [tuning[i] + capo + fret] : [],
  );
}

/** A chord as the chord dialog edits it. */
export interface ChordSpec {
  name: string;
  /** Null for tracks without strings (name only). */
  diagram: ChordDiagram | null;
  showDiagram: boolean;
}

/** The chord written on a beat, if any. */
export function chordOf(beat: Beat): ChordSpec | null {
  const chord = beat.chordId ? beat.chord : null;
  if (!chord) return null;
  const hasDiagram = chord.strings.length > 0;
  return {
    name: chord.name,
    diagram: hasDiagram ? { strings: [...chord.strings], firstFret: chord.firstFret } : null,
    showDiagram: hasDiagram && chord.showDiagram,
  };
}

const sameChord = (chord: model.Chord, spec: ChordSpec) =>
  chord.name === spec.name &&
  chord.showDiagram === (spec.showDiagram && spec.diagram !== null) &&
  chord.firstFret === (spec.diagram?.firstFret ?? 1) &&
  chord.strings.length === (spec.diagram?.strings.length ?? 0) &&
  chord.strings.every((fret, i) => fret === spec.diagram?.strings[i]);

/** Every beat of the staff, in all bars and voices. */
function* staffBeats(staff: Staff): Generator<Beat> {
  for (const bar of staff.bars) for (const voice of bar.voices) yield* voice.beats;
}

/** Removes chords no beat uses any more, so the diagrams above the score stay accurate. */
function pruneChords(staff: Staff) {
  const chords = staff.chords;
  if (!chords) return;
  const used = new Set<string>();
  for (const beat of staffBeats(staff)) if (beat.chordId) used.add(beat.chordId);
  for (const id of [...chords.keys()]) if (!used.has(id)) chords.delete(id);
}

/**
 * Writes a chord on a beat (or removes it with null). Beats with the same
 * chord share one entry. Existing chord objects are never changed, so undo
 * snapshots of the staff and beat can restore them.
 */
export function setChord(beat: Beat, spec: ChordSpec | null): void {
  const staff = beat.voice.bar.staff;
  if (!spec) {
    beat.chordId = null;
    pruneChords(staff);
    return;
  }
  const existing = [...(staff.chords?.entries() ?? [])].find(([, chord]) => sameChord(chord, spec));
  let id = existing?.[0];
  if (!id) {
    const chord = new model.Chord();
    chord.name = spec.name;
    chord.firstFret = spec.diagram?.firstFret ?? 1;
    chord.strings = spec.diagram ? [...spec.diagram.strings] : [];
    chord.barreFrets = [];
    chord.showName = true;
    chord.showDiagram = spec.showDiagram && spec.diagram !== null;
    chord.showFingering = false;
    let n = (staff.chords?.size ?? 0) + 1;
    while (staff.chords?.has(`chord-${n}`)) n++;
    id = `chord-${n}`;
    staff.addChord(id, chord);
  }
  beat.chordId = id;
  pruneChords(staff);
}
