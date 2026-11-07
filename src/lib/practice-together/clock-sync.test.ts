import { describe, expect, it } from "vitest";

import {
  ClockEstimator,
  exchange,
  toLocalTime,
  toPeerTime,
  type ClockSample,
} from "@/lib/practice-together/clock-sync";

/**
 * A simulated wire: the peer's clock runs `offset` ahead (and `skew` faster), each way takes
 * `up` and `down` milliseconds, and the peer answers after `hold` ms.
 */
function trip(
  now: number,
  { offset = 0, skew = 0, up = 2, down = 2, hold = 0.1 } = {},
): ClockSample {
  const peer = (local: number) => local + offset + skew * local;
  return {
    t0: now,
    t1: peer(now + up),
    t2: peer(now + up + hold),
    t3: now + up + hold + down,
  };
}

describe("exchange", () => {
  it("measures the offset and the time on the wire", () => {
    const x = exchange(trip(1000, { offset: 500, up: 3, down: 3, hold: 1 }));
    expect(x.offset).toBeCloseTo(500, 6);
    expect(x.rtt).toBeCloseTo(6, 6);
  });

  it("is off by half the asymmetry, which is why the smallest RTT is trusted", () => {
    const x = exchange(trip(0, { offset: 0, up: 10, down: 2 }));
    expect(x.offset).toBeCloseTo(4, 6);
  });
});

describe("ClockEstimator", () => {
  it("has no estimate before enough round trips", () => {
    const clock = new ClockEstimator();
    expect(clock.ready).toBe(false);
    expect(clock.quality().bucket).toBe("none");
    expect(clock.offsetAt(0)).toBe(0);
    clock.add(trip(0, { offset: 100 }));
    expect(clock.ready).toBe(false);
  });

  it("finds a steady offset", () => {
    const clock = new ClockEstimator();
    for (let i = 0; i < 8; i += 1) clock.add(trip(i * 1000, { offset: 1234.5 }));
    expect(clock.ready).toBe(true);
    expect(clock.offsetAt(8000)).toBeCloseTo(1234.5, 1);
    expect(clock.quality().bucket).toBe("excellent");
  });

  it("ignores latency spikes", () => {
    const clock = new ClockEstimator();
    for (let i = 0; i < 12; i += 1) {
      const spike = i % 4 === 3;
      clock.add(trip(i * 1000, { offset: 50, up: spike ? 90 : 2, down: 2 }));
    }
    expect(clock.offsetAt(12_000)).toBeCloseTo(50, 0);
  });

  it("rejects an offset far from the rest of the fast trips", () => {
    const clock = new ClockEstimator();
    for (let i = 0; i < 9; i += 1) clock.add(trip(i * 1000, { offset: 10 }));
    // Quick, but one-sided: a Wi-Fi retry on the way up.
    clock.add(trip(9000, { offset: 10, up: 1, down: 1, hold: 0 }));
    clock.add({ t0: 10_000, t1: 10_200, t2: 10_200.1, t3: 10_004 });
    expect(clock.offsetAt(10_000)).toBeCloseTo(10, 0);
  });

  it("refuses a negative round trip", () => {
    const clock = new ClockEstimator();
    expect(clock.add({ t0: 100, t1: 0, t2: 300, t3: 101 })).toBe(false);
    expect(clock.refused).toBe(1);
    expect(clock.count).toBe(0);
  });

  it("follows a clock that runs fast", () => {
    const clock = new ClockEstimator();
    // 200 ppm for a minute: 12 ms of drift.
    for (let i = 0; i < 60; i += 1) clock.add(trip(i * 1000, { offset: 20, skew: 2e-4 }));
    const expected = 20 + 2e-4 * 70_000;
    expect(clock.offsetAt(70_000)).toBeCloseTo(expected, 0);
  });

  it("does not trust an impossible skew", () => {
    const clock = new ClockEstimator();
    for (let i = 0; i < 30; i += 1) clock.add(trip(i * 1000, { offset: 0, skew: 5e-3 }));
    // The fit is dropped, so the estimate stays near the recent offsets, not extrapolated.
    expect(Math.abs(clock.offsetAt(60_000) - 5e-3 * 60_000)).toBeGreaterThan(50);
  });

  it("buckets the quality by the expected error", () => {
    const good = new ClockEstimator();
    for (let i = 0; i < 6; i += 1) good.add(trip(i * 1000, { up: 8, down: 8 }));
    expect(good.quality()).toMatchObject({ bucket: "good" });
    expect(good.quality().errorMs).toBeCloseTo(8, 1);

    const bad = new ClockEstimator();
    for (let i = 0; i < 6; i += 1) bad.add(trip(i * 1000, { up: 40, down: 40 }));
    expect(bad.quality().bucket).toBe("unstable");
  });

  it("forgets everything on reset", () => {
    const clock = new ClockEstimator();
    for (let i = 0; i < 6; i += 1) clock.add(trip(i * 1000, { offset: 9 }));
    clock.reset();
    expect(clock.ready).toBe(false);
    expect(clock.bestRtt).toBe(Infinity);
  });

  it("keeps only the recent window", () => {
    const clock = new ClockEstimator({ window: 5 });
    for (let i = 0; i < 20; i += 1) clock.add(trip(i * 1000, { offset: 3 }));
    expect(clock.count).toBe(5);
  });
});

describe("time conversion", () => {
  it("converts both ways", () => {
    expect(toPeerTime(1000, 250)).toBe(1250);
    expect(toLocalTime(1250, 250)).toBe(1000);
  });
});
