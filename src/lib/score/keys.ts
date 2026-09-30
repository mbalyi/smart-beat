/**
 * Key signatures: their names, the accidentals they imply for letter entry,
 * and how pitches are spelled in them (sharps or flats). Plain data, except
 * for alphaTab's key signature enums.
 */
import { model } from "@coderline/alphatab";

const { KeySignatureType } = model;

export type KeySignature = model.KeySignature;
export type KeySignatureType = model.KeySignatureType;

export interface KeyInfo {
  /** Number of sharps (positive) or flats (negative), as alphaTab stores it. */
  signature: KeySignature;
  major: string;
  minor: string;
}

/** Every key signature from 7 flats to 7 sharps. */
export const KEY_SIGNATURES: KeyInfo[] = [
  { signature: -7, major: "Cb", minor: "Ab" },
  { signature: -6, major: "Gb", minor: "Eb" },
  { signature: -5, major: "Db", minor: "Bb" },
  { signature: -4, major: "Ab", minor: "F" },
  { signature: -3, major: "Eb", minor: "C" },
  { signature: -2, major: "Bb", minor: "G" },
  { signature: -1, major: "F", minor: "D" },
  { signature: 0, major: "C", minor: "A" },
  { signature: 1, major: "G", minor: "E" },
  { signature: 2, major: "D", minor: "B" },
  { signature: 3, major: "A", minor: "F#" },
  { signature: 4, major: "E", minor: "C#" },
  { signature: 5, major: "B", minor: "G#" },
  { signature: 6, major: "F#", minor: "D#" },
  { signature: 7, major: "C#", minor: "A#" },
];

/** "Bb" → "B flat", "F#" → "F sharp" (screen readers read "#" as "number"). */
export function spokenNoteName(name: string): string {
  if (name.length < 2) return name;
  const accidental = name.slice(1).replace("#", " sharp").replace(/^b/, " flat");
  return name[0] + accidental;
}

/** "G major", "E minor"; `spoken` spells out sharps and flats. */
export function keyName(
  signature: KeySignature,
  type: KeySignatureType,
  { spoken = false } = {},
): string {
  const key = KEY_SIGNATURES.find((k) => k.signature === signature) ?? KEY_SIGNATURES[7]!;
  const minor = type === KeySignatureType.Minor;
  const tonic = minor ? key.minor : key.major;
  return `${spoken ? spokenNoteName(tonic) : tonic} ${minor ? "minor" : "major"}`;
}

/** "No sharps or flats", "3 sharps", "1 flat". */
export function describeAccidentals(signature: number): string {
  if (signature === 0) return "No sharps or flats";
  const count = Math.abs(signature);
  const kind = signature > 0 ? "sharp" : "flat";
  return `${count} ${kind}${count === 1 ? "" : "s"}`;
}

const SHARP_ORDER = "FCGDAEB";
const FLAT_ORDER = "BEADGCF";

/**
 * How the key signature changes a letter: +1 (sharp), -1 (flat) or 0.
 * In G major, F is played as F sharp.
 */
export function keyAlteration(letter: string, signature: number): -1 | 0 | 1 {
  const upper = letter.toUpperCase();
  if (signature > 0 && SHARP_ORDER.slice(0, signature).includes(upper)) return 1;
  if (signature < 0 && FLAT_ORDER.slice(0, -signature).includes(upper)) return -1;
  return 0;
}

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

/** A pitch class (0 = C) spelled with sharps or flats, e.g. 10 → "A#" or "Bb". */
export function spellPitchClass(pitchClass: number, preferFlats = false): string {
  const index = ((pitchClass % 12) + 12) % 12;
  return (preferFlats ? FLAT_NAMES : SHARP_NAMES)[index]!;
}

/** Flat keys spell their notes with flats. */
export const prefersFlats = (signature: number) => signature < 0;

/** Pitch class (0 = C) of a key's tonic: G major → 7, E minor → 4. */
export function keyTonic(signature: number, type: KeySignatureType): number {
  const major = (((signature * 7) % 12) + 12) % 12;
  return type === KeySignatureType.Minor ? (major + 9) % 12 : major;
}
