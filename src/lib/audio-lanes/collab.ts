/**
 * Practice together shares the song's audio lanes: what the players hear on the lanes, not how
 * each one mixes it (ADR 0005).
 *
 * Shared: the lanes (their name, colour, folder, group, pitch and place in the order), their clips,
 * the audio files the clips play, the song's sync points, the markers and the regions.
 * Personal, never sent and never overwritten by another player: each lane's volume, pan, mute, solo,
 * EQ, filter, effects, sends and automation, whether it is on, and how it is shown (collapsed,
 * height, shown under the score); also the buses, the ripple mode and the play zone.
 *
 * A change travels as a few operations that name a lane, clip or file by its id and set it to a
 * value, so applying one twice, or after another player changed something else, is harmless. They
 * are made by comparing the shared parts of two states ({@link diffAudio}), so every way the lanes
 * can be edited is shared without each edit knowing about it.
 */
import {
  MAX_LANES,
  MAX_TAKES,
  newLane,
  normalizeAudio,
  normalizeClip,
} from "@/lib/audio-lanes/model";
import { MAX_MARKERS, MAX_MARKER_NAME, MAX_REGIONS } from "@/lib/audio-lanes/markers";
import { isTrackColor } from "@/lib/score/track-colors";
import type {
  AudioClip,
  AudioLane,
  AudioLanesSettings,
  AudioMarker,
  AudioRegion,
  AudioSource,
  SyncPoint,
} from "@/lib/tauri";

/** The lane fields every player sees the same (besides the clips). */
export const SHARED_LANE_FIELDS = [
  "name",
  "color",
  "followTransposition",
  "parent",
  "folder",
  "group",
  "semitones",
  "cents",
] as const;

/** What stays with each player (documented here once; the diff never looks at them). */
export const PERSONAL_LANE_FIELDS = [
  "enabled",
  "volume",
  "pan",
  "mute",
  "solo",
  "eq",
  "filter",
  "effects",
  "autoBypass",
  "automation",
  "sends",
  "collapsed",
  "height",
  "shownInScore",
] as const;

type SharedField = (typeof SHARED_LANE_FIELDS)[number];
/** A lane as shared: its shared fields and its clips. */
export type SharedLane = Pick<AudioLane, SharedField | "id" | "clips">;

/** A file the lanes play, as shared: no path (that is this computer's), always an embedded file. */
export type SharedSource = Pick<AudioSource, "id" | "name" | "ext">;

export type AudioOp =
  /** Starts a snapshot: everything shared that this end has is replaced by what follows. */
  | { t: "a-reset" }
  | { t: "a-src-add"; source: SharedSource }
  | { t: "a-src-del"; id: string }
  | { t: "a-lane-add"; lane: SharedLane; at: number }
  | { t: "a-lane-set"; id: string; set: Partial<Pick<AudioLane, SharedField>> }
  | { t: "a-lane-del"; id: string }
  | { t: "a-lane-order"; ids: string[] }
  | { t: "a-clip-set"; lane: string; clip: AudioClip }
  | { t: "a-clip-del"; lane: string; id: string }
  | { t: "a-sync-set"; point: SyncPoint }
  | { t: "a-sync-del"; bar: number; beat: number }
  | { t: "a-mark-set"; marker: AudioMarker }
  | { t: "a-mark-del"; id: string }
  | { t: "a-region-set"; region: AudioRegion }
  | { t: "a-region-del"; id: string };

/** Whether an operation of shared editing is one of the lanes'. */
export const isAudioOp = (op: { t: string }): boolean =>
  typeof (op as { t?: unknown } | null)?.t === "string" && op.t.startsWith("a-");

/** The most clips a lane holds (a song with thousands of cuts is a mistake, not a song). */
export const MAX_CLIPS_PER_LANE = 2_000;
/** The most audio files a tab shares. */
export const MAX_SHARED_SOURCES = 512;
/** The most operations in one batch from another player. */
export const MAX_AUDIO_OPS = 4_000;
/** A clip bigger than this (as JSON) is not shared (its gain envelope or stretch markers are huge). */
export const MAX_CLIP_JSON = 8_000;

const same = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

/** The lane's shared fields, with a missing parent left out (so "none" compares equal). */
function sharedFields(lane: AudioLane): Pick<AudioLane, SharedField> {
  const fields = {} as Record<string, unknown>;
  for (const key of SHARED_LANE_FIELDS) {
    const value = lane[key];
    if (value !== undefined) fields[key] = value;
  }
  return fields as Pick<AudioLane, SharedField>;
}

/** What goes to the other players for a lane. */
export function sharedLane(lane: AudioLane): SharedLane {
  return { id: lane.id, ...sharedFields(lane), clips: lane.clips };
}

/** What goes to the other players for a file; null for a file nobody else can get by its id. */
export function sharedSource(source: AudioSource): SharedSource | null {
  return SOURCE_ID.test(source.id) ? { id: source.id, name: source.name, ext: source.ext } : null;
}

const SOURCE_ID = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

const syncKey = (p: SyncPoint) => `${p.bar}:${p.beat ?? 0}`;

/** The operations that turn the shared parts of `prev` into those of `next` (none: nothing to share). */
export function diffAudio(prev: AudioLanesSettings, next: AudioLanesSettings): AudioOp[] {
  const ops: AudioOp[] = [];
  const prevSources = new Map(prev.sources.map((s) => [s.id, s]));
  const nextSources = new Map(next.sources.map((s) => [s.id, s]));
  const prevLanes = new Map(prev.lanes.map((l) => [l.id, l]));
  const nextLanes = new Map(next.lanes.map((l) => [l.id, l]));

  // Files first: the clips that play them come after.
  for (const source of next.sources) {
    const shared = prevSources.has(source.id) ? null : sharedSource(source);
    if (shared) ops.push({ t: "a-src-add", source: shared });
  }

  for (const lane of prev.lanes) {
    if (!nextLanes.has(lane.id)) ops.push({ t: "a-lane-del", id: lane.id });
  }
  next.lanes.forEach((lane, at) => {
    const before = prevLanes.get(lane.id);
    if (!before) {
      ops.push({ t: "a-lane-add", lane: sharedLane(lane), at });
      return;
    }
    const was = sharedFields(before);
    const now = sharedFields(lane);
    const set: Record<string, unknown> = {};
    for (const key of SHARED_LANE_FIELDS) {
      if (!same(was[key], now[key])) set[key] = now[key] ?? null;
    }
    if (Object.keys(set).length > 0) {
      ops.push({ t: "a-lane-set", id: lane.id, set: set as Partial<Pick<AudioLane, SharedField>> });
    }
    const prevClips = new Map(before.clips.map((c) => [c.id, c]));
    const nextClips = new Map(lane.clips.map((c) => [c.id, c]));
    for (const clip of before.clips) {
      if (!nextClips.has(clip.id)) ops.push({ t: "a-clip-del", lane: lane.id, id: clip.id });
    }
    for (const clip of lane.clips) {
      if (!same(prevClips.get(clip.id), clip)) ops.push({ t: "a-clip-set", lane: lane.id, clip });
    }
  });
  // The order only matters among lanes both ends have: say it when it changed.
  const orderBefore = prev.lanes.filter((l) => nextLanes.has(l.id)).map((l) => l.id);
  const orderNow = next.lanes.filter((l) => prevLanes.has(l.id)).map((l) => l.id);
  if (!same(orderBefore, orderNow)) {
    ops.push({ t: "a-lane-order", ids: next.lanes.map((l) => l.id) });
  }

  for (const source of prev.sources) {
    if (!nextSources.has(source.id) && sharedSource(source)) {
      ops.push({ t: "a-src-del", id: source.id });
    }
  }

  const prevSync = new Map(prev.sync.map((p) => [syncKey(p), p]));
  const nextSync = new Map(next.sync.map((p) => [syncKey(p), p]));
  for (const [key, point] of prevSync) {
    if (!nextSync.has(key)) ops.push({ t: "a-sync-del", bar: point.bar, beat: point.beat ?? 0 });
  }
  for (const [key, point] of nextSync) {
    if (!same(prevSync.get(key), point)) ops.push({ t: "a-sync-set", point });
  }

  diffById(prev.markers ?? [], next.markers ?? [], {
    set: (marker) => ({ t: "a-mark-set", marker }),
    del: (id) => ({ t: "a-mark-del", id }),
  }).forEach((op) => ops.push(op));
  diffById(prev.regions ?? [], next.regions ?? [], {
    set: (region) => ({ t: "a-region-set", region }),
    del: (id) => ({ t: "a-region-del", id }),
  }).forEach((op) => ops.push(op));
  return ops;
}

function diffById<T extends { id: string }>(
  prev: readonly T[],
  next: readonly T[],
  make: { set: (item: T) => AudioOp; del: (id: string) => AudioOp },
): AudioOp[] {
  const before = new Map(prev.map((i) => [i.id, i]));
  const now = new Set(next.map((i) => i.id));
  return [
    ...prev.filter((i) => !now.has(i.id)).map((i) => make.del(i.id)),
    ...next.filter((i) => !same(before.get(i.id), i)).map((i) => make.set(i)),
  ];
}

/** The lane's personal fields from `from`, put on a lane another player shared. */
function withShared(base: AudioLane, shared: SharedLane): AudioLane {
  const { parent, ...rest } = sharedFields(shared as AudioLane);
  const lane = { ...base, ...rest, clips: shared.clips } as AudioLane;
  if (parent === undefined) delete lane.parent;
  else lane.parent = parent;
  return lane;
}

/**
 * The operations applied to `audio`, as a new state; the personal parts of every lane stay as they
 * are. An operation that names something that is not there is skipped. The result is brought into
 * range ({@link normalizeAudio}), so a bad value cannot get past it.
 */
export function applyAudioOps(
  audio: AudioLanesSettings,
  ops: readonly AudioOp[],
): AudioLanesSettings {
  let lanes = [...audio.lanes];
  let sources = [...audio.sources];
  let sync = [...audio.sync];
  let markers = [...(audio.markers ?? [])];
  let regions = [...(audio.regions ?? [])];
  // After a reset, a lane or file this end already had keeps its personal side / its location.
  const oldLanes = new Map<string, AudioLane>();
  const oldSources = new Map<string, AudioSource>();
  const laneAt = (id: string) => lanes.findIndex((l) => l.id === id);
  const upsert = <T extends { id: string }>(list: T[], item: T): T[] => {
    const i = list.findIndex((x) => x.id === item.id);
    return i < 0 ? [...list, item] : list.map((x, j) => (j === i ? item : x));
  };

  for (const op of ops) {
    switch (op.t) {
      case "a-reset":
        for (const lane of lanes) oldLanes.set(lane.id, lane);
        for (const source of sources) oldSources.set(source.id, source);
        lanes = [];
        sources = [];
        sync = [];
        markers = [];
        regions = [];
        break;
      case "a-src-add": {
        const existing = sources.find((s) => s.id === op.source.id);
        // A file this computer already has keeps where it is (a path, or the song file).
        if (!existing)
          sources.push(oldSources.get(op.source.id) ?? { ...op.source, embedded: true });
        break;
      }
      case "a-src-del":
        sources = sources.filter((s) => s.id !== op.id);
        break;
      case "a-lane-add": {
        const existing = laneAt(op.lane.id);
        if (existing >= 0) {
          lanes[existing] = withShared(lanes[existing]!, op.lane);
        } else {
          const lane = withShared(
            oldLanes.get(op.lane.id) ?? newLane(op.lane.name, op.lane.id),
            op.lane,
          );
          lanes.splice(Math.min(Math.max(0, op.at), lanes.length), 0, lane);
        }
        break;
      }
      case "a-lane-set": {
        const i = laneAt(op.id);
        if (i < 0) break;
        // Only the shared fields: this player's mix is not another player's to set.
        const picked = Object.fromEntries(
          SHARED_LANE_FIELDS.filter((key) => key in op.set).map((key) => [key, op.set[key]]),
        );
        const lane = { ...lanes[i]!, ...picked } as AudioLane;
        // "No folder" travels as null.
        if ("parent" in op.set && !op.set.parent) delete lane.parent;
        lanes[i] = lane;
        break;
      }
      case "a-lane-del":
        lanes = lanes.filter((l) => l.id !== op.id);
        break;
      case "a-lane-order": {
        const byId = new Map(lanes.map((l) => [l.id, l]));
        const ordered = op.ids.flatMap((id) => {
          const lane = byId.get(id);
          byId.delete(id);
          return lane ? [lane] : [];
        });
        // Lanes this end has and the order does not name (made at the same moment) keep their place at the end.
        lanes = [...ordered, ...byId.values()];
        break;
      }
      case "a-clip-set": {
        const i = laneAt(op.lane);
        if (i < 0) break;
        const lane = lanes[i]!;
        // A clip in another lane of this one's moved here.
        const clips = lane.clips.some((c) => c.id === op.clip.id)
          ? lane.clips.map((c) => (c.id === op.clip.id ? op.clip : c))
          : [...lane.clips, op.clip];
        lanes[i] = { ...lane, clips };
        break;
      }
      case "a-clip-del": {
        const i = laneAt(op.lane);
        if (i < 0) break;
        lanes[i] = { ...lanes[i]!, clips: lanes[i]!.clips.filter((c) => c.id !== op.id) };
        break;
      }
      case "a-sync-set":
        sync = [...sync.filter((p) => syncKey(p) !== syncKey(op.point)), op.point];
        break;
      case "a-sync-del":
        sync = sync.filter((p) => syncKey(p) !== `${op.bar}:${op.beat}`);
        break;
      case "a-mark-set":
        markers = upsert(markers, op.marker);
        break;
      case "a-mark-del":
        markers = markers.filter((m) => m.id !== op.id);
        break;
      case "a-region-set":
        regions = upsert(regions, op.region);
        break;
      case "a-region-del":
        regions = regions.filter((r) => r.id !== op.id);
        break;
    }
  }
  return normalizeAudio({
    ...audio,
    lanes,
    sources,
    sync,
    ...((audio.markers || markers.length > 0) && { markers }),
    ...((audio.regions || regions.length > 0) && { regions }),
  });
}

// ----- checking what another player sent -----------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown, max = 200): v is string => typeof v === "string" && v.length <= max;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isId = (v: unknown): v is string => typeof v === "string" && SAFE_ID.test(v);
const MAX_MS = 86_400_000;
const inMs = (v: unknown): v is number => isNum(v) && v >= 0 && v <= MAX_MS;

function validFade(f: unknown): boolean {
  return (
    isObject(f) &&
    isNum(f.ms) &&
    (f.shape === "linear" || f.shape === "equalPower" || f.shape === "sCurve") &&
    (f.auto === undefined || isBool(f.auto))
  );
}

function validClip(c: unknown): c is AudioClip {
  if (!isObject(c) || !isId(c.id)) return false;
  if (JSON.stringify(c).length > MAX_CLIP_JSON) return false;
  return (
    Array.isArray(c.takes) &&
    c.takes.length >= 1 &&
    c.takes.length <= MAX_TAKES &&
    c.takes.every(
      (t) =>
        isObject(t) &&
        isStr(t.name, 200) &&
        isStr(t.sourceId, 80) &&
        isNum(t.offsetMs) &&
        inMs(t.offsetMs),
    ) &&
    isNum(c.take) &&
    inMs(c.startMs) &&
    isNum(c.lengthMs) &&
    c.lengthMs >= 0 &&
    c.lengthMs <= MAX_MS &&
    isNum(c.gainDb) &&
    isBool(c.mute) &&
    isBool(c.locked) &&
    isBool(c.reversed) &&
    isNum(c.semitones) &&
    isNum(c.cents) &&
    isNum(c.playrate) &&
    c.playrate > 0 &&
    isBool(c.preservePitch) &&
    validFade(c.fadeIn) &&
    validFade(c.fadeOut) &&
    Array.isArray(c.envelope) &&
    c.envelope.length <= 200 &&
    c.envelope.every((p) => isObject(p) && isNum(p.at) && isNum(p.db)) &&
    Array.isArray(c.stretch) &&
    c.stretch.length <= 200 &&
    c.stretch.every((m) => isObject(m) && isNum(m.sourceMs) && isNum(m.clipMs)) &&
    (c.groupId === undefined || isId(c.groupId))
  );
}

function validLaneFields(f: Record<string, unknown>, complete: boolean): boolean {
  // An operation names shared fields only (a lane add also has its id and clips).
  const allowed: string[] = [...SHARED_LANE_FIELDS, "id", "clips"];
  if (Object.keys(f).some((key) => !allowed.includes(key))) return false;
  const need = (key: SharedField, ok: boolean) => (key in f ? ok : !complete);
  return (
    need("name", isStr(f.name, 120)) &&
    need("color", f.color === null || isTrackColor(f.color)) &&
    need("followTransposition", isBool(f.followTransposition)) &&
    ("parent" in f ? f.parent === null || f.parent === undefined || isId(f.parent) : true) &&
    need("folder", isBool(f.folder)) &&
    need("group", isNum(f.group)) &&
    need("semitones", isNum(f.semitones)) &&
    need("cents", isNum(f.cents))
  );
}

/**
 * Operations from another player, checked before they touch anything: the right shape, sizes and
 * ranges, and not more than the song may hold. Returns them typed, or null when anything is wrong
 * (a modified app could send anything).
 */
export function validAudioOps(raw: readonly unknown[]): AudioOp[] | null {
  if (raw.length > MAX_AUDIO_OPS) return null;
  for (const op of raw as unknown as Record<string, unknown>[]) {
    let ok = false;
    switch (op.t) {
      case "a-reset":
        ok = true;
        break;
      case "a-src-add": {
        const s = op.source;
        ok =
          isObject(s) &&
          isStr(s.id, 80) &&
          SOURCE_ID.test(s.id as string) &&
          isStr(s.name, 200) &&
          typeof s.ext === "string" &&
          /^[a-z0-9]{1,5}$/.test(s.ext);
        break;
      }
      case "a-src-del":
        ok = isStr(op.id, 80);
        break;
      case "a-lane-add": {
        const l = op.lane;
        ok =
          isObject(l) &&
          isId(l.id) &&
          validLaneFields(l, true) &&
          Array.isArray(l.clips) &&
          l.clips.length <= MAX_CLIPS_PER_LANE &&
          l.clips.every(validClip) &&
          isNum(op.at);
        break;
      }
      case "a-lane-set":
        ok = isId(op.id) && isObject(op.set) && validLaneFields(op.set, false);
        break;
      case "a-lane-del":
        ok = isId(op.id);
        break;
      case "a-lane-order":
        ok = Array.isArray(op.ids) && op.ids.length <= MAX_LANES && op.ids.every(isId);
        break;
      case "a-clip-set":
        ok = isId(op.lane) && validClip(op.clip);
        break;
      case "a-clip-del":
        ok = isId(op.lane) && isId(op.id);
        break;
      case "a-sync-set": {
        const p = op.point;
        ok =
          isObject(p) &&
          isNum(p.bar) &&
          p.bar >= 0 &&
          p.bar < 100_000 &&
          inMs(p.ms) &&
          (p.beat === undefined || (isNum(p.beat) && p.beat >= 0 && p.beat < 64));
        break;
      }
      case "a-sync-del":
        ok = isNum(op.bar) && isNum(op.beat);
        break;
      case "a-mark-set": {
        const m = op.marker;
        ok = isObject(m) && isId(m.id) && inMs(m.ms) && isStr(m.name, MAX_MARKER_NAME);
        break;
      }
      case "a-mark-del":
      case "a-region-del":
        ok = isId(op.id);
        break;
      case "a-region-set": {
        const r = op.region;
        ok =
          isObject(r) &&
          isId(r.id) &&
          inMs(r.startMs) &&
          inMs(r.endMs) &&
          isStr(r.name, MAX_MARKER_NAME);
        break;
      }
    }
    if (!ok) return null;
  }
  return raw as unknown as AudioOp[];
}

/**
 * Whether the state after `ops` stays inside what a song may hold: not more lanes, clips, files,
 * markers or regions than the limits. A batch that would break them is refused whole.
 */
export function withinLimits(audio: AudioLanesSettings): boolean {
  return (
    audio.lanes.length <= MAX_LANES &&
    audio.sources.length <= MAX_SHARED_SOURCES &&
    audio.lanes.every((l) => l.clips.length <= MAX_CLIPS_PER_LANE) &&
    (audio.markers?.length ?? 0) <= MAX_MARKERS &&
    (audio.regions?.length ?? 0) <= MAX_REGIONS
  );
}

/**
 * Applies a batch another player sent: checked, applied, and checked again for size. Null when the
 * batch is refused (the caller asks for the lanes again). Clips pointing at a file nobody has
 * sent are dropped by the normalisation, as in any song.
 */
export function receiveAudioOps(
  audio: AudioLanesSettings,
  raw: readonly unknown[],
): AudioLanesSettings | null {
  const ops = validAudioOps(raw);
  if (!ops) return null;
  // A lane built from a hostile op is normalised the same as one read from a file.
  const prepared = ops.map((op) =>
    op.t === "a-clip-set" ? { ...op, clip: normalizeClip(op.clip) } : op,
  );
  const next = applyAudioOps(audio, prepared);
  return withinLimits(next) ? next : null;
}

/** All the shared lanes of a state as operations (what a player gets on joining). */
export function snapshotOps(audio: AudioLanesSettings): AudioOp[] {
  return [
    { t: "a-reset" },
    ...diffAudio(
      { lanes: [], sources: [], buses: [], sync: [], zone: { start: 0, end: null }, ripple: "off" },
      audio,
    ),
  ];
}

/** What the lanes controller offers a session: its shared state in, other players' operations out. */
export interface LaneBridge {
  /** The shared lanes as operations, starting with a reset. */
  snapshot(): AudioOp[];
  /**
   * Applies operations from the host's order. `own`: this player sent them (an echo): they are
   * skipped while this player has changes not sent yet, so a drag does not jump back. False: the
   * batch was refused, ask for the lanes again.
   */
  apply(ops: readonly unknown[], own: boolean): boolean;
  /** A session starts: the host's lanes are the shared ones now; a guest waits for the snapshot. */
  begin(host: boolean): void;
  /** The session ended. */
  end(): void;
}

/** What the workspace gives its lanes controller when a Practice together session is on. */
export interface LaneSharing {
  /** The lanes are shared: this player's edits are sent. */
  active: boolean;
  /** Sends operations to the other players; false: they did not fit in a message. */
  send(ops: AudioOp[]): boolean;
  /** This player may not edit now (a guest that may not): says so and returns true. */
  blocked(): boolean;
  /** Hands the controller's bridge to the session (null: gone). */
  attach(bridge: LaneBridge | null): void;
  /** Files other players sent that are not here yet (their clips wait for them). */
  waiting: ReadonlySet<string>;
  /** The shared lanes' files changed (other players' operations were applied). */
  sourcesChanged?(sources: readonly AudioSource[]): void;
}

/** A file as the transfer lists it: the name a lane calls it (to show) and the name it is loaded under. */
export interface SourceEntry {
  id: string;
  name: string;
  file: string;
}

/** The name with the file's extension, as the audio engine reads the type from it. */
export const fileNameOf = (source: Pick<AudioSource, "name" | "ext">): string =>
  source.name.toLowerCase().endsWith(`.${source.ext}`)
    ? source.name
    : `${source.name}.${source.ext}`;

/** The files of the lanes, each shown under the name of the first lane that plays it. */
export function sourceEntries(audio: AudioLanesSettings): SourceEntry[] {
  return audio.sources.map((source) => {
    const lane = audio.lanes.find((l) =>
      l.clips.some((c) => c.takes.some((t) => t.sourceId === source.id)),
    );
    return { id: source.id, name: lane?.name ?? source.name, file: fileNameOf(source) };
  });
}
