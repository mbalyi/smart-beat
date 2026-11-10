import { clipsInRange, splitRange, withCrossfades } from "@/lib/audio-lanes/edits";
import type { AudioClip, AudioLanesSettings } from "@/lib/tauri";

type Audio = AudioLanesSettings;

/** A span of the audio timeline, in ms (`startMs` < `endMs`). */
export interface TimeRange {
  startMs: number;
  endMs: number;
}

/** The shortest time selection; anything shorter is a click, not a selection. */
export const MIN_RANGE_MS = 1;
/** Clip edges this close to a range edge count as on it (cuts land on floating-point times). */
const EDGE_MS = 0.01;

/** A range in order and on the timeline, or null when it is too short to be one. */
export function normalizeRange(range: TimeRange | null): TimeRange | null {
  if (!range) return null;
  const startMs = Math.max(0, Math.min(range.startMs, range.endMs));
  const endMs = Math.max(0, Math.max(range.startMs, range.endMs));
  return endMs - startMs >= MIN_RANGE_MS ? { startMs, endMs } : null;
}

/** The ids of every lane that holds clips (folders hold lanes). */
export const clipLaneIds = (audio: Audio): string[] =>
  audio.lanes.filter((l) => !l.folder).map((l) => l.id);

/**
 * Applies `fn` to the clips of the lanes in `laneIds`; a lane whose clips do not change keeps its
 * object, and nothing changing returns `audio` itself (so no empty undo step).
 */
function mapClips(
  audio: Audio,
  laneIds: ReadonlySet<string>,
  fn: (clips: readonly AudioClip[]) => AudioClip[],
): Audio {
  let changed = false;
  const lanes = audio.lanes.map((l) => {
    if (!laneIds.has(l.id)) return l;
    const clips = fn(l.clips);
    const same = clips.length === l.clips.length && clips.every((c, i) => c === l.clips[i]);
    if (same) return l;
    changed = true;
    return withCrossfades({ ...l, clips: [...clips].sort((a, b) => a.startMs - b.startMs) });
  });
  return changed ? { ...audio, lanes } : audio;
}

/** Moves every unlocked clip on every lane that starts at or after `fromMs` by `deltaMs`. */
function shiftFrom(audio: Audio, fromMs: number, deltaMs: number): Audio {
  return mapClips(audio, new Set(clipLaneIds(audio)), (clips) =>
    clips.map((c) =>
      !c.locked && c.startMs >= fromMs - EDGE_MS
        ? { ...c, startMs: Math.max(0, c.startMs + deltaMs) }
        : c,
    ),
  );
}

/** Splits every clip on `laneIds` that crosses an edge of the range (locked clips stay whole). */
export function splitAtRangeEdges(
  audio: Audio,
  laneIds: readonly string[],
  range: TimeRange,
): Audio {
  return splitRange(audio, laneIds, range.startMs, range.endMs);
}

/**
 * Trim to the selection: on `laneIds`, keeps only the parts of the clips inside the range. Clips
 * crossing an edge are cut there; locked clips stay as they are, inside or out.
 */
export function trimToRange(audio: Audio, laneIds: readonly string[], range: TimeRange): Audio {
  const split = splitAtRangeEdges(audio, laneIds, range);
  const inside = new Set(clipsInRange(split, laneIds, range.startMs, range.endMs));
  return mapClips(split, new Set(laneIds), (clips) =>
    clips.filter((c) => c.locked || inside.has(c.id)),
  );
}

/**
 * Removes the selection and closes the gap, on every lane: the parts of the clips inside the
 * range go, and every clip after it moves left by the range's length. Locked clips stay put.
 */
export function removeRangeClosingGap(audio: Audio, range: TimeRange): Audio {
  const laneIds = clipLaneIds(audio);
  const split = splitAtRangeEdges(audio, laneIds, range);
  const inside = new Set(clipsInRange(split, laneIds, range.startMs, range.endMs));
  const removed = mapClips(split, new Set(laneIds), (clips) =>
    clips.filter((c) => c.locked || !inside.has(c.id)),
  );
  return shiftFrom(removed, range.endMs, -(range.endMs - range.startMs));
}

/**
 * Inserts empty space at the selection, on every lane: clips crossing its start are cut there and
 * everything from its start on moves right by the range's length. Locked clips stay put.
 */
export function insertSpaceAtRange(audio: Audio, range: TimeRange): Audio {
  const split = splitRange(audio, clipLaneIds(audio), range.startMs, range.startMs);
  return shiftFrom(split, range.startMs, range.endMs - range.startMs);
}

/** "0:01.50": a timeline point for the selection label. */
export function formatRangeMs(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(2).padStart(5, "0")}`;
}

/** "0:01.50 – 0:03.00 (1.50 s)": start, end and length of a selection. */
export function describeRange(range: TimeRange): string {
  const length = ((range.endMs - range.startMs) / 1000).toFixed(2);
  return `${formatRangeMs(range.startMs)} – ${formatRangeMs(range.endMs)} (${length} s)`;
}
