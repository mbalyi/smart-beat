/**
 * "No value" of a note's fret, string, octave, tone and percussion articulation.
 * alphaTab 1.9 uses NaN for it (before 1.9 it was -1), and its `isStringed`,
 * `isPiano` and `isPercussion` read that: a note that still carries -1 counts as
 * stringed. Always write NO_VALUE, and read with `isNoValue`, which also knows
 * the -1 that older data may still carry.
 */
export const NO_VALUE = Number.NaN;

/** True for alphaTab's "no value" (NaN) and for the -1 older data used for it. */
export function isNoValue(value: number): boolean {
  return Number.isNaN(value) || value === -1;
}
