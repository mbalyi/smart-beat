import { lanesEndMs, normalizeSync } from "@/lib/audio-lanes/model";
import { audioMsAt } from "@/lib/audio/engine-config";
import type { AudioLanesSettings, SyncPoint } from "@/lib/tauri";

/**
 * The song's grid as the audio editor sees it: when each bar starts in the song (ms, played
 * straight through, so repeats and jumps do not move the audio) and how many beats it has.
 */
export interface SongGrid {
  barTimes: readonly number[];
  beats: readonly number[];
}

/** Bars after the grid's last entry last as long as its last bar (2 s with no bar to go by). */
const FALLBACK_BAR_MS = 2000;
function tailBarMs(grid: SongGrid): number {
  const t = grid.barTimes;
  const length = t.length >= 2 ? t[t.length - 1]! - t[t.length - 2]! : 0;
  return length > 0 ? length : FALLBACK_BAR_MS;
}

/**
 * Where a beat starts in the song, in ms. Past the grid's last entry the bars go on at the last
 * bar's length, so audio that runs longer than the score still has a place on the grid.
 */
export function songMsAt(grid: SongGrid, bar: number, beat = 0): number {
  const t = grid.barTimes;
  if (t.length === 0) return 0;
  const last = t.length - 1;
  const whole = Math.max(0, bar);
  const start = whole <= last ? t[whole]! : t[last]! + (whole - last) * tailBarMs(grid);
  if (beat <= 0) return start;
  const next = whole < last ? t[whole + 1]! : start + tailBarMs(grid);
  const beats = grid.beats[whole] ?? grid.beats[grid.beats.length - 1] ?? 4;
  return start + ((next - start) * beat) / beats;
}

/** The sync points as (song ms, audio timeline ms) pairs. */
export function syncPairs(
  sync: readonly SyncPoint[],
  grid: SongGrid,
): { songMs: number; ms: number }[] {
  return sync.flatMap((p) =>
    grid.barTimes[p.bar] === undefined ? [] : [{ songMs: songMsAt(grid, p.bar, p.beat), ms: p.ms }],
  );
}

/** Where a beat of the score falls on the audio timeline. */
export function timelineMsAt(
  audio: AudioLanesSettings,
  grid: SongGrid,
  bar: number,
  beat = 0,
): number {
  return audioMsAt(syncPairs(audio.sync, grid), songMsAt(grid, bar, beat));
}

/** The bar (0-based, fractional) at a point of the audio timeline. */
export function barAtTimelineMs(audio: AudioLanesSettings, grid: SongGrid, ms: number): number {
  const bars = grid.barTimes.length;
  if (bars === 0) return 0;
  // Past the end of the grid: on at the last bar's length.
  const lastStart = timelineMsAt(audio, grid, bars - 1);
  if (ms >= lastStart) {
    const length = timelineMsAt(audio, grid, bars) - lastStart;
    return length > 0 ? bars - 1 + (ms - lastStart) / length : bars - 1;
  }
  let lo = 0;
  let hi = bars - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (timelineMsAt(audio, grid, mid) <= ms) lo = mid;
    else hi = mid - 1;
  }
  const start = timelineMsAt(audio, grid, lo);
  const end = lo + 1 < bars ? timelineMsAt(audio, grid, lo + 1) : start;
  return end > start ? lo + Math.min(1, (ms - start) / (end - start)) : lo;
}

/** The nearest grid line (bar or beat) to a timeline point, for snapping. */
export function snapMs(
  audio: AudioLanesSettings,
  grid: SongGrid,
  ms: number,
  step: "bar" | "beat",
): number {
  const at = barAtTimelineMs(audio, grid, ms);
  // Before the first bar (in the padding) there is no grid to snap to.
  if (at < 0) return ms;
  const bar = Math.floor(at);
  if (step === "bar") {
    const a = timelineMsAt(audio, grid, bar);
    const b = timelineMsAt(audio, grid, bar + 1);
    return Math.abs(ms - a) <= Math.abs(b - ms) ? a : b;
  }
  const beats = grid.beats[bar] ?? 4;
  const beat = Math.round((at - bar) * beats);
  return beat >= beats ? timelineMsAt(audio, grid, bar + 1) : timelineMsAt(audio, grid, bar, beat);
}

/**
 * Adds a sync point on a beat at the audio time it plays now, or removes the one there
 * (double-click). Points stay inside the play zone.
 */
export function toggleSyncPoint(
  audio: AudioLanesSettings,
  grid: SongGrid,
  bar: number,
  beat = 0,
): AudioLanesSettings {
  const same = (p: SyncPoint) => p.bar === bar && (p.beat ?? 0) === beat;
  if (audio.sync.some(same)) return { ...audio, sync: audio.sync.filter((p) => !same(p)) };
  if (bar < audio.zone.start || (audio.zone.end !== null && bar > audio.zone.end)) return audio;
  const ms = timelineMsAt(audio, grid, bar, beat);
  return { ...audio, sync: normalizeSync([...audio.sync, { bar, beat, ms }]) };
}

/** Drags a sync point to a new audio time (between its neighbours). */
export function moveSyncPoint(
  audio: AudioLanesSettings,
  bar: number,
  beat: number,
  ms: number,
): AudioLanesSettings {
  const sync = normalizeSync(audio.sync);
  const i = sync.findIndex((p) => p.bar === bar && (p.beat ?? 0) === beat);
  if (i < 0) return audio;
  const min = (sync[i - 1]?.ms ?? -Infinity) + 1;
  const max = (sync[i + 1]?.ms ?? Infinity) - 1;
  const clamped = Math.max(0, Math.min(max, Math.max(min, ms)));
  return { ...audio, sync: sync.map((p, j) => (j === i ? { ...p, ms: clamped } : p)) };
}

/** Removes every sync point (the tasks menu and right-click). */
export const clearSync = (audio: AudioLanesSettings): AudioLanesSettings => ({
  ...audio,
  sync: [],
});

/**
 * Padding: slides the audio against the grid by `deltaMs` (Cmd-drag on the waveform, or the
 * entry bracket). Every sync point moves with it; without points, the zone start gets one.
 */
export function shiftPadding(
  audio: AudioLanesSettings,
  grid: SongGrid,
  deltaMs: number,
): AudioLanesSettings {
  const sync = audio.sync.length
    ? audio.sync
    : [{ bar: audio.zone.start, ms: timelineMsAt(audio, grid, audio.zone.start) }];
  // The whole map slides together: never past 0, so the gaps between points stay as they were.
  const delta = Math.max(deltaMs, -Math.min(...sync.map((p) => p.ms)));
  return { ...audio, sync: normalizeSync(sync.map((p) => ({ ...p, ms: p.ms + delta }))) };
}

/** Puts the zone start back on the start of the audio (tasks menu: Reset padding). */
export function resetPadding(audio: AudioLanesSettings, grid: SongGrid): AudioLanesSettings {
  const start = timelineMsAt(audio, grid, audio.zone.start);
  return shiftPadding(audio, grid, -start);
}

/** Moves the entry or exit bracket of the play zone to a bar. */
export function setZone(
  audio: AudioLanesSettings,
  edge: "start" | "end",
  bar: number,
): AudioLanesSettings {
  const start = edge === "start" ? Math.max(0, Math.round(bar)) : audio.zone.start;
  const end = edge === "end" ? Math.max(start + 1, Math.round(bar)) : audio.zone.end;
  const zone = { start, end: end !== null && end <= start ? start + 1 : end };
  const inside = (p: SyncPoint) => p.bar >= zone.start && (zone.end === null || p.bar <= zone.end);
  return { ...audio, zone, sync: audio.sync.filter(inside) };
}

/**
 * The tempo of each sync segment, for the BPM labels: the score's tempo there, scaled by how much
 * faster or slower the audio plays the segment than the score does.
 */
export function segmentBpms(
  audio: AudioLanesSettings,
  grid: SongGrid,
  scoreBpmAt: (bar: number) => number,
): { bar: number; beat: number; bpm: number }[] {
  const pairs = normalizeSync(audio.sync).map((p) => ({
    ...p,
    songMs: songMsAt(grid, p.bar, p.beat),
  }));
  return pairs.flatMap((p, i) => {
    const next = pairs[i + 1];
    if (!next) return [];
    const song = next.songMs - p.songMs;
    const heard = next.ms - p.ms;
    if (song <= 0 || heard <= 0) return [];
    return [{ bar: p.bar, beat: p.beat ?? 0, bpm: (scoreBpmAt(p.bar) * song) / heard }];
  });
}

/** Score tempo changes that make the score follow the audio (tasks menu: tempo from sync points). */
export function tempoChangesFromSync(
  audio: AudioLanesSettings,
  grid: SongGrid,
  scoreBpmAt: (bar: number) => number,
): { bar: number; bpm: number }[] {
  return segmentBpms(audio, grid, scoreBpmAt)
    .filter((s) => s.beat === 0)
    .map((s) => ({ bar: s.bar, bpm: Math.round(s.bpm * 10) / 10 }));
}

/** The timeline point at a fractional bar (between the bar's start and the next one's). */
export function timelineMsAtBar(audio: AudioLanesSettings, grid: SongGrid, bar: number): number {
  const whole = Math.max(0, Math.floor(bar));
  const start = timelineMsAt(audio, grid, whole);
  return start + (bar - whole) * (timelineMsAt(audio, grid, whole + 1) - start);
}

/**
 * Sync points on every bar of the play zone from beats found in a clip's file: bar `b` of the
 * zone starts on the detected beat `b × beats-per-bar` (file ms, placed on the timeline where
 * the clip plays it).
 */
export function syncFromDetectedBeats(
  beats: readonly number[],
  grid: SongGrid,
  clip: { startMs: number; playrate: number; takes: readonly { offsetMs: number }[]; take: number },
  zoneStart = 0,
): SyncPoint[] {
  const offset = clip.takes[clip.take]?.offsetMs ?? 0;
  const points: SyncPoint[] = [];
  let beat = beats.findIndex((ms) => ms >= offset);
  if (beat < 0) return points;
  for (let bar = zoneStart; bar < grid.barTimes.length; bar++) {
    const ms = beats[beat];
    if (ms === undefined) break;
    points.push({ bar, ms: clip.startMs + (ms - offset) / clip.playrate });
    beat += grid.beats[bar] ?? 4;
  }
  return normalizeSync(points);
}

/**
 * How many bars the score lacks for its audio: the bars past `scoreBars` that clips still play in
 * (0 when the score is long enough). Playback follows the score, so audio past its last bar is
 * heard only once the score has bars there.
 */
export function barsToFitAudio(
  audio: AudioLanesSettings,
  grid: SongGrid,
  scoreBars: number,
): number {
  const end = lanesEndMs(audio);
  if (end <= 0) return 0;
  // A clip ending a hair into a bar does not need that bar.
  const needed = Math.ceil(barAtTimelineMs(audio, grid, end) - 0.01);
  return Math.max(0, needed - scoreBars);
}
