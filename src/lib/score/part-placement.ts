/**
 * Dropping a transcribed part on the score (#235): which tracks take which part, which bar and
 * track are under a point, how far the view scrolls near its edge, and how the keyboard moves
 * the part about. Pure, so it can be tested without alphaTab.
 */
import type { RecordInstrument } from "@/lib/audio/record-prefs";

/** A rectangle in the score's pixels (from the top left of the notation). */
export interface BoxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One bar of one track as drawn (a track drawn on two staves has two rectangles per bar). */
export interface PlacementRect {
  /** An index into the song's tracks. */
  track: number;
  /** 0-based. */
  bar: number;
  rect: BoxRect;
}

/** A bar and a track under the pointer. */
export interface PlacementSpot {
  track: number;
  bar: number;
}

/** Which kind of track takes a part: drum parts only on drum tracks, everything else on strings or keys. */
export function acceptsPart(instrument: RecordInstrument, trackKind: string): boolean {
  if (instrument === "drums") return trackKind === "drums";
  return trackKind === "stringed" || trackKind === "pitched";
}

/** The distance from a point to a rectangle (0 inside it). */
export function rectDistance(rect: BoxRect, x: number, y: number): number {
  const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.w));
  const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.h));
  return Math.hypot(dx, dy);
}

/** A point further than this from every bar is on no bar (px). */
export const PLACEMENT_REACH = 48;

/**
 * The bar and track nearest to a point: the staff by height (the nearest one between two staves)
 * and the bar by x, also in the gap between two bars or beside the last bar of a line. Null when
 * the point is far from every bar, or when no bars are drawn.
 */
export function nearestPlacement(
  rects: readonly PlacementRect[] | null,
  x: number,
  y: number,
  reach = PLACEMENT_REACH,
): PlacementSpot | null {
  if (!rects || rects.length === 0) return null;
  let best: PlacementRect | null = null;
  let bestDistance = Infinity;
  for (const entry of rects) {
    const distance = rectDistance(entry.rect, x, y);
    // On a tie the earlier bar wins, so the answer does not flicker between two staves.
    if (distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }
  return best && bestDistance <= reach ? { track: best.track, bar: best.bar } : null;
}

/** The rectangles of the bars `first` to `last` of a track, to outline where a part lands. */
export function placementBoxes(
  rects: readonly PlacementRect[],
  track: number,
  first: number,
  last: number,
): BoxRect[] {
  return rects
    .filter((r) => r.track === track && r.bar >= first && r.bar <= last)
    .map((r) => r.rect);
}

/** The tracks that are drawn, in the order they are drawn (top to bottom). */
export function drawnTracks(rects: readonly PlacementRect[]): number[] {
  const tops = new Map<number, number>();
  for (const { track, rect } of rects) {
    tops.set(track, Math.min(tops.get(track) ?? Infinity, rect.y));
  }
  return [...tops.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([track]) => track);
}

/** The bars drawn for a track, in order. */
export function drawnBars(rects: readonly PlacementRect[], track: number): number[] {
  return [...new Set(rects.filter((r) => r.track === track).map((r) => r.bar))].sort(
    (a, b) => a - b,
  );
}

/**
 * How far to scroll (px per frame) when the pointer is near an edge of the view: a quadratic
 * ramp from nothing at `edge` px inside the view to `maxSpeed` at its edge and beyond.
 * Negative towards the start.
 */
export function autoScrollDelta(pos: number, min: number, max: number, edge = 56, maxSpeed = 28) {
  const ramp = (depth: number) => Math.min(1, Math.max(0, depth / edge)) ** 2 * maxSpeed;
  if (pos < min + edge) return -ramp(min + edge - pos);
  if (pos > max - edge) return ramp(pos - (max - edge));
  return 0;
}

/** The keys that move a picked-up part. */
export type PlacementKey =
  "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "PageUp" | "PageDown" | "Home" | "End";

export const PLACEMENT_KEYS: readonly string[] = [
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
];

/**
 * Where a key moves a part: a bar left or right, four with Page Up and Down, to the first or
 * last bar with Home and End, and to the next track up or down (only tracks that take the part).
 * Always lands on a drawn bar of a drawn track.
 */
export function moveSpot(
  from: PlacementSpot,
  key: PlacementKey,
  rects: readonly PlacementRect[],
  accepts: (track: number) => boolean,
): PlacementSpot {
  const tracks = drawnTracks(rects).filter(accepts);
  const bars = drawnBars(rects, from.track);
  const last = bars.length > 0 ? bars[bars.length - 1]! : from.bar;
  const first = bars.length > 0 ? bars[0]! : from.bar;
  const clampBar = (bar: number) => Math.min(last, Math.max(first, bar));
  switch (key) {
    case "ArrowLeft":
      return { ...from, bar: clampBar(from.bar - 1) };
    case "ArrowRight":
      return { ...from, bar: clampBar(from.bar + 1) };
    case "PageUp":
      return { ...from, bar: clampBar(from.bar - 4) };
    case "PageDown":
      return { ...from, bar: clampBar(from.bar + 4) };
    case "Home":
      return { ...from, bar: first };
    case "End":
      return { ...from, bar: last };
    case "ArrowUp":
    case "ArrowDown": {
      const at = tracks.indexOf(from.track);
      const next = tracks[at + (key === "ArrowUp" ? -1 : 1)];
      if (next === undefined) return from;
      const nextBars = drawnBars(rects, next);
      const bar = Math.min(nextBars[nextBars.length - 1] ?? from.bar, from.bar);
      return { track: next, bar };
    }
  }
}

/** The first spot for a part picked up with the keyboard: the wanted bar on the wanted track if it is drawn, else the nearest. */
export function firstSpot(
  rects: readonly PlacementRect[],
  accepts: (track: number) => boolean,
  want: { track: number | null; bar: number },
): PlacementSpot | null {
  const tracks = drawnTracks(rects).filter(accepts);
  if (tracks.length === 0) return null;
  const track = want.track !== null && tracks.includes(want.track) ? want.track : tracks[0]!;
  const bars = drawnBars(rects, track);
  if (bars.length === 0) return null;
  const bar = bars.reduce((best, b) =>
    Math.abs(b - want.bar) < Math.abs(best - want.bar) ? b : best,
  );
  return { track, bar };
}
