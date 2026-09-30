/**
 * Scales for the scale tool: which pitch classes a root and scale contain,
 * and how to name and spell them. Plain data.
 */
import { spellPitchClass, spokenNoteName } from "@/lib/score/keys";

export interface ScaleType {
  id: string;
  name: string;
  /** Semitones above the root. */
  intervals: readonly number[];
  /**
   * Semitones from the root to the major key the scale is spelled in (the
   * relative major of a minor scale, the parent key of a mode).
   */
  parent: number;
}

export const SCALE_TYPES: ScaleType[] = [
  { id: "major", name: "Major", intervals: [0, 2, 4, 5, 7, 9, 11], parent: 0 },
  { id: "minor", name: "Natural minor", intervals: [0, 2, 3, 5, 7, 8, 10], parent: 3 },
  { id: "harmonic-minor", name: "Harmonic minor", intervals: [0, 2, 3, 5, 7, 8, 11], parent: 3 },
  { id: "melodic-minor", name: "Melodic minor", intervals: [0, 2, 3, 5, 7, 9, 11], parent: 3 },
  { id: "major-pentatonic", name: "Major pentatonic", intervals: [0, 2, 4, 7, 9], parent: 0 },
  { id: "minor-pentatonic", name: "Minor pentatonic", intervals: [0, 3, 5, 7, 10], parent: 3 },
  { id: "blues", name: "Blues", intervals: [0, 3, 5, 6, 7, 10], parent: 3 },
  { id: "dorian", name: "Dorian", intervals: [0, 2, 3, 5, 7, 9, 10], parent: 10 },
  { id: "phrygian", name: "Phrygian", intervals: [0, 1, 3, 5, 7, 8, 10], parent: 8 },
  { id: "lydian", name: "Lydian", intervals: [0, 2, 4, 6, 7, 9, 11], parent: 7 },
  { id: "mixolydian", name: "Mixolydian", intervals: [0, 2, 4, 5, 7, 9, 10], parent: 5 },
  { id: "locrian", name: "Locrian", intervals: [0, 1, 3, 5, 6, 8, 10], parent: 1 },
  { id: "whole-tone", name: "Whole tone", intervals: [0, 2, 4, 6, 8, 10], parent: 0 },
];

export interface Scale {
  /** Pitch class of the root (0 = C). */
  root: number;
  type: string;
}

export const scaleType = (id: string) => SCALE_TYPES.find((t) => t.id === id) ?? SCALE_TYPES[0]!;

/** Major keys written with flats: F, Bb, Eb, Ab, Db (F sharp rather than G flat). */
const FLAT_MAJOR_KEYS = new Set([5, 10, 3, 8, 1]);

/** Whether the scale is spelled with flats (its parent major key has flats). */
export function scalePrefersFlats({ root, type }: Scale): boolean {
  return FLAT_MAJOR_KEYS.has((root + scaleType(type).parent) % 12);
}

/** The scale's pitch classes, from the root up. */
export function scalePitchClasses({ root, type }: Scale): number[] {
  return scaleType(type).intervals.map((i) => (root + i) % 12);
}

/** Whether a MIDI pitch is in the scale, and whether it is the root. */
export function scaleDegree(scale: Scale, pitch: number): "root" | "in" | null {
  const pitchClass = ((pitch % 12) + 12) % 12;
  if (pitchClass === scale.root) return "root";
  return scalePitchClasses(scale).includes(pitchClass) ? "in" : null;
}

/** "A Minor pentatonic" / spoken "B flat Major". */
export function scaleName(scale: Scale, { spoken = false } = {}): string {
  const root = spellPitchClass(scale.root, scalePrefersFlats(scale));
  return `${spoken ? spokenNoteName(root) : root} ${scaleType(scale.type).name.toLowerCase()}`;
}

/** "A minor pentatonic: A C D E G". */
export function describeScale(scale: Scale, { spoken = false } = {}): string {
  const flats = scalePrefersFlats(scale);
  const notes = scalePitchClasses(scale).map((pc) => {
    const name = spellPitchClass(pc, flats);
    return spoken ? spokenNoteName(name) : name;
  });
  return `${scaleName(scale, { spoken })}: ${notes.join(" ")}`;
}

/** The twelve roots for a picker, e.g. "C", "C#/Db". */
export const SCALE_ROOTS = Array.from({ length: 12 }, (_, pc) => {
  const sharp = spellPitchClass(pc, false);
  const flat = spellPitchClass(pc, true);
  return { pitchClass: pc, label: sharp === flat ? sharp : `${sharp}/${flat}` };
});
