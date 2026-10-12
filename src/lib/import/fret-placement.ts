/**
 * Playable string and fret placement for notes that only know their pitch (MIDI
 * files and recordings).
 *
 * Every note can sit on several strings. For each group of notes that start
 * together, the playable shapes are listed (one string per note, a hand span of
 * at most four frets). Then one pass over the whole part picks the cheapest
 * path: it keeps the hand near one position, prefers low frets and open
 * strings, and avoids stretched chords.
 */
import { MAX_FRET } from "@/lib/score/music";

/** Notes that start together, in time order. */
export interface PlacementGroup {
  pitches: number[];
}

/** A note on a string. `string` is alphaTab's number (1 = the lowest string); `pitch` is where it sounds. */
export interface Placed {
  pitch: number;
  string: number;
  fret: number;
}

export interface PlacedGroup {
  notes: Placed[];
  /** Pitches left out because no string can play them. */
  dropped: number[];
  /** Pitches moved an octave to fit the strings (the moved note is in `notes`). */
  shifted: number[];
}

export interface PlacementOptions {
  /** Capo fret. Frets are counted from the capo, as in the score. */
  capo?: number;
  maxFret?: number;
}

/** The widest hand span (in frets, open strings ignored), and the stretch allowed when nothing fits it. */
const MAX_SPAN = 4;
const STRETCH_SPAN = 5;
/** Octave moves tried for a note no string can play, in order. */
const OCTAVE_SHIFTS = [12, -12, 24, -24];

/** Cost per fret of hand movement, and the extra cost of each fret of a jump beyond JUMP_FREE. */
const SHIFT_STEP = 1;
const JUMP_FREE = 3;
const SHIFT_JUMP = 0.5;
/** Cost of the fret height: grows with the square of the fret, so high positions stay rare. */
const HEIGHT_WEIGHT = 0.01;
/** Cost of each fret of span inside a chord. */
const STRETCH_WEIGHT = 0.5;
/** Bonus (negative cost) for each open string. */
const OPEN_BONUS = 0.4;

/** Shapes kept per group, and the work allowed to find them. */
const MAX_OPTIONS = 16;
const MAX_VISITS = 20_000;

interface Option {
  notes: Placed[];
  dropped: number[];
  shifted: number[];
  /** Mean fretted fret, or null when every note is an open string. */
  position: number | null;
  /** Cost of the shape on its own. */
  own: number;
}

interface Item {
  pitch: number;
  original: number;
  candidates: { string: number; fret: number }[];
}

function shiftCost(from: number | null, to: number | null): number {
  if (from === null || to === null) return 0;
  const jump = Math.abs(from - to);
  return SHIFT_STEP * jump + SHIFT_JUMP * Math.max(0, jump - JUMP_FREE) ** 2;
}

/**
 * Places each group on the strings. `tuning` is highest string first, like the score's staff;
 * strings are numbered as in alphaTab (1 = the last of `tuning`).
 */
export function placeFrets(
  tuning: readonly number[],
  groups: readonly PlacementGroup[],
  options: PlacementOptions = {},
): PlacedGroup[] {
  const capo = options.capo ?? 0;
  const maxFret = options.maxFret ?? MAX_FRET;
  const open = tuning.map((pitch) => pitch + capo);

  const candidatesOf = (pitch: number) => {
    const found: { string: number; fret: number }[] = [];
    open.forEach((base, index) => {
      const fret = pitch - base;
      if (fret >= 0 && fret <= maxFret) found.push({ string: tuning.length - index, fret });
    });
    return found;
  };

  const optionsFor = (pitches: readonly number[]): Option[] => {
    const dropped: number[] = [];
    const shifted: number[] = [];
    const items: Item[] = [];
    for (const original of [...new Set(pitches)].sort((a, b) => b - a)) {
      let pitch = original;
      let candidates = candidatesOf(pitch);
      if (candidates.length === 0) {
        for (const shift of OCTAVE_SHIFTS) {
          candidates = candidatesOf(original + shift);
          if (candidates.length > 0) {
            pitch = original + shift;
            shifted.push(original);
            break;
          }
        }
      }
      if (candidates.length === 0) dropped.push(original);
      else items.push({ pitch, original, candidates });
    }

    // Shapes with as few skipped notes as possible: skip none first, then one, and so on.
    let found: { picks: (number | null)[]; span: number }[] = [];
    for (let skips = 0; skips <= items.length && found.length === 0; skips++) {
      found = [];
      const picks: (number | null)[] = [];
      const taken = new Set<number>();
      let visits = 0;
      const walk = (at: number, used: number, low: number, high: number) => {
        if (visits++ > MAX_VISITS) return;
        if (at === items.length) {
          if (used === skips) found.push({ picks: [...picks], span: high < low ? 0 : high - low });
          return;
        }
        if (used + (items.length - at) < skips) return;
        for (const [index, candidate] of items[at]!.candidates.entries()) {
          if (taken.has(candidate.string)) continue;
          let nextLow = low;
          let nextHigh = high;
          if (candidate.fret > 0) {
            nextLow = Math.min(low, candidate.fret);
            nextHigh = Math.max(high, candidate.fret);
            if (nextHigh - nextLow > STRETCH_SPAN) continue;
          }
          taken.add(candidate.string);
          picks.push(index);
          walk(at + 1, used, nextLow, nextHigh);
          picks.pop();
          taken.delete(candidate.string);
        }
        if (used < skips) {
          picks.push(null);
          walk(at + 1, used + 1, low, high);
          picks.pop();
        }
      };
      walk(0, 0, Infinity, -Infinity);
    }
    // A shape within four frets beats any wider one.
    if (found.some((shape) => shape.span <= MAX_SPAN)) {
      found = found.filter((shape) => shape.span <= MAX_SPAN);
    }

    const built = found.map(({ picks, span }): Option => {
      const notes: Placed[] = [];
      const skipped: number[] = [];
      picks.forEach((pick, i) => {
        const item = items[i]!;
        if (pick === null) {
          skipped.push(item.original);
          return;
        }
        const candidate = item.candidates[pick]!;
        notes.push({ pitch: item.pitch, string: candidate.string, fret: candidate.fret });
      });
      const fretted = notes.filter((note) => note.fret > 0);
      const position = fretted.length
        ? fretted.reduce((sum, note) => sum + note.fret, 0) / fretted.length
        : null;
      const height = notes.reduce((sum, note) => sum + note.fret ** 2, 0) / Math.max(1, notes.length);
      const opens = notes.length - fretted.length;
      return {
        notes,
        dropped: [...dropped, ...skipped],
        shifted: shifted.filter((p) => !skipped.includes(p)),
        position,
        own: HEIGHT_WEIGHT * height + STRETCH_WEIGHT * span - OPEN_BONUS * opens,
      };
    });
    built.sort((a, b) => a.own - b.own);
    if (built.length > 0) return built.slice(0, MAX_OPTIONS);
    return [{ notes: [], dropped, shifted: [], position: null, own: 0 }];
  };

  // The same chord comes up again and again: work out its shapes once.
  const cache = new Map<string, Option[]>();
  const all: Option[][] = groups.map((group) => {
    const key = [...new Set(group.pitches)].sort((a, b) => a - b).join(",");
    let shapes = cache.get(key);
    if (!shapes) {
      shapes = optionsFor(group.pitches);
      cache.set(key, shapes);
    }
    return shapes;
  });

  // Cheapest path: for each shape, the best shape before it. `hand` is where the hand is after it.
  const back: Uint8Array[] = [];
  let cost = new Float64Array(0);
  let hand: (number | null)[] = [];
  all.forEach((shapes, g) => {
    const nextCost = new Float64Array(shapes.length);
    const nextHand: (number | null)[] = new Array(shapes.length).fill(null);
    const pointer = new Uint8Array(shapes.length);
    shapes.forEach((shape, j) => {
      if (g === 0) {
        nextCost[j] = shape.own;
        nextHand[j] = shape.position;
        return;
      }
      let best = Infinity;
      let from = 0;
      for (let i = 0; i < cost.length; i++) {
        const total = cost[i]! + shiftCost(hand[i]!, shape.position);
        if (total < best) {
          best = total;
          from = i;
        }
      }
      nextCost[j] = best + shape.own;
      nextHand[j] = shape.position ?? hand[from]!;
      pointer[j] = from;
    });
    back.push(pointer);
    cost = nextCost;
    hand = nextHand;
  });

  const result: PlacedGroup[] = new Array(all.length);
  let pick = 0;
  for (let i = 1; i < cost.length; i++) if (cost[i]! < cost[pick]!) pick = i;
  for (let g = all.length - 1; g >= 0; g--) {
    const { notes, dropped, shifted } = all[g]![pick]!;
    result[g] = { notes: notes.map((n) => ({ ...n })), dropped: [...dropped], shifted: [...shifted] };
    pick = back[g]![pick]!;
  }
  return result;
}
