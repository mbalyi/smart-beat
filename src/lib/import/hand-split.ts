/**
 * Splits the notes of a piano take between the right hand (treble staff) and the left hand
 * (bass staff). A recording has no hands, only pitches, so this guesses from pitch: notes well
 * above middle C go right, notes well below go left, and the notes close to the split follow
 * the hand that played the nearest note just before them. That keeps a melody that dips
 * below middle C on one staff, instead of hopping between the two.
 */

/** Middle C. */
export const SPLIT_PITCH = 60;
/** Notes within this many semitones of the split are decided by their neighbours. */
const AMBIGUOUS = 5;
/** A hand's last note counts as "just before" for this long (seconds). */
const RECENT = 1.5;

interface Timed {
  start: number;
  pitch: number;
}

export interface Hands<T> {
  right: T[];
  left: T[];
}

/** Right-hand and left-hand notes, each in the order they came in. */
export function splitHands<T extends Timed>(notes: readonly T[], split = SPLIT_PITCH): Hands<T> {
  const order = notes.map((note, index) => ({ note, index }));
  order.sort((a, b) => a.note.start - b.note.start || a.note.pitch - b.note.pitch);
  const hand = new Map<T, "right" | "left">();
  const last = { right: null as T | null, left: null as T | null };
  const near = (note: T, other: T | null) =>
    other !== null && note.start - other.start <= RECENT
      ? Math.abs(note.pitch - other.pitch)
      : Infinity;
  for (const { note } of order) {
    let side: "right" | "left";
    if (note.pitch >= split + AMBIGUOUS) side = "right";
    else if (note.pitch < split - AMBIGUOUS) side = "left";
    else {
      const right = near(note, last.right);
      const left = near(note, last.left);
      // Closest recent note wins. With nothing recent, pitch decides.
      side =
        right < left ? "right" : left < right ? "left" : note.pitch >= split ? "right" : "left";
    }
    hand.set(note, side);
    last[side] = note;
  }
  const out: Hands<T> = { right: [], left: [] };
  for (const note of notes) out[hand.get(note)!].push(note);
  return out;
}
