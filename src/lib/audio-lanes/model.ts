import { MAX_TRACK_EFFECTS } from "@/lib/audio/effects";
import { FLAT_EQ, normalizeEq } from "@/lib/score/mixer";
import { isTrackColor } from "@/lib/score/track-colors";
import type {
  AudioBus,
  AudioClip,
  AudioLane,
  AudioLanesSettings,
  AudioSource,
  AudioTrackSettings,
  BackingFilter,
  ClipFade,
  FadeShape,
  MixerSettings,
  SyncPoint,
} from "@/lib/tauri";

/** The most lanes a song can have (each lane costs a chain and its clips' stretchers). */
export const MAX_LANES = 16;
/** The most buses lane sends can feed. */
export const MAX_BUSES = 4;
/** Clip pitch range. */
export const MAX_SEMITONES = 24;
export const MAX_CENTS = 100;
/** Clip playrate range. */
export const MIN_PLAYRATE = 0.25;
export const MAX_PLAYRATE = 4;
/** Clip gain range, in dB. */
export const MIN_GAIN_DB = -60;
export const MAX_GAIN_DB = 24;
/** The fade a cut gets so it does not click. */
export const CUT_FADE_MS = 5;
/** The shortest clip an edit can leave. */
export const MIN_CLIP_MS = 10;

const FILTERS: readonly BackingFilter[] = [
  "off",
  "bassIsolate",
  "guitarBand",
  "centreCut",
  "bassBoost",
  "bassCut",
  "midBoost",
  "midCut",
  "highBoost",
  "highCut",
];
const FADE_SHAPES: readonly FadeShape[] = ["linear", "equalPower", "sCurve"];

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

/** A fresh id for a lane, clip or bus. */
export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export const NO_FADE: ClipFade = { ms: 0, shape: "linear" };

/** The audio side of a song with nothing in it. */
export const EMPTY_AUDIO: AudioLanesSettings = {
  lanes: [],
  sources: [],
  buses: [],
  sync: [],
  zone: { start: 0, end: null },
  ripple: "off",
};

/** A new lane with default settings. */
export function newLane(name: string, id: string = newId()): AudioLane {
  return {
    id,
    name,
    color: null,
    enabled: true,
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    eq: FLAT_EQ,
    semitones: 0,
    cents: 0,
    filter: "off",
    followTransposition: true,
    effects: [],
    autoBypass: false,
    automation: [],
    sends: [],
    folder: false,
    collapsed: false,
    group: 0,
    clips: [],
  };
}

/** A new clip that plays `lengthMs` of `sourceId` from its start, at `startMs` on the timeline. */
export function newClip(
  sourceId: string,
  name: string,
  startMs: number,
  lengthMs: number,
  id: string = newId(),
): AudioClip {
  return {
    id,
    takes: [{ name, sourceId, offsetMs: 0 }],
    take: 0,
    startMs,
    lengthMs,
    gainDb: 0,
    mute: false,
    locked: false,
    reversed: false,
    semitones: 0,
    cents: 0,
    playrate: 1,
    preservePitch: true,
    fadeIn: NO_FADE,
    fadeOut: NO_FADE,
    envelope: [],
    stretch: [],
  };
}

/** The take a clip plays. */
export const activeTake = (clip: AudioClip) => clip.takes[clip.take] ?? clip.takes[0]!;

/** Where a clip ends on the timeline (its length is source time, played at its playrate). */
export const clipEndMs = (clip: AudioClip): number => clip.startMs + clip.lengthMs / clip.playrate;

/** Sync points in bar order, one per bar, with no negative values. */
export function normalizeSync(sync: readonly SyncPoint[]): SyncPoint[] {
  return sync
    .filter((p) => p.bar >= 0 && Number.isFinite(p.ms) && p.ms >= 0)
    .map((p) => {
      const beat = Math.max(0, Math.round(p.beat ?? 0));
      return beat > 0 ? { bar: Math.round(p.bar), beat, ms: p.ms } : { bar: Math.round(p.bar), ms: p.ms };
    })
    .sort((a, b) => a.bar - b.bar || (a.beat ?? 0) - (b.beat ?? 0))
    .filter((p, i, all) => {
      const next = all[i + 1];
      return !next || next.bar !== p.bar || (next.beat ?? 0) !== (p.beat ?? 0);
    });
}

function normalizeFade(fade: ClipFade | undefined, lengthMs: number): ClipFade {
  if (!fade) return NO_FADE;
  return {
    ms: clamp(fade.ms, 0, lengthMs),
    shape: FADE_SHAPES.includes(fade.shape) ? fade.shape : "linear",
  };
}

/** A clip with every value in range (fades no longer than the clip, gain points in order). */
export function normalizeClip(clip: AudioClip): AudioClip {
  const takes = clip.takes.length > 0 ? clip.takes : [];
  const lengthMs = Math.max(MIN_CLIP_MS, clip.lengthMs);
  const fadeIn = normalizeFade(clip.fadeIn, lengthMs);
  const fadeOut = normalizeFade(clip.fadeOut, lengthMs - fadeIn.ms);
  return {
    ...clip,
    takes: takes.map((t) => ({ ...t, offsetMs: Math.max(0, t.offsetMs) })),
    take: clamp(Math.round(clip.take), 0, Math.max(0, takes.length - 1)),
    startMs: Math.max(0, clip.startMs),
    lengthMs,
    gainDb: clamp(clip.gainDb, MIN_GAIN_DB, MAX_GAIN_DB),
    semitones: clamp(Math.round(clip.semitones), -MAX_SEMITONES, MAX_SEMITONES),
    cents: clamp(Math.round(clip.cents), -MAX_CENTS, MAX_CENTS),
    playrate: clamp(clip.playrate, MIN_PLAYRATE, MAX_PLAYRATE),
    fadeIn,
    fadeOut,
    envelope: clip.envelope
      .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.db))
      .map((p) => ({ at: clamp(p.at, 0, 1), db: clamp(p.db, MIN_GAIN_DB, MAX_GAIN_DB) }))
      .sort((a, b) => a.at - b.at),
    stretch: clip.stretch
      .filter((m) => m.sourceMs >= 0 && m.clipMs >= 0)
      .sort((a, b) => a.clipMs - b.clipMs)
      .filter((m, i, all) => i === 0 || m.sourceMs > all[i - 1]!.sourceMs),
  };
}

/** A lane with every value in range; clips that point at no source are dropped. */
export function normalizeLane(lane: AudioLane, sources: ReadonlySet<string>): AudioLane {
  return {
    ...lane,
    color: isTrackColor(lane.color) ? lane.color.toLowerCase() : null,
    volume: clamp(lane.volume, 0, 1),
    pan: clamp(lane.pan, -1, 1),
    eq: normalizeEq(lane.eq),
    semitones: clamp(Math.round(lane.semitones), -MAX_SEMITONES, MAX_SEMITONES),
    cents: clamp(Math.round(lane.cents), -MAX_CENTS, MAX_CENTS),
    filter: FILTERS.includes(lane.filter) ? lane.filter : "off",
    effects: lane.effects.slice(0, MAX_TRACK_EFFECTS),
    sends: lane.sends.map((s) => ({ ...s, level: clamp(s.level, 0, 1) })),
    group: clamp(Math.round(lane.group), 0, 64),
    clips: lane.folder
      ? []
      : lane.clips
          .filter((c) => c.takes.length > 0 && c.takes.every((t) => sources.has(t.sourceId)))
          .map(normalizeClip)
          .sort((a, b) => a.startMs - b.startMs),
  };
}

function normalizeBus(bus: AudioBus): AudioBus {
  return { ...bus, volume: clamp(bus.volume, 0, 1), effects: bus.effects.slice(0, MAX_TRACK_EFFECTS) };
}

/** Only sources that a clip plays (a removed clip's file is dropped on the next save). */
export function usedSources(audio: AudioLanesSettings): AudioSource[] {
  const used = new Set(audio.lanes.flatMap((l) => l.clips.flatMap((c) => c.takes.map((t) => t.sourceId))));
  return audio.sources.filter((s) => used.has(s.id));
}

/** The audio side with every value in range, lanes capped, folders and parents consistent. */
export function normalizeAudio(audio: AudioLanesSettings): AudioLanesSettings {
  const sourceIds = new Set(audio.sources.map((s) => s.id));
  const lanes = audio.lanes.slice(0, MAX_LANES).map((l) => normalizeLane(l, sourceIds));
  const folders = new Set(lanes.filter((l) => l.folder).map((l) => l.id));
  const buses = audio.buses.slice(0, MAX_BUSES).map(normalizeBus);
  const busIds = new Set(buses.map((b) => b.id));
  return {
    ...audio,
    lanes: lanes.map((l) => ({
      ...l,
      parent: l.parent && folders.has(l.parent) && l.parent !== l.id ? l.parent : undefined,
      sends: l.sends.filter((s) => busIds.has(s.bus)),
    })),
    buses,
    sync: normalizeSync(audio.sync),
    zone: {
      start: Math.max(0, Math.round(audio.zone.start)),
      end: audio.zone.end === null ? null : Math.max(Math.round(audio.zone.start) + 1, Math.round(audio.zone.end)),
    },
    ripple: audio.ripple === "lane" || audio.ripple === "all" ? audio.ripple : "off",
  };
}

/** The source id an old single audio track gets: stable for one name, never a content hash. */
export function legacySourceId(name: string): string {
  let hash = 0x811c9dc5;
  for (const char of name) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0;
  return `legacy-${hash.toString(16).padStart(8, "0")}`;
}

const extensionOf = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "wav";

/**
 * The old single audio track as one lane with one clip (one-way: saves write lanes only). The
 * name, file, volume, pan, mute, solo, enable, EQ, filter and transposition move to the lane,
 * and the sync points become the song's. The clip's length is unknown until the file is
 * decoded, so it is long enough for any file the decoder accepts (30 minutes) and the engine
 * stops at the end of the source.
 */
export function migrateAudioTrack(track: AudioTrackSettings, laneId: string = newId()): AudioLanesSettings {
  const sourceId = legacySourceId(track.name);
  const source: AudioSource = {
    id: sourceId,
    name: track.name,
    ext: extensionOf(track.name),
    path: track.path,
    embedded: track.embedded,
    legacyEntry: track.embedded ? track.name : undefined,
  };
  const { name, path: _path, embedded: _embedded, sync, ...params } = track;
  const lane: AudioLane = {
    ...newLane(name, laneId),
    ...params,
    clips: [newClip(sourceId, name, 0, 30 * 60 * 1000, `${laneId}-clip`)],
  };
  return normalizeAudio({ ...EMPTY_AUDIO, lanes: [lane], sources: [source], sync });
}

/**
 * The audio side of saved settings: version 3 lanes as they are, an old audio track migrated,
 * nothing otherwise. The returned settings never carry `audioTrack`.
 */
export function readAudio(settings: MixerSettings): { audio: AudioLanesSettings; rest: MixerSettings } {
  const { audioTrack, audio, ...rest } = settings;
  if (audio) return { audio: normalizeAudio(audio), rest };
  if (audioTrack) return { audio: migrateAudioTrack(audioTrack), rest };
  return { audio: EMPTY_AUDIO, rest };
}
