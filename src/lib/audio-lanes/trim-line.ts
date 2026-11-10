import { trimClip } from "@/lib/audio-lanes/edits";
import { clipEndMs } from "@/lib/audio-lanes/model";
import type { AudioClip, AudioLanesSettings } from "@/lib/tauri";

/** Which edge of a clip moves to the line. */
export type TrimEdge = "start" | "end";

/** Whether the line at `atMs` runs through a clip (not on one of its edges). */
export const lineCrosses = (clip: AudioClip, atMs: number): boolean =>
  clip.startMs < atMs && clipEndMs(clip) > atMs;

/**
 * The clips a trim to the line at `atMs` acts on: of `ids` (none: every clip), the unlocked ones
 * the line runs through.
 */
export function clipsUnderLine(
  audio: AudioLanesSettings,
  ids: readonly string[],
  atMs: number,
): AudioClip[] {
  return audio.lanes
    .flatMap((lane) => lane.clips)
    .filter(
      (clip) =>
        (ids.length === 0 || ids.includes(clip.id)) && !clip.locked && lineCrosses(clip, atMs),
    );
}

/**
 * Trims the start (deletes what is left of the line) or the end (deletes what is right of it) of
 * every clip the line at `atMs` runs through: of `ids`, or every clip when `ids` is empty. Locked
 * clips stay as they are. Returns `audio` itself when no clip is trimmed.
 */
export function trimToLine(
  audio: AudioLanesSettings,
  ids: readonly string[],
  edge: TrimEdge,
  atMs: number,
): AudioLanesSettings {
  return clipsUnderLine(audio, ids, atMs).reduce(
    (next, clip) => trimClip(next, clip.id, edge, atMs),
    audio,
  );
}
