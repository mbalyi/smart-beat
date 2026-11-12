import type { AudioLane, AudioLanesSettings } from "@/lib/tauri";

/**
 * Selecting clips: by click (one, toggle, a range) and by a marquee rectangle across lane rows.
 *
 * The selection is a list of clip ids. Its last id is the anchor, the clip clicked last: a
 * Shift-click selects the range from there, and keeps the anchor last so the next Shift-click
 * extends from the same clip.
 */

/** What a click on a clip does to the selection. */
export type ClickMode = "single" | "toggle" | "range";

/** The click mode from the keys held: Shift selects a range, ⌘ or Ctrl toggles. */
export function clickMode(keys: {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}): ClickMode {
  if (keys.shiftKey) return "range";
  if (keys.metaKey || keys.ctrlKey) return "toggle";
  return "single";
}

/** The lanes whose clips can be clicked or framed: no folders and none in a closed folder. */
export function selectableLanes(audio: AudioLanesSettings): AudioLane[] {
  const closed = new Set(audio.lanes.filter((l) => l.folder && l.collapsed).map((l) => l.id));
  return audio.lanes.filter((l) => !l.folder && !(l.parent && closed.has(l.parent)));
}

/** Every clip id on one lane (⌘A on a clip). */
export function laneClipIds(audio: AudioLanesSettings, laneId: string): string[] {
  return audio.lanes.find((l) => l.id === laneId)?.clips.map((c) => c.id) ?? [];
}

/** Where a clip is among `lanes`: its lane's place and its start. */
function locate(lanes: readonly AudioLane[], clipId: string) {
  for (const [row, lane] of lanes.entries()) {
    const clip = lane.clips.find((c) => c.id === clipId);
    if (clip) return { row, startMs: clip.startMs };
  }
  return null;
}

/**
 * The clips from `anchorId` to `targetId`: on the lanes from the anchor's to the target's (in
 * the order given), those that start between the two clips' starts. The anchor comes last. When
 * the anchor is not on these lanes, only the target.
 */
export function rangeSelection(
  lanes: readonly AudioLane[],
  anchorId: string | undefined,
  targetId: string,
): string[] {
  const target = locate(lanes, targetId);
  const anchor = anchorId === undefined ? null : locate(lanes, anchorId);
  if (!target || !anchor || anchorId === undefined || anchorId === targetId) return [targetId];
  const [firstRow, lastRow] = [Math.min(anchor.row, target.row), Math.max(anchor.row, target.row)];
  const [fromMs, toMs] = [
    Math.min(anchor.startMs, target.startMs),
    Math.max(anchor.startMs, target.startMs),
  ];
  const ids = lanes
    .slice(firstRow, lastRow + 1)
    .flatMap((l) => l.clips)
    .filter((c) => c.startMs >= fromMs && c.startMs <= toMs)
    .sort((a, b) => a.startMs - b.startMs)
    .map((c) => c.id)
    .filter((id) => id !== anchorId);
  return [...ids, anchorId];
}

/** The selection after a click on `clipId`; `lanes` bound a range (shown lanes, in order). */
export function clickSelection(
  current: readonly string[],
  clipId: string,
  mode: ClickMode,
  lanes: readonly AudioLane[],
): string[] {
  if (mode === "toggle")
    return current.includes(clipId) ? current.filter((id) => id !== clipId) : [...current, clipId];
  if (mode === "range") return rangeSelection(lanes, current[current.length - 1], clipId);
  return [clipId];
}

/** A rectangle in screen pixels. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A lane row on screen: its top and bottom edge. */
export interface RowBox {
  laneId: string;
  top: number;
  bottom: number;
}

/** A clip on screen: its lane and its left and right edge. */
export interface ClipBox {
  id: string;
  laneId: string;
  left: number;
  right: number;
}

/** The rectangle between two points, whichever way it was dragged. */
export function boxBetween(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

/** The clips a rectangle touches: on a row it overlaps, and across the clip's x-range. */
export function clipsInBox(box: Box, rows: readonly RowBox[], clips: readonly ClipBox[]): string[] {
  const hitRows = new Set(
    rows.filter((r) => r.bottom >= box.top && r.top <= box.bottom).map((r) => r.laneId),
  );
  return clips
    .filter((c) => hitRows.has(c.laneId) && c.right >= box.left && c.left <= box.right)
    .map((c) => c.id);
}

/** The selection while framing: the clips hit, added to what was selected first when `additive`. */
export function marqueeSelection(
  base: readonly string[],
  hits: readonly string[],
  additive: boolean,
): string[] {
  return additive ? [...new Set([...base, ...hits])] : [...hits];
}

/** Whether two selections hold the same clips in the same order. */
export function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** What a screen reader hears about the selection. */
export function selectionLabel(count: number): string {
  if (count === 0) return "No clips selected";
  return count === 1 ? "1 clip selected" : `${count} clips selected`;
}
