/**
 * Practice together: how long the wire takes, and from that how far ahead of "now" a start
 * must be scheduled so the other app has time to get ready. Pure maths.
 */
import type { SyncQuality } from "@/lib/practice-together/clock-sync";

const percentile = (values: number[], p: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
};

/** What the last round trips look like. */
export interface LatencyStats {
  samples: number;
  p50: number;
  p95: number;
  /** The mean change between neighbouring round trips (RFC 3550 style). */
  jitter: number;
}

/** Remembers the recent round-trip times and summarises them. */
export class LatencyTracker {
  private rtts: number[] = [];

  private readonly window: number;

  constructor(window = 40) {
    this.window = window;
  }

  add(rtt: number) {
    if (!Number.isFinite(rtt) || rtt < 0) return;
    this.rtts.push(rtt);
    if (this.rtts.length > this.window) this.rtts.shift();
  }

  reset() {
    this.rtts = [];
  }

  stats(): LatencyStats {
    const values = this.rtts;
    let jitter = 0;
    for (let i = 1; i < values.length; i += 1) {
      jitter += (Math.abs((values[i] ?? 0) - (values[i - 1] ?? 0)) - jitter) / 16;
    }
    return {
      samples: values.length,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      jitter,
    };
  }
}

/** The room a start always needs on this computer to apply speed, loop and position. */
export const PREPARE_MARGIN_MS = 100;
/** No start is ever scheduled further ahead than this. */
export const MAX_LEAD_MS = 3000;

/**
 * How far ahead to schedule a start: the slow end of the one-way time, a few times the jitter,
 * and the time to prepare, but never below the preset's floor.
 */
export function leadTimeMs(stats: LatencyStats, floorMs: number, jitterFactor: number): number {
  const wire = stats.p95 / 2 + jitterFactor * stats.jitter + PREPARE_MARGIN_MS;
  return Math.round(Math.min(MAX_LEAD_MS, Math.max(floorMs, wire)));
}

/** The quality is too poor to stay in sync: warn the group. */
export const POOR_ERROR_MS = 40;
export const POOR_P95_RTT_MS = 250;

export function tooPoor(quality: SyncQuality, stats: LatencyStats): boolean {
  if (quality.bucket === "none") return false;
  return quality.errorMs > POOR_ERROR_MS || stats.p95 > POOR_P95_RTT_MS;
}
