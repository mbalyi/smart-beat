/**
 * The tracks stacked in the continuous view (#157): a display order, kept
 * apart from the order of the tracks in the file. Tracks are held by identity
 * (like the mix), so the list follows them through reordering, removal and
 * undo. The active track (the one being edited) is always in the stack.
 */
import type { Track } from "@/lib/score/model";

/** The stack with `active` guaranteed in it (first, when it had to be added), without removed tracks. */
export function reconcileStack(
  stack: readonly Track[],
  tracks: readonly Track[],
  active: Track,
): Track[] {
  const alive = new Set(tracks);
  const kept = stack.filter((t, i) => alive.has(t) && stack.indexOf(t) === i);
  return kept.includes(active) ? kept : [active, ...kept];
}

/** Shows `track` in the stack, after the last one, or hides it. The active track cannot be hidden. */
export function toggleInStack(stack: readonly Track[], track: Track, active: Track): Track[] {
  if (stack.includes(track))
    return track === active ? [...stack] : stack.filter((t) => t !== track);
  return [...stack, track];
}

/** Moves a stacked track by `delta` places (clamped to the ends). */
export function moveInStack(stack: readonly Track[], track: Track, delta: number): Track[] {
  const from = stack.indexOf(track);
  if (from < 0) return [...stack];
  const to = Math.min(stack.length - 1, Math.max(0, from + delta));
  const next = stack.filter((t) => t !== track);
  next.splice(to, 0, track);
  return next;
}

/** Score indexes of a stack (what is saved with the song); unknown tracks are dropped. */
export function stackToIndexes(stack: readonly Track[], tracks: readonly Track[]): number[] {
  return stack.map((t) => tracks.indexOf(t)).filter((i) => i >= 0);
}

/** The stack saved as score indexes: out-of-range and repeated ones are dropped, the active track is added. */
export function stackFromIndexes(
  indexes: readonly number[],
  tracks: readonly Track[],
  active: Track,
): Track[] {
  const stack = indexes.flatMap((i) => (tracks[i] ? [tracks[i]!] : []));
  return reconcileStack(stack, tracks, active);
}
