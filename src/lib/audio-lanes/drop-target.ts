import { formatTime } from "@/lib/score/format";

/** A point of the window, in CSS pixels. */
export interface DropPoint {
  readonly x: number;
  readonly y: number;
}

/** The part of a lane element the drop maths reads (a real `HTMLElement` fits). */
export interface DropLaneElement {
  readonly dataset: {
    readonly laneId?: string;
    readonly pxPerBar?: string;
    readonly msPerPx?: string;
  };
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

/** What lies under a point: any element that can find its lane (a real `Element` fits). */
export interface DropHit {
  closest(selector: string): DropLaneElement | null;
}

/** Where a file dropped on an audio lane lands. */
export interface LaneDropTarget {
  laneId: string;
  /** The audio timeline position under the pointer, in ms (0 or more). */
  atMs: number;
  /** The lane's box in window pixels (for a highlight). */
  rect: { left: number; top: number; width: number; height: number };
  /** The element under the pointer, for callers that need it. */
  element: DropLaneElement;
}

/**
 * The lane under a point of the window and the time there. A lane element says how to read its
 * pixels: `data-px-per-bar` (the track list, on the song's bars: `msAtBar` maps a bar to
 * ms) or `data-ms-per-px` (the lane editor and studio, plain time). `x` counts from the lane's
 * own left edge, which is where its clips start.
 */
export function laneDropTarget(
  point: DropPoint,
  msAtBar: (bar: number) => number,
  elementAt: (x: number, y: number) => DropHit | null = (x, y) =>
    document.elementFromPoint?.(x, y) ?? null,
): LaneDropTarget | null {
  const lane = elementAt(point.x, point.y)?.closest("[data-lane-id]");
  const laneId = lane?.dataset.laneId;
  if (!lane || !laneId) return null;
  const rect = lane.getBoundingClientRect();
  const x = Math.max(0, point.x - rect.left);
  const perBar = Number(lane.dataset.pxPerBar);
  const perPx = Number(lane.dataset.msPerPx);
  const atMs = perBar > 0 ? msAtBar(x / perBar) : perPx > 0 ? x * perPx : 0;
  return { laneId, atMs: Math.max(0, atMs), rect, element: lane };
}

/** Whether two hits mark the same lane box (a pointer moving inside a lane changes nothing). */
export function sameDropTarget(a: LaneDropTarget | null, b: LaneDropTarget | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.laneId === b.laneId &&
    a.element === b.element &&
    a.rect.left === b.rect.left &&
    a.rect.top === b.rect.top &&
    a.rect.width === b.rect.width &&
    a.rect.height === b.rect.height
  );
}

/** What the chip says: "Drop to add to Bass · 0:42" (several files: "Drop to add 3 files to…"). */
export function dropLabel(laneName: string, ms: number, count = 1): string {
  const what = count > 1 ? `${count} files` : "";
  return `Drop to add ${what ? `${what} ` : ""}to ${laneName} · ${formatTime(ms)}`;
}
