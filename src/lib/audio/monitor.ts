/**
 * The monitor track: the audio input (Settings › Audio), played live through the native engine
 * with its own effects, so a guitarist hears their guitar through an amp and pedals while the
 * song plays. Each song keeps its own monitor track; a new one starts from the last one used,
 * so the same rig comes along to the next song.
 */
import {
  defaultEffect,
  EFFECT_LABELS,
  MAX_TRACK_EFFECTS,
  type EffectSlot,
  type EffectType,
} from "@/lib/audio/effects";
import { FLAT_EQ } from "@/lib/score/mixer";
import type { MonitorParams, MonitorTrackSettings } from "@/lib/tauri";

export const MONITOR_STORAGE_KEY = "smart-beat:monitor-track";

/** The track's name in the mixer and the pedalboard. */
export const MONITOR_NAME = "Monitor";

export const DEFAULT_MONITOR: MonitorTrackSettings = {
  enabled: true,
  volume: 0.8,
  pan: 0,
  mute: false,
  solo: false,
  eq: FLAT_EQ,
  effects: [],
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Check persisted JSON before it reaches typed IPC. Drop damaged or obsolete blocks.
function effect(value: unknown): value is EffectSlot {
  if (!record(value) || typeof value.type !== "string" || !Object.hasOwn(EFFECT_LABELS, value.type))
    return false;
  const template = defaultEffect(value.type as EffectType);
  if (
    !Object.entries(template).every(([key, sample]) => {
      const v = value[key];
      if (typeof sample === "number") return typeof v === "number" && Number.isFinite(v);
      if (Array.isArray(sample)) return Array.isArray(v);
      return typeof v === typeof sample;
    })
  )
    return false;
  if (
    value.type === "drive" &&
    !["boost", "overdrive", "distortion", "fuzz"].includes(String(value.mode))
  )
    return false;
  if (value.type === "ampSim" && !["clean", "crunch", "lead"].includes(String(value.voicing)))
    return false;
  if (value.type === "plugin" && !["vst3", "clap"].includes(String(value.format))) return false;
  if (value.type === "eq")
    return (value.bands as unknown[]).every(
      (band) =>
        record(band) &&
        ["lowShelf", "peak", "highShelf", "highPass", "lowPass"].includes(String(band.kind)) &&
        [band.freq, band.q, band.gainDb].every((v) => typeof v === "number" && Number.isFinite(v)),
    );
  return true;
}

function savedEq(value: unknown): MonitorTrackSettings["eq"] {
  if (!record(value)) return FLAT_EQ;
  const gain = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(-15, Math.min(15, v)) : 0;
  return {
    lowDb: gain(value.lowDb),
    midDb: gain(value.midDb),
    highDb: gain(value.highDb),
    midHz:
      typeof value.midHz === "number" && Number.isFinite(value.midHz)
        ? Math.max(200, Math.min(5000, value.midHz))
        : 1000,
    ...(Array.isArray(value.graphic) && value.graphic.length === 10
      ? { graphic: value.graphic.map(gain) }
      : {}),
  };
}

function parse(raw: string | null): MonitorTrackSettings | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<MonitorTrackSettings> | null;
    if (!value || typeof value !== "object") return null;
    const number = (v: unknown, fallback: number) =>
      typeof v === "number" && Number.isFinite(v) ? v : fallback;
    return {
      ...DEFAULT_MONITOR,
      volume: Math.min(1, Math.max(0, number(value.volume, DEFAULT_MONITOR.volume))),
      pan: Math.min(1, Math.max(-1, number(value.pan, 0))),
      eq: savedEq(value.eq),
      effects: Array.isArray(value.effects)
        ? value.effects.filter(effect).slice(0, MAX_TRACK_EFFECTS)
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * A new monitor track: the last one used (its level, pan, EQ and effects), switched on, not
 * muted and not soloed. The defaults the first time.
 */
export function newMonitorTrack(): MonitorTrackSettings {
  try {
    return structuredClone(parse(localStorage.getItem(MONITOR_STORAGE_KEY)) ?? DEFAULT_MONITOR);
  } catch {
    return structuredClone(DEFAULT_MONITOR);
  }
}

/** Remembers a monitor track for the next song's new one. */
export function rememberMonitorTrack(monitor: MonitorTrackSettings) {
  try {
    const { volume, pan, eq, effects } = monitor;
    localStorage.setItem(MONITOR_STORAGE_KEY, JSON.stringify({ volume, pan, eq, effects }));
  } catch {
    // Not remembered: the next new monitor track starts from the defaults.
  }
}

/** How the monitor track plays (without its effects). */
export function monitorParams(monitor: MonitorTrackSettings): MonitorParams {
  return {
    enabled: monitor.enabled,
    volume: monitor.volume,
    pan: monitor.pan,
    mute: monitor.mute,
    solo: monitor.solo,
    eq: monitor.eq,
  };
}

/** "8 ms" (rounded; below 1 ms: "< 1 ms"). */
export function describeLatency(ms: number): string {
  return ms < 1 ? "< 1 ms" : `${Math.round(ms)} ms`;
}
