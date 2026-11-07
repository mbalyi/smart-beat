import { beforeEach, describe, expect, it } from "vitest";

import {
  PRESETS,
  autoPreset,
  readQualityChoice,
  resolvePreset,
  storeQualityChoice,
} from "@/lib/practice-together/quality-presets";
import { leadTimeMs } from "@/lib/practice-together/latency";

const stats = (p95: number, jitter = 1, samples = 20) => ({ samples, p50: p95 / 2, p95, jitter });
const quality = (errorMs: number) =>
  ({
    errorMs,
    bucket: errorMs <= 5 ? "excellent" : errorMs <= 15 ? "good" : "unstable",
  }) as const;

describe("presets", () => {
  it("trade latency for safety in order", () => {
    expect(PRESETS.tight.leadFloorMs).toBeLessThan(PRESETS.balanced.leadFloorMs);
    expect(PRESETS.balanced.leadFloorMs).toBeLessThan(PRESETS.safe.leadFloorMs);
    expect(PRESETS.tight.bufferFrames).toBeLessThan(PRESETS.safe.bufferFrames);
  });

  it("change the lead time measurably on the same network", () => {
    const s = stats(10);
    const lead = (name: keyof typeof PRESETS) =>
      leadTimeMs(s, PRESETS[name].leadFloorMs, PRESETS[name].jitterFactor);
    expect(lead("safe") - lead("tight")).toBeGreaterThanOrEqual(600);
  });
});

describe("auto", () => {
  it("is balanced until it has measured", () => {
    expect(autoPreset({ errorMs: Infinity, bucket: "none" }, stats(5, 1, 0))).toBe("balanced");
  });

  it("picks tight on a quiet network, safe on a rough one", () => {
    expect(autoPreset(quality(3), stats(10))).toBe("tight");
    expect(autoPreset(quality(10), stats(60))).toBe("balanced");
    expect(autoPreset(quality(30), stats(300, 40))).toBe("safe");
  });

  it("is only used when chosen", () => {
    expect(resolvePreset("safe", quality(2), stats(5))).toBe("safe");
    expect(resolvePreset("auto", quality(2), stats(5))).toBe("tight");
  });
});

describe("remembered choice", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to auto and keeps what was chosen", () => {
    expect(readQualityChoice()).toBe("auto");
    storeQualityChoice("tight");
    expect(readQualityChoice()).toBe("tight");
  });

  it("falls back on junk", () => {
    localStorage.setItem("smart-beat:practice-together:quality", "turbo");
    expect(readQualityChoice()).toBe("auto");
  });
});
