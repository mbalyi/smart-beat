import { findClip } from "@/lib/audio-lanes/edits";
import type { LaneToTabRequest } from "@/lib/audio-lanes/lane-transcribe-request";
import { clipEndMs } from "@/lib/audio-lanes/model";
import type { AudioLanesSettings } from "@/lib/tauri";

/**
 * The request for "Convert audio to sheet…" on a clip (#235). `clickedClipId` is the clip the
 * menu was opened on; `selection` is the selected clip ids. When the clicked clip is part of a
 * larger selection, the request covers the selected clips on the clicked clip's lane (a request
 * is for one lane; clips on other lanes are left out). Its range is the union of the clips as
 * placed, `startMs` to `clipEndMs` (so playrate and stretch need no special case). Null when the
 * clip no longer exists.
 */
export function clipsToRequest(
  audio: AudioLanesSettings,
  clickedClipId: string,
  selection: readonly string[] = [],
): LaneToTabRequest | null {
  const clicked = findClip(audio, clickedClipId);
  if (!clicked) return null;
  const wanted = new Set(selection.includes(clickedClipId) ? selection : [clickedClipId]);
  const clips = clicked.lane.clips.filter((c) => wanted.has(c.id));
  // The clicked clip is always in `clips`; the filter above keeps lane order (by start).
  return {
    laneId: clicked.lane.id,
    clipIds: clips.map((c) => c.id),
    range: {
      startMs: Math.min(...clips.map((c) => c.startMs)),
      endMs: Math.max(...clips.map(clipEndMs)),
    },
    origin: "clip",
  };
}

/** The request for a time range on `laneId`, clamped to the timeline (null when it is empty). */
export function rangeToRequest(
  laneId: string,
  range: { startMs: number; endMs: number },
  origin: "selection" | "studio",
): LaneToTabRequest | null {
  const startMs = Math.max(0, Math.min(range.startMs, range.endMs));
  const endMs = Math.max(0, Math.max(range.startMs, range.endMs));
  if (!(endMs > startMs)) return null;
  return { laneId, clipIds: [], range: { startMs, endMs }, origin };
}

/** The request for a whole lane. */
export const laneToRequest = (laneId: string): LaneToTabRequest => ({
  laneId,
  clipIds: [],
  range: null,
  origin: "lane",
});

/**
 * The lane a time selection over several lanes is converted from: the first lane (of `laneIds`)
 * with a clip inside the range, else the first lane of `laneIds` (folders never count).
 */
export function laneForRange(
  audio: AudioLanesSettings,
  laneIds: readonly string[],
  range: { startMs: number; endMs: number },
): string | null {
  const lanes = laneIds
    .map((id) => audio.lanes.find((l) => l.id === id))
    .filter((l): l is AudioLanesSettings["lanes"][number] => !!l && !l.folder);
  const hit = lanes.find((l) =>
    l.clips.some((c) => c.startMs < range.endMs && clipEndMs(c) > range.startMs),
  );
  return (hit ?? lanes[0])?.id ?? null;
}
