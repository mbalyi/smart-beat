import {
  CUT_FADE_MS,
  MAX_LANES,
  MIN_CLIP_MS,
  NO_FADE,
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

/**
 * Shows a lane under the tabs in the continuous view or hides it there (it stays in the track
 * list). Hidden clears the flag rather than storing `false`. A folder carries its children: they
 * are set, the folder itself is not (it follows its children).
 */
export function setLaneInScore(audio: Audio, laneId: string, shown: boolean): Audio {
  const target = audio.lanes.find((l) => l.id === laneId);
  if (!target) return audio;
  const ids = new Set(
    target.folder ? audio.lanes.filter((l) => l.parent === laneId).map((l) => l.id) : [laneId],
  );
  return mapLanes(audio, (l) => {
    if (!ids.has(l.id)) return l;
    const next: AudioLane = { ...l, shownInScore: true };
    if (!shown) delete next.shownInScore;
    return next;
  });
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

/** How long a clip lasts on the timeline. */
export const clipDuration = (c: AudioClip): number => c.lengthMs / c.playrate;

/**
 * Source ms played (from the clip's start in its file, in playing order) at `t` ms into the clip
 * on the timeline: piecewise linear through the stretch markers, as the engine reads it
 * (`ClipPlan::source_into`). Outside the clip it runs on at the playrate.
 */
export function clipSourceAt(c: AudioClip, t: number): number {
  const duration = clipDuration(c);
  const points = [
    { clipMs: 0, sourceMs: 0 },
    ...c.stretch,
    { clipMs: duration, sourceMs: c.lengthMs },
  ];
  if (t <= 0) return t * c.playrate;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (t <= b.clipMs) {
      const span = b.clipMs - a.clipMs;
      return span <= 0
        ? b.sourceMs
        : a.sourceMs + ((t - a.clipMs) * (b.sourceMs - a.sourceMs)) / span;
    }
  }
  return c.lengthMs + (t - duration) * c.playrate;
}

/** The envelope gain (dB) at `x` (0 … 1 along the clip): linear between points, held outside. */
function envelopeAt(points: AudioClip["envelope"], x: number): number {
  if (points.length === 0) return 0;
  if (x <= points[0]!.at) return points[0]!.db;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (x <= b.at) return b.at > a.at ? a.db + ((x - a.at) * (b.db - a.db)) / (b.at - a.at) : b.db;
  }
  return points[points.length - 1]!.db;
}

/**
 * The part of a clip between `from` and `to` ms of its timeline, as a clip of its own that plays
 * exactly that audio: the takes' offsets (mirrored for a reversed clip, which plays its range
 * backwards), the stretch markers inside, and the gain envelope with its values at the new ends.
 * A stretched clip gets the playrate that keeps the part's length on the timeline.
 */
export function sliceClip(c: AudioClip, from: number, to: number, id: string = c.id): AudioClip {
  const duration = clipDuration(c);
  const sa = clipSourceAt(c, from);
  const sb = clipSourceAt(c, to);
  const lengthMs = sb - sa;
  const span = to - from;
  const fraction = (x: number) => (x * duration - from) / span;
  const envelope = c.envelope.length
    ? [
        { at: 0, db: envelopeAt(c.envelope, from / duration) },
        ...c.envelope
          .map((p) => ({ at: fraction(p.at), db: p.db }))
          .filter((p) => p.at > 0 && p.at < 1),
        { at: 1, db: envelopeAt(c.envelope, to / duration) },
      ]
    : [];
  return {
    ...c,
    id,
    startMs: c.startMs + from,
    lengthMs,
    playrate: c.stretch.length ? lengthMs / span : c.playrate,
    takes: c.takes.map((t) => ({
      ...t,
      offsetMs: c.reversed ? t.offsetMs + (c.lengthMs - sb) : t.offsetMs + sa,
    })),
    stretch: c.stretch
      .filter((m) => m.clipMs > from && m.clipMs < to)
      .map((m) => ({ clipMs: m.clipMs - from, sourceMs: m.sourceMs - sa })),
    envelope,
  };
}

/** Moves the start or the end of a clip inside its source; the other edge stays put. */
export function trimClip(audio: Audio, clipId: string, edge: "start" | "end", atMs: number): Audio {
  const found = findClip(audio, clipId);
  if (!found || found.clip.locked) return audio;
  const c = found.clip;
  const duration = clipDuration(c);
  const offset = Math.min(...c.takes.map((t) => t.offsetMs));
  // How far the clip can grow before its file runs out at the front (the file's end is unknown).
  const room = offset / c.playrate;
  const minLength = MIN_CLIP_MS / c.playrate;
  const sliced =
    edge === "end"
      ? sliceClip(
          c,
          0,
          Math.min(Math.max(atMs - c.startMs, minLength), c.reversed ? duration + room : Infinity),
        )
      : sliceClip(
          c,
          Math.max(
            Math.min(atMs - c.startMs, duration - minLength),
            c.reversed ? -Infinity : -room,
          ),
          duration,
        );
  return updateClip(audio, clipId, { ...sliced, id: c.id });
}

/**
 * Splits a clip at `atMs` on the timeline into two clips that play the same audio with no gap.
 * Each side of the cut gets a short fade so it does not click. The caller snaps `atMs` to a
 * zero crossing first (`audioZeroCrossing`).
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
  const at = atMs - c.startMs;
  const duration = clipDuration(c);
  const left = sliceClip(c, 0, at, ids[0]);
  const right = sliceClip(c, at, duration, ids[1]);
  if (left.lengthMs < MIN_CLIP_MS || right.lengthMs < MIN_CLIP_MS) return audio;
  const cut = (ms: number) => ({ ms: Math.min(CUT_FADE_MS, ms), shape: "equalPower" as const });
  return mapLanes(audio, (l) =>
    l.id === found.lane.id
      ? {
          ...l,
          clips: sortClips([
            ...l.clips.filter((x) => x.id !== clipId),
            { ...left, fadeOut: cut(left.lengthMs) },
            { ...right, fadeIn: cut(right.lengthMs) },
          ]),
        }
      : l,
  );
}

/**
 * Two clips play on from each other: the second starts where the first ends on the timeline and
 * in the file (going backwards for reversed clips), with the same settings and no stretch markers.
 */
function continues(a: AudioClip, b: AudioClip): boolean {
  const ta = activeTake(a);
  const tb = activeTake(b);
  const sameSettings =
    a.takes.length === 1 &&
    b.takes.length === 1 &&
    ta.sourceId === tb.sourceId &&
    a.playrate === b.playrate &&
    a.semitones === b.semitones &&
    a.cents === b.cents &&
    a.gainDb === b.gainDb &&
    a.reversed === b.reversed &&
    a.mute === b.mute &&
    a.locked === b.locked &&
    a.preservePitch === b.preservePitch &&
    a.stretch.length === 0 &&
    b.stretch.length === 0;
  const inFile = a.reversed
    ? Math.abs(tb.offsetMs + b.lengthMs - ta.offsetMs) < 0.01
    : Math.abs(ta.offsetMs + a.lengthMs - tb.offsetMs) < 0.01;
  return sameSettings && Math.abs(clipEndMs(a) - b.startMs) < 0.01 && inFile;
}

/** One clip from two that continue each other (fades from the outer ends, both envelopes). */
function joined(a: AudioClip, b: AudioClip): AudioClip {
  const lengthMs = a.lengthMs + b.lengthMs;
  const share = a.lengthMs / lengthMs;
  const points = (c: AudioClip) =>
    c.envelope.length
      ? c.envelope
      : [
          { at: 0, db: 0 },
          { at: 1, db: 0 },
        ];
  const envelope =
    a.envelope.length || b.envelope.length
      ? [
          ...points(a).map((p) => ({ at: p.at * share, db: p.db })),
          ...points(b).map((p) => ({ at: share + p.at * (1 - share), db: p.db })),
        ]
      : [];
  const offsetMs = a.reversed ? activeTake(b).offsetMs : activeTake(a).offsetMs;
  return {
    ...a,
    lengthMs,
    takes: [{ ...activeTake(a), offsetMs }],
    take: 0,
    fadeOut: b.fadeOut,
    envelope,
  };
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
        clips[clips.length - 1] = joined(last, c);
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
 * the overlap, with equal-power curves. These fades are marked `auto` and are worked out again on
 * every edit, so they go when the overlap goes; fades the user set are kept when longer.
 */
export function withCrossfades(lane: AudioLane): AudioLane {
  const clips = lane.clips.map((c) => ({
    ...c,
    fadeIn: c.fadeIn.auto ? NO_FADE : c.fadeIn,
    fadeOut: c.fadeOut.auto ? NO_FADE : c.fadeOut,
  }));
  for (let i = 1; i < clips.length; i++) {
    const prev = clips[i - 1]!;
    const cur = clips[i]!;
    const overlap = Math.min(clipEndMs(prev) - cur.startMs, clipDuration(prev), clipDuration(cur));
    if (overlap <= 0) continue;
    // Fades are in source ms: the overlap on the timeline, at each clip's own playrate.
    if (cur.fadeIn.ms < overlap * cur.playrate)
      cur.fadeIn = { ms: overlap * cur.playrate, shape: "equalPower", auto: true };
    if (prev.fadeOut.ms < overlap * prev.playrate)
      prev.fadeOut = { ms: overlap * prev.playrate, shape: "equalPower", auto: true };
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
