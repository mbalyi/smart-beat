/**
 * Finding the real rhythm grid of a MIDI file whose notes do not follow its own tempo.
 *
 * Files recorded live or converted from audio often say one tempo (usually 120 BPM)
 * while the music runs at another, and drift a little. Snapping such notes to the
 * file's own sixteenth notes drifts through the bars: notes land a sixteenth early or
 * late and every bar seems to start with a rest. This module measures the real
 * sixteenth from the note onsets, follows small tempo drift, and finds where the bars
 * start, so the onsets can be moved onto a clean grid.
 */

/** A note onset: its tick, pitch and whether it is a drum. */
export interface Onset {
  tick: number;
  pitch: number;
  drum: boolean;
}

export interface Grid {
  /** Moves a tick of the file onto the clean grid (in the same tick units). */
  map: (tick: number) => number;
  /** How much faster the music is than the file's tempo (122 / 120 for 122 BPM). */
  speed: number;
}

/** Fewer onsets than this are not enough to measure a grid. */
const MIN_ONSETS = 24;
/** Onsets closer than this (in sixteenths) to the file's own grid fit it. */
const FITS = 0.08;
/** How far from the file's tempo the real one may be. */
const RANGE = 0.15;
/** Onsets per window when measuring how well a grid fits. */
const WINDOW = 48;
/** How much of an onset's deviation moves the grid (phase) and its speed. */
const PHASE_GAIN = 0.35;
const SPEED_GAIN = 0.005;

const KICKS = new Set([35, 36]);
const SNARES = new Set([37, 38, 40]);

/** Mean distance (in sixteenths) of the onsets from the grid `step` starting at `phase`. */
function meanError(ticks: readonly number[], step: number, phase: number) {
  let sum = 0;
  for (const tick of ticks) {
    const k = (tick - phase) / step;
    sum += Math.abs(k - Math.round(k));
  }
  return sum / ticks.length;
}

/**
 * How well `step` fits, from 0 to 1: the mean phase agreement of the onsets in short
 * windows, so a slowly drifting performance still scores high.
 */
function coherence(ticks: readonly number[], step: number) {
  let total = 0;
  let windows = 0;
  for (let i = 0; i < ticks.length; i += WINDOW) {
    let x = 0;
    let y = 0;
    const end = Math.min(ticks.length, i + WINDOW);
    for (let j = i; j < end; j++) {
      const angle = (2 * Math.PI * ticks[j]!) / step;
      x += Math.cos(angle);
      y += Math.sin(angle);
    }
    total += Math.hypot(x, y);
    windows += end - i;
  }
  return total / windows;
}

/** The tick of the grid line nearest the first onsets, for a grid of `step`. */
function phaseOf(ticks: readonly number[], step: number) {
  let x = 0;
  let y = 0;
  for (const tick of ticks.slice(0, WINDOW)) {
    const angle = (2 * Math.PI * tick) / step;
    x += Math.cos(angle);
    y += Math.sin(angle);
  }
  const offset = (Math.atan2(y, x) / (2 * Math.PI)) * step;
  // The grid line at or before the first onset.
  return offset + Math.floor((ticks[0]! - offset) / step + 0.5) * step;
}

/** Follows the grid through the onsets: (tick, sixteenth) points of the grid lines. */
function track(ticks: readonly number[], start: number, step: number) {
  const points: [number, number][] = [[start, 0]];
  let at = start;
  let index = 0;
  let size = step;
  for (const tick of ticks) {
    const k = index + (tick - at) / size;
    const nearest = Math.round(k);
    if (nearest <= index) continue; // the same grid line (a chord played a little apart)
    const span = nearest - index;
    const expected = at + span * size;
    const deviation = tick - expected;
    size = Math.min(
      step * (1 + RANGE),
      Math.max(step * (1 - RANGE), size + (SPEED_GAIN * deviation) / span),
    );
    at = expected + PHASE_GAIN * deviation;
    index = nearest;
    points.push([at, index]);
  }
  return { points, size };
}

/** How strongly the onsets suggest that sixteenth `phase` starts a bar of `barSteps`. */
function downbeatScore(
  steps: readonly { step: number; onsets: Onset[] }[],
  phase: number,
  barSteps: number,
  beatSteps: number,
) {
  let score = 0;
  for (const { step, onsets } of steps) {
    const position = (((step + phase) % barSteps) + barSteps) % barSteps;
    const beat = position % beatSteps === 0 ? position / beatSteps : -1;
    for (const onset of onsets) {
      if (onset.drum && KICKS.has(onset.pitch)) score += beat === 0 ? 4 : beat > 0 ? 1 : -1;
      else if (onset.drum && SNARES.has(onset.pitch))
        score += beat > 0 && beat % 2 === 1 ? 3 : beat === 0 ? -1 : 0;
      else if (position === 0) score += 2;
      else if (beat > 0) score += 1;
      else if (position % 2 === 1) score -= 0.5;
    }
  }
  return score;
}

/**
 * The clean grid for `onsets`, or null when they already follow the file's own grid of
 * `step` ticks (a sixteenth) or no steady grid is found. `barSteps` and `beatSteps` are
 * the bar and beat lengths in sixteenths.
 */
export function findGrid(
  onsets: readonly Onset[],
  step: number,
  barSteps: number,
  beatSteps: number,
): Grid | null {
  const ticks = [...new Set(onsets.map((onset) => onset.tick))].sort((a, b) => a - b);
  if (ticks.length < MIN_ONSETS) return null;
  if (meanError(ticks, step, 0) <= FITS) return null;

  let best = { size: step, fit: -1 };
  const tries = 1200;
  for (let i = 0; i <= tries; i++) {
    const size = step * (1 - RANGE + (2 * RANGE * i) / tries);
    const fit = coherence(ticks, size);
    if (fit > best.fit) best = { size, fit };
  }
  const { points, size: endSize } = track(ticks, phaseOf(ticks, best.size), best.size);
  if (points.length < 2) return null;

  const at = (tick: number) => {
    // The (fractional) sixteenth of a tick, between the grid lines around it.
    if (tick <= points[0]![0]) return points[0]![1] - (points[0]![0] - tick) / best.size;
    const last = points.at(-1)!;
    if (tick >= last[0]) return last[1] + (tick - last[0]) / endSize;
    let low = 0;
    let high = points.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (points[middle]![0] <= tick) low = middle;
      else high = middle;
    }
    const [t0, k0] = points[low]!;
    const [t1, k1] = points[high]!;
    return k0 + ((tick - t0) / (t1 - t0)) * (k1 - k0);
  };

  // The fit must be clearly better than the file's own grid.
  let error = 0;
  for (const tick of ticks) {
    const k = at(tick);
    error += Math.abs(k - Math.round(k));
  }
  if (error / ticks.length > meanError(ticks, step, 0) * 0.6) return null;

  // Where the bars start: keep about as much silence before the first note as the file has.
  const bySteps = new Map<number, Onset[]>();
  for (const onset of onsets) {
    const k = Math.round(at(onset.tick));
    const list = bySteps.get(k) ?? [];
    list.push(onset);
    bySteps.set(k, list);
  }
  const steps = [...bySteps].map(([k, list]) => ({ step: k, onsets: list }));
  let phase = 0;
  let top = -Infinity;
  for (let p = 0; p < barSteps; p++) {
    const score = downbeatScore(steps, p, barSteps, beatSteps);
    if (score > top) {
      top = score;
      phase = p;
    }
  }
  // Grid line k ends up at sixteenth k + shift, and bars start where k + phase is a
  // whole bar, so shift is phase plus whole bars: as many as the silence before the
  // first note in the file.
  const lead = points[0]![0] / best.size;
  let shift = phase + Math.round((lead - phase) / barSteps) * barSteps;
  if (shift < 0) shift += barSteps;

  const span = points.at(-1)![1] - points[0]![1];
  const size = span > 0 ? (points.at(-1)![0] - points[0]![0]) / span : best.size;
  return {
    map: (tick) => Math.max(0, (at(tick) + shift) * step),
    speed: step / size,
  };
}
