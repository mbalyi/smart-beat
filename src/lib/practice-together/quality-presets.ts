/**
 * Practice together: the audio quality setting. It trades latency for safety:
 * a tight session starts sooner and corrects drift quickly but needs a good network;
 * a safe one waits longer and is calm. Auto picks one from the measured network.
 * The sound is always rendered on each computer, never streamed.
 */
import type { SyncQuality } from "@/lib/practice-together/clock-sync";
import type { LatencyStats } from "@/lib/practice-together/latency";

export type QualityChoice = "auto" | "tight" | "balanced" | "safe";
export type QualityPreset = Exclude<QualityChoice, "auto">;

export interface PresetSettings {
  /** The least time between pressing Play and the start. */
  leadFloorMs: number;
  /** How many times the jitter is added to the lead time. */
  jitterFactor: number;
  /** Time between clock pings. */
  pingMs: number;
  /** A drift under this many milliseconds is left alone. */
  driftToleranceMs: number;
  /** The largest playback-speed correction (0.01 is ±1%). */
  maxNudge: number;
  /** The native engine's audio buffer, in frames (smaller is tighter, larger is safer). */
  bufferFrames: number;
}

export const PRESETS: Record<QualityPreset, PresetSettings> = {
  tight: {
    leadFloorMs: 250,
    jitterFactor: 2,
    pingMs: 1000,
    driftToleranceMs: 12,
    maxNudge: 0.01,
    bufferFrames: 128,
  },
  balanced: {
    leadFloorMs: 450,
    jitterFactor: 3,
    pingMs: 2000,
    driftToleranceMs: 20,
    maxNudge: 0.02,
    bufferFrames: 256,
  },
  safe: {
    leadFloorMs: 900,
    jitterFactor: 4,
    pingMs: 3000,
    driftToleranceMs: 40,
    maxNudge: 0.02,
    bufferFrames: 512,
  },
};

export const QUALITY_CHOICES: QualityChoice[] = ["auto", "tight", "balanced", "safe"];

export const QUALITY_LABELS: Record<QualityChoice, string> = {
  auto: "Auto",
  tight: "Tight",
  balanced: "Balanced",
  safe: "Safe",
};

export const QUALITY_HINTS: Record<QualityChoice, string> = {
  auto: "Picks the setting from how the connection behaves.",
  tight: "Starts soonest. Best on a quiet wired or 5 GHz network.",
  balanced: "A good start for most rooms.",
  safe: "Waits longer and corrects gently. For a busy or distant connection.",
};

/** What Auto picks right now. */
export function autoPreset(quality: SyncQuality, stats: LatencyStats): QualityPreset {
  if (quality.bucket === "none" || stats.samples < 4) return "balanced";
  if (quality.errorMs <= 5 && stats.p95 <= 25 && stats.jitter <= 3) return "tight";
  if (quality.errorMs <= 15 && stats.p95 <= 100) return "balanced";
  return "safe";
}

export function resolvePreset(
  choice: QualityChoice,
  quality: SyncQuality,
  stats: LatencyStats,
): QualityPreset {
  return choice === "auto" ? autoPreset(quality, stats) : choice;
}

const KEY = "smart-beat:practice-together";

export function isQualityChoice(value: unknown): value is QualityChoice {
  return typeof value === "string" && (QUALITY_CHOICES as string[]).includes(value);
}

/** The remembered quality setting (default: Auto). */
export function readQualityChoice(): QualityChoice {
  try {
    const stored = localStorage.getItem(`${KEY}:quality`);
    return isQualityChoice(stored) ? stored : "auto";
  } catch {
    return "auto";
  }
}

export function storeQualityChoice(choice: QualityChoice) {
  try {
    localStorage.setItem(`${KEY}:quality`, choice);
  } catch {
    // Not remembered: Auto is used next time.
  }
}
