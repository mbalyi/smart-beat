/**
 * Practice together: the shared clock. Two apps exchange timestamps (the NTP idea) and
 * estimate how far the other app's clock is from this one, so a start time can be agreed.
 * Pure maths: no timers and no network, so every number here is testable.
 */

/**
 * One round trip. `t0` is when this app sent the ping and `t3` when the answer came back
 * (both on this app's clock); `t1` is when the peer got it and `t2` when it answered
 * (both on the peer's clock).
 */
export interface ClockSample {
  t0: number;
  t1: number;
  t2: number;
  t3: number;
}

/** What one round trip says: the peer's clock minus ours, and the time spent on the wire. */
export interface Exchange {
  offset: number;
  rtt: number;
  /** When it was measured, on this app's clock. */
  at: number;
}

export type SyncBucket = "none" | "excellent" | "good" | "unstable";

/** The sync-quality indicator: an error margin and a word for it. */
export interface SyncQuality {
  /** The expected error of a converted time, in milliseconds (±). */
  errorMs: number;
  bucket: SyncBucket;
}

export function exchange(sample: ClockSample): Exchange {
  const { t0, t1, t2, t3 } = sample;
  return {
    offset: (t1 - t0 + (t2 - t3)) / 2,
    rtt: t3 - t0 - (t2 - t1),
    at: t3,
  };
}

/** The error margins of the Excellent and Good buckets (anything above is Unstable). */
export const EXCELLENT_MS = 5;
export const GOOD_MS = 15;
/** Fewest accepted round trips before a clock estimate is trusted. */
export const MIN_SAMPLES = 4;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

/** The scaled median absolute deviation: a spike-proof spread (about one standard deviation). */
const spread = (values: number[]): number => {
  const mid = median(values);
  return 1.4826 * median(values.map((v) => Math.abs(v - mid)));
};

/** A drift larger than this is a broken clock, not a skew; it is ignored. */
const MAX_SKEW = 5e-4;
/** The span of samples (ms) needed before a skew is fitted. */
const SKEW_SPAN_MS = 10_000;

export interface ClockEstimatorOptions {
  /** How many recent round trips are remembered. */
  window?: number;
  /** How many of the lowest-RTT trips the estimate is built from. */
  best?: number;
}

/**
 * A rolling estimate of the peer's clock. The round trips with the smallest RTT are the most
 * trustworthy (the delay there is the most symmetric), so only those count; those whose offset
 * is far from the rest (a Wi-Fi hiccup) are dropped; and a skew is fitted over a long session.
 */
export class ClockEstimator {
  private readonly window: number;
  private readonly best: number;
  private samples: Exchange[] = [];
  private rejected = 0;

  constructor({ window = 40, best = 10 }: ClockEstimatorOptions = {}) {
    this.window = window;
    this.best = best;
  }

  /** Adds a round trip. Returns false when it was unusable (a negative RTT, a clock jump). */
  add(sample: ClockSample): boolean {
    const x = exchange(sample);
    if (!Number.isFinite(x.offset) || !Number.isFinite(x.rtt) || x.rtt < 0) {
      this.rejected += 1;
      return false;
    }
    this.samples.push(x);
    if (this.samples.length > this.window) this.samples.shift();
    return true;
  }

  /** Forgets everything, for a new connection or after the computer slept. */
  reset() {
    this.samples = [];
    this.rejected = 0;
  }

  get count(): number {
    return this.samples.length;
  }

  /** Round trips that were refused as unusable. */
  get refused(): number {
    return this.rejected;
  }

  /** The round trips the estimate uses: the fastest ones, without the outliers. */
  private trusted(): Exchange[] {
    const fastest = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, this.best);
    if (fastest.length < 3) return fastest;
    const offsets = fastest.map((s) => s.offset);
    const mid = median(offsets);
    // At least 1 ms of slack, so an almost-identical set does not throw out its own noise.
    const limit = Math.max(1, 3 * spread(offsets));
    const kept = fastest.filter((s) => Math.abs(s.offset - mid) <= limit);
    return kept.length ? kept : fastest;
  }

  /** The skew (peer ms gained per local ms), from all remembered trips; 0 until there is enough data. */
  private skew(): number {
    const pool = this.samples;
    if (pool.length < 6) return 0;
    const first = pool[0]?.at ?? 0;
    const span = (pool[pool.length - 1]?.at ?? 0) - first;
    if (span < SKEW_SPAN_MS) return 0;
    const offsets = pool.map((s) => s.offset);
    const mid = median(offsets);
    const limit = Math.max(1, 3 * spread(offsets));
    const fit = pool.filter((s) => Math.abs(s.offset - mid) <= limit);
    if (fit.length < 6) return 0;
    const mx = fit.reduce((a, s) => a + s.at, 0) / fit.length;
    const my = fit.reduce((a, s) => a + s.offset, 0) / fit.length;
    let num = 0;
    let den = 0;
    for (const s of fit) {
      num += (s.at - mx) * (s.offset - my);
      den += (s.at - mx) ** 2;
    }
    const slope = den > 0 ? num / den : 0;
    return Math.abs(slope) > MAX_SKEW ? 0 : slope;
  }

  /** Whether enough round trips came back to trust the estimate. */
  get ready(): boolean {
    return this.samples.length >= MIN_SAMPLES;
  }

  /** The peer's clock minus ours at the local time `now`; 0 until the first round trip. */
  offsetAt(now: number): number {
    const used = this.trusted();
    if (!used.length) return 0;
    const mean = used.reduce((a, s) => a + s.offset, 0) / used.length;
    const meanAt = used.reduce((a, s) => a + s.at, 0) / used.length;
    return mean + this.skew() * (now - meanAt);
  }

  /** The lowest RTT seen recently (what the wire can do on a good moment). */
  get bestRtt(): number {
    return this.samples.length ? Math.min(...this.samples.map((s) => s.rtt)) : Infinity;
  }

  /** The sync-quality indicator: half the best RTT plus the spread of the offsets. */
  quality(): SyncQuality {
    if (!this.ready) return { errorMs: Infinity, bucket: "none" };
    const used = this.trusted();
    const jitter = used.length > 1 ? spread(used.map((s) => s.offset)) : 0;
    const errorMs = Math.round((this.bestRtt / 2 + jitter) * 10) / 10;
    const bucket: SyncBucket =
      errorMs <= EXCELLENT_MS ? "excellent" : errorMs <= GOOD_MS ? "good" : "unstable";
    return { errorMs, bucket };
  }
}

/** "±3 ms" for a measured quality, or a dash before there is one. */
export const errorText = (quality: SyncQuality): string =>
  Number.isFinite(quality.errorMs) ? `±${quality.errorMs} ms` : "—";

/** The peer's clock reading for a local time. */
export const toPeerTime = (local: number, offset: number): number => local + offset;
/** The local time at which the peer's clock reads `peer`. */
export const toLocalTime = (peer: number, offset: number): number => peer - offset;
