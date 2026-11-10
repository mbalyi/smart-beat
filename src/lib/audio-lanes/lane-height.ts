import type { AudioLane, AudioLanesSettings } from "@/lib/tauri";

/** A studio lane row's height range and default, px (mirrored in `src-tauri/src/audio_lanes.rs`). */
export const MIN_LANE_HEIGHT = 40;
export const MAX_LANE_HEIGHT = 240;
export const DEFAULT_LANE_HEIGHT = 80;
/** Below this height a studio lane header shows only the name, mute and solo. */
export const COMPACT_LANE_HEIGHT = 64;

/** Which lanes a resize changes: the one dragged, it and the selected ones, or every lane. */
export type ResizeScope = "lane" | "selected" | "all";

/** A saved lane height in range and whole pixels; anything that is not a number is dropped. */
export function normalizeLaneHeight(height: unknown): number | undefined {
  if (typeof height !== "number" || !Number.isFinite(height)) return undefined;
  return Math.round(Math.min(MAX_LANE_HEIGHT, Math.max(MIN_LANE_HEIGHT, height)));
}

/** The height a lane row shows at. */
export function laneHeight(lane: Pick<AudioLane, "height">): number {
  return normalizeLaneHeight(lane.height) ?? DEFAULT_LANE_HEIGHT;
}

/** The scope of a resize from the keys held: ⌥/Alt the selected lanes, Shift every lane. */
export function resizeScope(keys: {
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}): ResizeScope {
  if (keys.shiftKey) return "all";
  return keys.altKey ? "selected" : "lane";
}

/**
 * The lanes a resize of `laneId` changes: that lane, with `selected` also the lanes that hold a
 * selected clip, with `all` every lane. Folder lanes keep their own height.
 */
export function resizeTargets(
  audio: AudioLanesSettings,
  laneId: string,
  selection: readonly string[],
  scope: ResizeScope,
): string[] {
  return audio.lanes
    .filter((l) => !l.folder)
    .filter(
      (l) =>
        l.id === laneId ||
        scope === "all" ||
        (scope === "selected" && l.clips.some((c) => selection.includes(c.id))),
    )
    .map((l) => l.id);
}

/** Lanes `ids` at `height` (in range); `undefined` takes them back to the default height. */
export function setLaneHeights(
  audio: AudioLanesSettings,
  ids: readonly string[],
  height: number | undefined,
): AudioLanesSettings {
  const next = normalizeLaneHeight(height);
  const changes = audio.lanes.some((l) => ids.includes(l.id) && l.height !== next);
  if (!changes) return audio;
  return {
    ...audio,
    // An unset height is left out of the saved file (JSON drops `undefined`).
    lanes: audio.lanes.map((l) => (ids.includes(l.id) ? { ...l, height: next } : l)),
  };
}
