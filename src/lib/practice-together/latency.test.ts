import { describe, expect, it } from "vitest";

import {
  LatencyTracker,
  MAX_LEAD_MS,
  leadTimeMs,
  tooPoor,
  type LatencyStats,
} from "@/lib/practice-together/latency";

const stats = (over: Partial<LatencyStats> = {}): LatencyStats => ({
  samples: 20,
  p50: 4,
  p95: 8,
  jitter: 1,
  ...over,
});

describe("LatencyTracker", () => {
  it("reports percentiles of the recent round trips", () => {
    const tracker = new LatencyTracker();
    for (let rtt = 1; rtt <= 100; rtt += 1) tracker.add(rtt);
    const s = tracker.stats();
    expect(s.samples).toBe(40);
    expect(s.p50).toBeGreaterThan(60);
    expect(s.p95).toBeGreaterThanOrEqual(s.p50);
  });

  it("measures jitter as the change between neighbours", () => {
    const steady = new LatencyTracker();
    const noisy = new LatencyTracker();
    for (let i = 0; i < 30; i += 1) {
      steady.add(5);
      noisy.add(i % 2 ? 5 : 25);
    }
    expect(steady.stats().jitter).toBe(0);
    expect(noisy.stats().jitter).toBeGreaterThan(10);
  });

  it("ignores garbage and resets", () => {
    const tracker = new LatencyTracker();
    tracker.add(-1);
    tracker.add(Number.NaN);
    expect(tracker.stats().samples).toBe(0);
    tracker.add(3);
    tracker.reset();
    expect(tracker.stats()).toEqual({ samples: 0, p50: 0, p95: 0, jitter: 0 });
  });
});

describe("leadTimeMs", () => {
  it("never goes below the preset floor", () => {
    expect(leadTimeMs(stats(), 450, 3)).toBe(450);
  });

  it("grows with a slow or jittery wire", () => {
    const calm = leadTimeMs(stats({ p95: 20, jitter: 1 }), 250, 3);
    const rough = leadTimeMs(stats({ p95: 400, jitter: 40 }), 250, 3);
    expect(rough).toBeGreaterThan(calm);
    // A whole round trip (the guest's "ready" has to come back), the jitter, preparing and room.
    expect(rough).toBe(Math.round(400 + 120 + 100 + 30));
  });

  it("budgets a full round trip, so a 110 ms each way wire is not ready too late", () => {
    // Tight (floor 250) on 110 ms each way: the old half-round-trip lead was 250 ms, but the
    // start needs the command out, the guest preparing, and "ready" back: 220 + 100 + 30.
    expect(leadTimeMs(stats({ p95: 220, jitter: 0 }), 250, 3)).toBeGreaterThanOrEqual(350);
  });

  it("is capped", () => {
    expect(leadTimeMs(stats({ p95: 20_000, jitter: 5000 }), 250, 3)).toBe(MAX_LEAD_MS);
  });
});

describe("tooPoor", () => {
  it("warns on a big error or a slow wire, but not before measuring", () => {
    expect(tooPoor({ errorMs: 5, bucket: "excellent" }, stats())).toBe(false);
    expect(tooPoor({ errorMs: 60, bucket: "unstable" }, stats())).toBe(true);
    expect(tooPoor({ errorMs: 10, bucket: "good" }, stats({ p95: 400 }))).toBe(true);
    expect(tooPoor({ errorMs: Infinity, bucket: "none" }, stats())).toBe(false);
  });
});
