/** Copy-drag and slip edits on clips: pure and immutable, like the other lane edits. */
import { addClip, findClip, updateClip } from "@/lib/audio-lanes/edits";
import { newId } from "@/lib/audio-lanes/model";
import type { AudioClip, AudioLanesSettings } from "@/lib/tauri";

type Audio = AudioLanesSettings;

/** Looks up how long a source file is, in ms (undefined while it is not loaded). */
export type SourceDuration = (sourceId: string) => number | undefined;

/**
 * A copy of a clip at `startMs`, on `laneId` when it is a lane that holds clips (else the clip's
 * own lane). The original stays; overlaps crossfade as after a move. Locked clips are not copied.
 */
export function copyClipTo(
  audio: Audio,
  clipId: string,
  startMs: number,
  laneId?: string,
  id: string = newId(),
): Audio {
  const found = findClip(audio, clipId);
  if (!found || found.clip.locked) return audio;
  const target =
    laneId && audio.lanes.some((l) => l.id === laneId && !l.folder) ? laneId : found.lane.id;
  return addClip(audio, target, { ...found.clip, id, startMs: Math.max(0, startMs) });
}

/** The index of the take a clip plays (the first one when `take` points at none). */
const activeIndex = (clip: AudioClip) => (clip.takes[clip.take] ? clip.take : 0);

/**
 * The clip with its audio slid `deltaMs` along the timeline inside it (later for a positive
 * delta): the clip stays where it is and its active take starts elsewhere in its file. A
 * reversed clip plays its file backwards, so its offset moves the other way. Stretch markers are
 * relative to the clip and stay. The offset is clamped so the clip never reads before the start
 * of its file, nor past its end when the file's duration is known.
 */
export function slippedClip(
  clip: AudioClip,
  deltaMs: number,
  sourceDurationMs?: number,
): AudioClip {
  const index = activeIndex(clip);
  const take = clip.takes[index];
  if (!take || !Number.isFinite(deltaMs)) return clip;
  // The offset is in source ms; the clip plays its source at its (average) playrate.
  const shift = deltaMs * clip.playrate;
  const wanted = clip.reversed ? take.offsetMs + shift : take.offsetMs - shift;
  const latest =
    sourceDurationMs === undefined ? Infinity : Math.max(0, sourceDurationMs - clip.lengthMs);
  const offsetMs = Math.min(latest, Math.max(0, wanted));
  if (offsetMs === take.offsetMs) return clip;
  return {
    ...clip,
    takes: clip.takes.map((t, i) => (i === index ? { ...t, offsetMs } : t)),
  };
}

/** Slides the audio of a clip `deltaMs` inside it (a slip edit). Locked clips stay as they are. */
export function slipClip(
  audio: Audio,
  clipId: string,
  deltaMs: number,
  durationOf: SourceDuration = () => undefined,
): Audio {
  const found = findClip(audio, clipId);
  if (!found || found.clip.locked) return audio;
  const clip = found.clip;
  const index = activeIndex(clip);
  const slipped = slippedClip(clip, deltaMs, durationOf(clip.takes[index]?.sourceId ?? ""));
  return slipped === clip ? audio : updateClip(audio, clipId, { takes: slipped.takes });
}
