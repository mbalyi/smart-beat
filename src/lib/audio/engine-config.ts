/**
 * Turns what the mixer stores per bar (automation points, sound switches,
 * audio track sync points) into song positions in MIDI ticks for the native
 * engine.
 *
 * Bars play in the order repeats and jumps give, so a bar can be played more
 * than once: automation and sound switches apply on every pass (as in Guitar
 * Pro, where automation belongs to the bar), sync points to the first pass.
 */
import { engineDrumMix } from "@/lib/audio/drum-elements";
import type { EngineExtras } from "@/lib/audio/native-engine";
import type { Score } from "@/lib/score/model";
import { soundChains, trackAutomation, trackEq, trackSoundsOf } from "@/lib/score/mixer";
import type {
  AudioTrackSettings,
  AutomationPoint,
  BackingParams,
  EngineAutomation,
  MixerSettings,
  SyncPoint,
  TrackAutomation,
} from "@/lib/tauri";

/** One pass through a bar during playback: its master bar and ticks. */
export interface BarOccurrence {
  bar: number;
  start: number;
  end: number;
}

/** What alphaTab's tick lookup provides (only the parts used here). */
export interface TickLookupLike {
  masterBars: { start: number; end: number; masterBar: { index: number } }[];
}

/** Every bar pass in playback order (from alphaTab's lookup, else straight through). */
export function barOccurrences(score: Score, lookup: TickLookupLike | null): BarOccurrence[] {
  if (lookup && lookup.masterBars.length > 0) {
    return lookup.masterBars.map((m) => ({ bar: m.masterBar.index, start: m.start, end: m.end }));
  }
  return score.masterBars.map((m) => ({
    bar: m.index,
    start: m.start,
    end: m.start + m.calculateDuration(),
  }));
}

/** The first pass through each bar. */
export function firstOccurrence(occurrences: readonly BarOccurrence[]): Map<number, BarOccurrence> {
  const first = new Map<number, BarOccurrence>();
  for (const o of occurrences) if (!first.has(o.bar)) first.set(o.bar, o);
  return first;
}

/** The tick of a (fractional) bar position on its first pass. */
export function tickOfBar(occurrences: readonly BarOccurrence[], bar: number): number {
  const whole = Math.floor(bar);
  const o = occurrences.find((x) => x.bar === whole);
  if (!o) {
    const last = occurrences[occurrences.length - 1];
    return last ? last.end : 0;
  }
  return Math.round(o.start + (bar - whole) * (o.end - o.start));
}

/** A lane's value at a bar position: linear between points, flat at the ends. */
export function laneValueAt(points: readonly AutomationPoint[], bar: number): number | null {
  if (points.length === 0) return null;
  const after = points.findIndex((p) => p.bar > bar);
  if (after === 0) return points[0]!.value;
  if (after === -1) return points[points.length - 1]!.value;
  const a = points[after - 1]!;
  const b = points[after]!;
  return b.bar === a.bar
    ? a.value
    : a.value + ((bar - a.bar) / (b.bar - a.bar)) * (b.value - a.value);
}

/** A lane's on/off value at a bar position (the last point at or before it). */
export function laneStepAt(points: readonly AutomationPoint[], bar: number): number | null {
  if (points.length === 0) return null;
  let value = points[0]!.value;
  for (const p of points) if (p.bar <= bar) value = p.value;
  return value;
}

/**
 * A lane in ticks: on each pass through a bar, its value where the pass
 * starts, the points inside the bar, and its value where the pass ends.
 */
export function laneTicks(
  points: readonly AutomationPoint[],
  occurrences: readonly BarOccurrence[],
  step = false,
): [number, number][] {
  if (points.length === 0) return [];
  const at = step ? laneStepAt : laneValueAt;
  const out: [number, number][] = [];
  for (const o of occurrences) {
    const length = o.end - o.start;
    out.push([o.start, at(points, o.bar)!]);
    for (const p of points) {
      if (p.bar > o.bar && p.bar < o.bar + 1) {
        out.push([Math.round(o.start + (p.bar - o.bar) * length), p.value]);
      }
    }
    if (!step && length > 1) out.push([o.end - 1, at(points, o.bar + 1)!]);
  }
  return out;
}

export function automationTicks(
  automation: TrackAutomation,
  occurrences: readonly BarOccurrence[],
): EngineAutomation {
  if (!automation.enabled) return { enabled: false, volume: [], pan: [], mute: [] };
  return {
    enabled: true,
    volume: laneTicks(automation.volume, occurrences),
    pan: laneTicks(automation.pan, occurrences),
    mute: laneTicks(automation.mute, occurrences, true),
  };
}

/** Sound switches in ticks: on every pass, wherever the sound changes. */
export function soundSwitchTicks(
  mix: MixerSettings,
  track: number,
  occurrences: readonly BarOccurrence[],
): [number, number][] {
  const own = trackSoundsOf(mix, track);
  if (!own) return [];
  const soundAt = (bar: number) => {
    let sound = 0;
    for (const s of own.switches) if (s.bar <= bar) sound = s.sound;
    return sound;
  };
  const out: [number, number][] = [];
  let current = 0;
  for (const o of occurrences) {
    const sound = soundAt(o.bar);
    if (sound !== current) {
      out.push([o.start, sound]);
      current = sound;
    }
  }
  return out;
}

/** Everything about a track's sounds for the engine. */
export function engineSounds(
  mix: MixerSettings,
  track: number,
  occurrences: readonly BarOccurrence[],
) {
  return { chains: soundChains(mix, track), switches: soundSwitchTicks(mix, track, occurrences) };
}

/** Sync points in ticks (first pass through each bar). */
export function syncTicks(
  sync: readonly SyncPoint[],
  occurrences: readonly BarOccurrence[],
): { tick: number; ms: number }[] {
  const first = firstOccurrence(occurrences);
  return sync.flatMap((p) => {
    const o = first.get(p.bar);
    return o ? [{ tick: o.start, ms: p.ms }] : [];
  });
}

/** Milliseconds from the song start to each bar (first pass), at the score's tempo. */
export function barTimesMs(score: Score, occurrences: readonly BarOccurrence[]): number[] {
  const times: number[] = new Array<number>(score.masterBars.length).fill(NaN);
  let ms = 0;
  let bpm = score.tempo || 120;
  for (const o of occurrences) {
    const master = score.masterBars[o.bar];
    const automation = master?.tempoAutomations?.[0];
    if (automation && automation.value > 0) bpm = automation.value;
    if (Number.isNaN(times[o.bar]!)) times[o.bar] = ms;
    // 960 ticks per quarter note.
    ms += ((o.end - o.start) / 960) * (60_000 / bpm);
  }
  // Bars that are never played (after a jump) keep the time of the previous one.
  let last = 0;
  return times.map((t) => (Number.isNaN(t) ? last : (last = t)));
}

/** Song ms → recording ms through the sync points (mirrors `SyncMap` in `backing.rs`). */
export function audioMsAt(
  points: readonly { songMs: number; ms: number }[],
  songMs: number,
): number {
  const sorted = [...points].sort((a, b) => a.songMs - b.songMs);
  const kept: { songMs: number; ms: number }[] = [];
  for (const p of sorted) {
    const last = kept[kept.length - 1];
    if (!last || (p.songMs > last.songMs && p.ms > last.ms)) kept.push(p);
  }
  const first = kept[0];
  if (!first) return songMs;
  if (songMs <= first.songMs) return first.ms + (songMs - first.songMs);
  const i = kept.findIndex((p) => p.songMs > songMs);
  const a = kept[(i === -1 ? kept.length : i) - 1]!;
  const b = i === -1 ? undefined : kept[i];
  return b
    ? a.ms + ((songMs - a.songMs) * (b.ms - a.ms)) / (b.songMs - a.songMs)
    : a.ms + (songMs - a.songMs);
}

/** Sync points with the song time of their bar. */
export function syncWithSongTimes(sync: readonly SyncPoint[], barTimes: readonly number[]) {
  return sync.flatMap((p) => {
    const songMs = barTimes[p.bar];
    return songMs === undefined ? [] : [{ songMs, ms: p.ms }];
  });
}

/**
 * Sync points at every tempo change (and bar 1), placed where the current
 * sync points put those bars, ready to be dragged into place.
 */
export function syncPointsFromTempo(
  score: Score,
  sync: readonly SyncPoint[],
  barTimes: readonly number[],
): SyncPoint[] {
  const mapped = syncWithSongTimes(sync, barTimes);
  const bars = new Set<number>([0]);
  for (const master of score.masterBars) {
    if (master.tempoAutomations?.length) bars.add(master.index);
  }
  const added = [...bars].map((bar) => ({
    bar,
    ms: Math.max(0, Math.round(audioMsAt(mapped, barTimes[bar] ?? 0))),
  }));
  const byBar = new Map(sync.map((p) => [p.bar, p]));
  for (const p of added) if (!byBar.has(p.bar)) byBar.set(p.bar, p);
  return [...byBar.values()].sort((a, b) => a.bar - b.bar);
}

/** The audio track's playback settings (without file and sync details). */
export function backingParams(audio: AudioTrackSettings): BackingParams {
  return {
    enabled: audio.enabled,
    volume: audio.volume,
    pan: audio.pan,
    mute: audio.mute,
    solo: audio.solo,
    eq: audio.eq,
    semitones: audio.semitones,
    cents: audio.cents,
    filter: audio.filter,
  };
}

/** Everything the native engine plays besides the notes, for this mix. */
export function engineExtras(
  mix: MixerSettings,
  occurrences: readonly BarOccurrence[],
): EngineExtras {
  return {
    sounds: mix.tracks.map((_, i) => engineSounds(mix, i, occurrences)),
    master: mix.masterEffects ?? [],
    automation: mix.tracks.map((_, i) => automationTicks(trackAutomation(mix, i), occurrences)),
    eq: mix.tracks.map((_, i) => trackEq(mix, i)),
    drums: mix.tracks.map((_, i) => {
      const drums = mix.drums?.[i];
      return drums ? engineDrumMix(drums) : null;
    }),
    masterPan: mix.masterPan ?? 0,
    backing: mix.audioTrack
      ? { params: backingParams(mix.audioTrack), sync: syncTicks(mix.audioTrack.sync, occurrences) }
      : null,
  };
}

/**
 * Song ms where each bar starts (first pass), plus where the last bar ends:
 * the time axis of the audio track's waveform.
 */
export function barTimeline(score: Score, occurrences: readonly BarOccurrence[]): number[] {
  const starts = barTimesMs(score, occurrences);
  const lastIndex = score.masterBars.length - 1;
  if (lastIndex < 0) return [0];
  let ms = 0;
  let bpm = score.tempo || 120;
  let end = starts[lastIndex] ?? 0;
  for (const o of occurrences) {
    const automation = score.masterBars[o.bar]?.tempoAutomations?.[0];
    if (automation && automation.value > 0) bpm = automation.value;
    ms += ((o.end - o.start) / 960) * (60_000 / bpm);
    if (o.bar === lastIndex) {
      end = ms;
      break;
    }
  }
  return [...starts, Math.max(end, starts[lastIndex] ?? 0)];
}
