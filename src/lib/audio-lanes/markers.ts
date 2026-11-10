import type { AudioLanesSettings, AudioMarker, AudioRegion } from "@/lib/tauri";

/** The most markers and the most regions a song can have (as Rust checks). */
export const MAX_MARKERS = 256;
export const MAX_REGIONS = 256;
/** The longest marker or region name, in characters. */
export const MAX_MARKER_NAME = 64;
/** The latest point on the timeline, in ms (a day, as Rust checks). */
const MAX_MS = 86_400_000;
/** Markers closer than this to the position line count as on it when stepping. */
const STEP_TOLERANCE_MS = 1;

type Audio = Pick<AudioLanesSettings, "markers" | "regions">;

const freshId = (): string => globalThis.crypto.randomUUID();
const inRange = (ms: number) => Math.min(MAX_MS, Math.max(0, ms));
const validMs = (ms: number) => Number.isFinite(ms) && ms >= 0;

/** A name cut to the longest a marker can have, with spaces trimmed. */
export const markerName = (name: string): string =>
  Array.from(name.trim()).slice(0, MAX_MARKER_NAME).join("");

/** The song's markers in time order (none in older files). */
export const markersOf = (audio: Audio): readonly AudioMarker[] => audio.markers ?? [];
/** The song's regions in start order (none in older files). */
export const regionsOf = (audio: Audio): readonly AudioRegion[] => audio.regions ?? [];

const byMs = (a: AudioMarker, b: AudioMarker) => a.ms - b.ms;
const byStart = (a: AudioRegion, b: AudioRegion) => a.startMs - b.startMs || a.endMs - b.endMs;
const firstOfEachId = <T extends { id: string }>(item: T, i: number, all: readonly T[]) =>
  all.findIndex((other) => other.id === item.id) === i;

/** Markers with finite positions, names that fit, one per id, in time order, capped. */
export function normalizeMarkers(markers: readonly AudioMarker[]): AudioMarker[] {
  return markers
    .filter((m) => validMs(m.ms) && m.id.length > 0)
    .filter(firstOfEachId)
    .map((m) => ({ id: m.id, ms: inRange(m.ms), name: markerName(m.name) }))
    .sort(byMs)
    .slice(0, MAX_MARKERS);
}

/** Regions with finite spans that end after they start, one per id, in start order, capped. */
export function normalizeRegions(regions: readonly AudioRegion[]): AudioRegion[] {
  return regions
    .filter((r) => validMs(r.startMs) && validMs(r.endMs) && r.id.length > 0)
    .filter(firstOfEachId)
    .map((r) => ({
      id: r.id,
      startMs: inRange(Math.min(r.startMs, r.endMs)),
      endMs: inRange(Math.max(r.startMs, r.endMs)),
      name: markerName(r.name),
    }))
    .filter((r) => r.endMs > r.startMs)
    .sort(byStart)
    .slice(0, MAX_REGIONS);
}

/** The first "<prefix> N" no item is called yet. */
function nextName(prefix: string, names: readonly string[]): string {
  const taken = new Set(names);
  let n = names.length + 1;
  for (let i = 1; i <= names.length; i++) {
    if (!taken.has(`${prefix} ${i}`)) {
      n = i;
      break;
    }
  }
  return `${prefix} ${n}`;
}

/** The name a new marker gets: "Marker N". */
export const nextMarkerName = (audio: Audio): string =>
  nextName(
    "Marker",
    markersOf(audio).map((m) => m.name),
  );
/** The name a new region gets: "Region N". */
export const nextRegionName = (audio: Audio): string =>
  nextName(
    "Region",
    regionsOf(audio).map((r) => r.name),
  );

const withMarkers = <A extends Audio>(audio: A, markers: AudioMarker[]): A => ({
  ...audio,
  markers: normalizeMarkers(markers),
});
const withRegions = <A extends Audio>(audio: A, regions: AudioRegion[]): A => ({
  ...audio,
  regions: normalizeRegions(regions),
});

/** Adds a marker at `ms` (unchanged when the song has the most markers it can have). */
export function addMarker<A extends Audio>(
  audio: A,
  ms: number,
  id: string = freshId(),
  name: string = nextMarkerName(audio),
): A {
  const markers = markersOf(audio);
  if (markers.length >= MAX_MARKERS || !validMs(ms)) return audio;
  return withMarkers(audio, [...markers, { id, ms, name }]);
}

/** Changes a marker; unchanged when there is no such marker. */
function updateMarker<A extends Audio>(audio: A, id: string, patch: Partial<AudioMarker>): A {
  const markers = markersOf(audio);
  if (!markers.some((m) => m.id === id)) return audio;
  return withMarkers(
    audio,
    markers.map((m) => (m.id === id ? { ...m, ...patch, id } : m)),
  );
}

export const moveMarker = <A extends Audio>(audio: A, id: string, ms: number): A =>
  validMs(ms) ? updateMarker(audio, id, { ms }) : audio;

/** Renames a marker; an empty name keeps the old one. */
export const renameMarker = <A extends Audio>(audio: A, id: string, name: string): A =>
  markerName(name) ? updateMarker(audio, id, { name: markerName(name) }) : audio;

export function removeMarker<A extends Audio>(audio: A, id: string): A {
  const markers = markersOf(audio);
  if (!markers.some((m) => m.id === id)) return audio;
  return withMarkers(
    audio,
    markers.filter((m) => m.id !== id),
  );
}

/** Adds a region over a span (either order); unchanged for an empty span or at the cap. */
export function addRegion<A extends Audio>(
  audio: A,
  startMs: number,
  endMs: number,
  id: string = freshId(),
  name: string = nextRegionName(audio),
): A {
  const regions = regionsOf(audio);
  const valid = validMs(startMs) && validMs(endMs) && startMs !== endMs;
  if (regions.length >= MAX_REGIONS || !valid) return audio;
  return withRegions(audio, [...regions, { id, startMs, endMs, name }]);
}

/** Renames a region; an empty name keeps the old one. */
export function renameRegion<A extends Audio>(audio: A, id: string, name: string): A {
  const regions = regionsOf(audio);
  const next = markerName(name);
  if (!next || !regions.some((r) => r.id === id)) return audio;
  return withRegions(
    audio,
    regions.map((r) => (r.id === id ? { ...r, name: next } : r)),
  );
}

export function removeRegion<A extends Audio>(audio: A, id: string): A {
  const regions = regionsOf(audio);
  if (!regions.some((r) => r.id === id)) return audio;
  return withRegions(
    audio,
    regions.filter((r) => r.id !== id),
  );
}

/** The last marker before `ms` (null: none). */
export function previousMarker(audio: Audio, ms: number): AudioMarker | null {
  return markersOf(audio).findLast((m) => m.ms < ms - STEP_TOLERANCE_MS) ?? null;
}

/** The first marker after `ms` (null: none). */
export function nextMarker(audio: Audio, ms: number): AudioMarker | null {
  return markersOf(audio).find((m) => m.ms > ms + STEP_TOLERANCE_MS) ?? null;
}

/** Marker number `n` (1-based, in time order; null: there is no such marker). */
export const markerNumber = (audio: Audio, n: number): AudioMarker | null =>
  (n >= 1 && markersOf(audio)[n - 1]) || null;

/** Where the clips `ids` start and end on the timeline (null: none of them is in the song). */
export function clipsExtent(
  audio: Pick<AudioLanesSettings, "lanes">,
  ids: readonly string[],
): { startMs: number; endMs: number } | null {
  const clips = audio.lanes.flatMap((l) => l.clips).filter((c) => ids.includes(c.id));
  if (clips.length === 0) return null;
  return {
    startMs: Math.min(...clips.map((c) => c.startMs)),
    endMs: Math.max(...clips.map((c) => c.startMs + c.lengthMs / c.playrate)),
  };
}
