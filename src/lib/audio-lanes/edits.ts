import {
  CUT_FADE_MS,
  MAX_LANES,
  MIN_CLIP_MS,
  activeTake,
  clipEndMs,
  newId,
  newLane,
  normalizeClip,
} from "@/lib/audio-lanes/model";
import type { AudioClip, AudioLane, AudioLanesSettings, AudioSource } from "@/lib/tauri";

type Audio = AudioLanesSettings;

const mapLanes = (audio: Audio, fn: (lane: AudioLane) => AudioLane): Audio => ({
  ...audio,
  lanes: audio.lanes.map(fn),
});

const sortClips = (clips: AudioClip[]) => [...clips].sort((a, b) => a.startMs - b.startMs);

/** The lane holding a clip, with the clip. */
export function findClip(
  audio: Audio,
  clipId: string,
): { lane: AudioLane; clip: AudioClip } | null {
  for (const lane of audio.lanes) {
    const clip = lane.clips.find((c) => c.id === clipId);
    if (clip) return { lane, clip };
  }
  return null;
}

/** Adds a lane at the end (or nothing past `MAX_LANES`). */
export function addLane(
  audio: Audio,
  lane: AudioLane = newLane(`Audio ${audio.lanes.length + 1}`),
): Audio {
  if (audio.lanes.length >= MAX_LANES) return audio;
  return { ...audio, lanes: [...audio.lanes, lane] };
}

/** Removes a lane; a removed folder's children move to the top level. */
export function removeLane(audio: Audio, laneId: string): Audio {
  return {
    ...audio,
    lanes: audio.lanes
      .filter((l) => l.id !== laneId)
      .map((l) => (l.parent === laneId ? { ...l, parent: undefined } : l)),
  };
}

/** Changes some settings of a lane. */
export function updateLane(audio: Audio, laneId: string, patch: Partial<AudioLane>): Audio {
  return mapLanes(audio, (l) => (l.id === laneId ? { ...l, ...patch, id: l.id } : l));
}

/** Moves a lane to another place in the list. */
export function moveLane(audio: Audio, laneId: string, to: number): Audio {
  const from = audio.lanes.findIndex((l) => l.id === laneId);
  if (from < 0) return audio;
  const lanes = audio.lanes.filter((l) => l.id !== laneId);
  lanes.splice(Math.max(0, Math.min(to, lanes.length)), 0, audio.lanes[from]!);
  return { ...audio, lanes };
}

/** Adds a source once (the same file, by its hash, is stored once). */
export function addSource(audio: Audio, source: AudioSource): Audio {
  if (audio.sources.some((s) => s.id === source.id)) return audio;
  return { ...audio, sources: [...audio.sources, source] };
}

/** Puts a clip on a lane. */
export function addClip(audio: Audio, laneId: string, clip: AudioClip): Audio {
  return mapLanes(audio, (l) =>
    l.id === laneId && !l.folder
      ? withCrossfades({ ...l, clips: sortClips([...l.clips, normalizeClip(clip)]) })
      : l,
  );
}

/** Changes some settings of a clip. */
export function updateClip(audio: Audio, clipId: string, patch: Partial<AudioClip>): Audio {
  return mapLanes(audio, (l) =>
    l.clips.some((c) => c.id === clipId)
      ? {
          ...l,
          clips: sortClips(
            l.clips.map((c) => (c.id === clipId ? normalizeClip({ ...c, ...patch, id: c.id }) : c)),
          ),
        }
      : l,
  );
}

/** The lanes ripple editing moves for an edit on `laneId`. */
function rippleLanes(audio: Audio, laneId: string): Set<string> {
  if (audio.ripple === "all") return new Set(audio.lanes.map((l) => l.id));
  if (audio.ripple === "lane") return new Set([laneId]);
  return new Set();
}

/** Moves every unlocked clip on `lanes` that starts at or after `fromMs` by `deltaMs`. */
function shiftAfter(
  audio: Audio,
  lanes: Set<string>,
  fromMs: number,
  deltaMs: number,
  skip: Set<string>,
): Audio {
  if (lanes.size === 0 || deltaMs === 0) return audio;
  return mapLanes(audio, (l) =>
    lanes.has(l.id)
      ? {
          ...l,
          clips: l.clips.map((c) =>
            !skip.has(c.id) && !c.locked && c.startMs >= fromMs
              ? { ...c, startMs: Math.max(0, c.startMs + deltaMs) }
              : c,
          ),
        }
      : l,
  );
}

/** Deletes clips; with ripple on, later clips close the gap. */
export function removeClips(audio: Audio, clipIds: readonly string[]): Audio {
  const ids = new Set(clipIds);
  let next = audio;
  const removed = audio.lanes.flatMap((l) =>
    l.clips.filter((c) => ids.has(c.id)).map((c) => ({ lane: l.id, c })),
  );
  for (const { lane, c } of [...removed].sort((a, b) => b.c.startMs - a.c.startMs)) {
    next = shiftAfter(
      next,
      rippleLanes(next, lane),
      clipEndMs(c),
      -(clipEndMs(c) - c.startMs),
      ids,
    );
  }
  return mapLanes(next, (l) => ({ ...l, clips: l.clips.filter((c) => !ids.has(c.id)) }));
}

/**
 * Moves a clip to `startMs`, on `laneId` when given. Locked clips stay. Lanes in the same edit
 * group move their clips that start at the same time by the same amount.
 */
export function moveClip(audio: Audio, clipId: string, startMs: number, laneId?: string): Audio {
  const found = findClip(audio, clipId);
  if (!found || found.clip.locked) return audio;
  const delta = Math.max(0, startMs) - found.clip.startMs;
  const target =
    laneId && audio.lanes.some((l) => l.id === laneId && !l.folder) ? laneId : found.lane.id;
  const grouped = new Set(
    found.lane.group > 0
      ? audio.lanes
          .filter((l) => l.group === found.lane.group && l.id !== found.lane.id)
          .map((l) => l.id)
      : [],
  );
  const moved = { ...found.clip, startMs: found.clip.startMs + delta };
  const next = mapLanes(audio, (l) => {
    let clips = l.clips.filter((c) => c.id !== clipId);
    if (grouped.has(l.id) && target === found.lane.id) {
      clips = clips.map((c) =>
        !c.locked && c.startMs === found.clip.startMs ? { ...c, startMs: c.startMs + delta } : c,
      );
    }
    if (l.id === target) clips = [...clips, moved];
    return withCrossfades({ ...l, clips: sortClips(clips) });
  });
  return next;
}

/** Moves the start or the end of a clip inside its source; the other edge stays put. */
export function trimClip(audio: Audio, clipId: string, edge: "start" | "end", atMs: number): Audio {
  const found = findClip(audio, clipId);
  if (!found || found.clip.locked) return audio;
  const c = found.clip;
  const take = activeTake(c);
  if (edge === "end") {
    const lengthMs = Math.max(MIN_CLIP_MS, (atMs - c.startMs) * c.playrate);
    return updateClip(audio, clipId, { lengthMs });
  }
  const end = clipEndMs(c);
  const minStart = c.startMs - take.offsetMs / c.playrate;
  const start = Math.min(Math.max(atMs, minStart), end - MIN_CLIP_MS / c.playrate);
  const sourceDelta = (start - c.startMs) * c.playrate;
  return updateClip(audio, clipId, {
    startMs: start,
    lengthMs: c.lengthMs - sourceDelta,
    takes: c.takes.map((t) => ({ ...t, offsetMs: t.offsetMs + sourceDelta })),
  });
}

/**
 * Splits a clip at `atMs` on the timeline into two clips that play the same audio with no gap.
 * Each side of the cut gets a short fade so it does not click. The caller snaps `atMs` to a
 * zero crossing first (`nearestZeroCrossing` on the source peaks).
 */
export function splitClip(
  audio: Audio,
  clipId: string,
  atMs: number,
  ids: [string, string] = [newId(), newId()],
): Audio {
  const found = findClip(audio, clipId);
  if (!found || found.clip.locked) return audio;
  const c = found.clip;
  const cut = (atMs - c.startMs) * c.playrate;
  if (cut < MIN_CLIP_MS || c.lengthMs - cut < MIN_CLIP_MS) return audio;
  const left: AudioClip = {
    ...c,
    id: ids[0],
    lengthMs: cut,
    fadeOut: { ms: Math.min(CUT_FADE_MS, cut), shape: "equalPower" },
    envelope: c.envelope
      .filter((p) => p.at * c.lengthMs <= cut)
      .map((p) => ({ ...p, at: (p.at * c.lengthMs) / cut })),
  };
  const right: AudioClip = {
    ...c,
    id: ids[1],
    startMs: atMs,
    lengthMs: c.lengthMs - cut,
    takes: c.takes.map((t) => ({ ...t, offsetMs: t.offsetMs + cut })),
    fadeIn: { ms: Math.min(CUT_FADE_MS, c.lengthMs - cut), shape: "equalPower" },
    envelope: c.envelope
      .filter((p) => p.at * c.lengthMs >= cut)
      .map((p) => ({ ...p, at: (p.at * c.lengthMs - cut) / (c.lengthMs - cut) })),
  };
  return mapLanes(audio, (l) =>
    l.id === found.lane.id
      ? { ...l, clips: sortClips([...l.clips.filter((x) => x.id !== clipId), left, right]) }
      : l,
  );
}

/** Two clips play on from each other when the second starts where the first ends, in time and source. */
function continues(a: AudioClip, b: AudioClip): boolean {
  const ta = activeTake(a);
  const tb = activeTake(b);
  return (
    a.takes.length === 1 &&
    b.takes.length === 1 &&
    ta.sourceId === tb.sourceId &&
    a.playrate === b.playrate &&
    a.semitones === b.semitones &&
    a.cents === b.cents &&
    a.gainDb === b.gainDb &&
    a.reversed === b.reversed &&
    Math.abs(clipEndMs(a) - b.startMs) < 0.01 &&
    Math.abs(ta.offsetMs + a.lengthMs - tb.offsetMs) < 0.01
  );
}

/**
 * Joins clips (glue): runs of neighbours that continue each other become one clip, gapless, and
 * the inner cut fades go away.
 */
export function glueClips(audio: Audio, clipIds: readonly string[]): Audio {
  const ids = new Set(clipIds);
  return mapLanes(audio, (l) => {
    const clips: AudioClip[] = [];
    for (const c of l.clips) {
      const last = clips[clips.length - 1];
      if (last && ids.has(c.id) && ids.has(last.id) && continues(last, c)) {
        clips[clips.length - 1] = {
          ...last,
          lengthMs: last.lengthMs + c.lengthMs,
          fadeOut: c.fadeOut,
          envelope: [],
        };
      } else clips.push(c);
    }
    return clips.length === l.clips.length ? l : { ...l, clips };
  });
}

/** Copies of clips, placed `offsetMs` later (or right after the last one). */
export function duplicateClips(audio: Audio, clipIds: readonly string[], offsetMs?: number): Audio {
  const ids = new Set(clipIds);
  const chosen = audio.lanes.flatMap((l) => l.clips.filter((c) => ids.has(c.id)));
  if (chosen.length === 0) return audio;
  const first = Math.min(...chosen.map((c) => c.startMs));
  const last = Math.max(...chosen.map(clipEndMs));
  const delta = offsetMs ?? last - first;
  return mapLanes(audio, (l) => {
    const copies = l.clips
      .filter((c) => ids.has(c.id))
      .map((c) => ({ ...c, id: newId(), startMs: c.startMs + delta, locked: false }));
    return copies.length ? withCrossfades({ ...l, clips: sortClips([...l.clips, ...copies]) }) : l;
  });
}

/** Pastes copied clips on a lane, the first one at `atMs`. */
export function pasteClips(
  audio: Audio,
  laneId: string,
  clips: readonly AudioClip[],
  atMs: number,
): Audio {
  if (clips.length === 0) return audio;
  const first = Math.min(...clips.map((c) => c.startMs));
  return clips.reduce(
    (next, c) =>
      addClip(next, laneId, {
        ...c,
        id: newId(),
        startMs: atMs + c.startMs - first,
        locked: false,
      }),
    audio,
  );
}

/**
 * Overlapping neighbours crossfade: the later clip fades in and the earlier one fades out over
 * the overlap, with equal-power curves. Fades longer than the overlap are left as they are.
 */
export function withCrossfades(lane: AudioLane): AudioLane {
  const clips = lane.clips.map((c) => ({ ...c }));
  for (let i = 1; i < clips.length; i++) {
    const prev = clips[i - 1]!;
    const cur = clips[i]!;
    const overlap = clipEndMs(prev) - cur.startMs;
    if (overlap <= 0) continue;
    const ms = Math.min(overlap, prev.lengthMs, cur.lengthMs);
    if (cur.fadeIn.ms < ms) cur.fadeIn = { ms, shape: "equalPower" };
    if (prev.fadeOut.ms < ms) prev.fadeOut = { ms, shape: "equalPower" };
  }
  return { ...lane, clips };
}

/** Adds a take to a clip (a loop recording pass) and makes it the one heard. */
export function addTake(audio: Audio, clipId: string, take: AudioClip["takes"][number]): Audio {
  const found = findClip(audio, clipId);
  if (!found) return audio;
  const takes = [...found.clip.takes, take];
  return updateClip(audio, clipId, { takes, take: takes.length - 1 });
}

/** Picks which take a clip plays (comping: split the clip, then pick a take for each piece). */
export function chooseTake(audio: Audio, clipId: string, take: number): Audio {
  return updateClip(audio, clipId, { take });
}

/** Splits every clip on `laneIds` at both edges of a range, so the range can be edited alone. */
export function splitRange(
  audio: Audio,
  laneIds: readonly string[],
  startMs: number,
  endMs: number,
): Audio {
  const lanes = new Set(laneIds);
  let next = audio;
  for (const at of [startMs, endMs]) {
    const hit = next.lanes
      .filter((l) => lanes.has(l.id))
      .flatMap((l) => l.clips.filter((c) => c.startMs < at && clipEndMs(c) > at));
    for (const c of hit) next = splitClip(next, c.id, at);
  }
  return next;
}

/** The clips of `laneIds` inside a range (after `splitRange`). */
export function clipsInRange(
  audio: Audio,
  laneIds: readonly string[],
  startMs: number,
  endMs: number,
): string[] {
  const lanes = new Set(laneIds);
  return audio.lanes
    .filter((l) => lanes.has(l.id))
    .flatMap((l) =>
      l.clips
        .filter((c) => c.startMs >= startMs - 0.01 && clipEndMs(c) <= endMs + 0.01)
        .map((c) => c.id),
    );
}

/** Range edit: deletes the part of every clip on `laneIds` between `startMs` and `endMs`. */
export function deleteRange(
  audio: Audio,
  laneIds: readonly string[],
  startMs: number,
  endMs: number,
): Audio {
  const split = splitRange(audio, laneIds, startMs, endMs);
  return removeClips(split, clipsInRange(split, laneIds, startMs, endMs));
}

/** Range edit: moves the part of every clip on `laneIds` between the edges by `deltaMs`. */
export function moveRange(
  audio: Audio,
  laneIds: readonly string[],
  startMs: number,
  endMs: number,
  deltaMs: number,
): Audio {
  const split = splitRange(audio, laneIds, startMs, endMs);
  const ids = new Set(clipsInRange(split, laneIds, startMs, endMs));
  return mapLanes(split, (l) =>
    l.clips.some((c) => ids.has(c.id))
      ? withCrossfades({
          ...l,
          clips: sortClips(
            l.clips.map((c) =>
              ids.has(c.id) && !c.locked ? { ...c, startMs: Math.max(0, c.startMs + deltaMs) } : c,
            ),
          ),
        })
      : l,
  );
}

/** Makes a folder lane holding `laneIds` (their volume, mute and solo follow the folder). */
export function makeFolder(
  audio: Audio,
  name: string,
  laneIds: readonly string[],
  id: string = newId(),
): Audio {
  const withFolder = addLane(audio, { ...newLane(name, id), folder: true });
  if (withFolder === audio) return audio;
  const members = new Set(laneIds);
  return mapLanes(withFolder, (l) => (members.has(l.id) && !l.folder ? { ...l, parent: id } : l));
}
