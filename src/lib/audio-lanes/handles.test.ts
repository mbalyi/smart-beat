import { describe, expect, it } from "vitest";

import {
  clampFadeMs,
  clampGainDb,
  fadeHandleX,
  fadeKeyMs,
  fadeLengthPatch,
  fadeMsAtX,
  fadeShapePatch,
  fadeWidthPx,
  formatFadeMs,
  formatGainDb,
  gainAfterDrag,
  gainKeyDb,
  maxFadeMs,
  removeFadePatch,
  sliderKeyValue,
} from "@/lib/audio-lanes/handles";
import { MAX_GAIN_DB, MIN_GAIN_DB, newClip } from "@/lib/audio-lanes/model";
import type { AudioClip } from "@/lib/tauri";

/** 10 px per second of timeline. */
const toX = (ms: number) => ms / 100;
const toMs = (x: number) => x * 100;

function clip(patch: Partial<AudioClip> = {}): AudioClip {
  return { ...newClip("s", "take.wav", 2000, 4000, "c"), ...patch };
}

describe("fade limits", () => {
  it("lets a fade run the whole clip less the fade at the other end", () => {
    const c = clip({ fadeOut: { ms: 1000, shape: "linear" } });
    expect(maxFadeMs(c, "in")).toBe(3000);
    expect(maxFadeMs(c, "out")).toBe(4000);
  });

  it("rounds and clamps fade lengths", () => {
    const c = clip();
    expect(clampFadeMs(c, "in", -20)).toBe(0);
    expect(clampFadeMs(c, "in", 123.6)).toBe(124);
    expect(clampFadeMs(c, "in", 9000)).toBe(4000);
    expect(clampFadeMs(c, "out", Number.NaN)).toBe(0);
  });
});

describe("fade pixels", () => {
  it("measures fades on screen, at the clip's playrate", () => {
    const c = clip({
      fadeIn: { ms: 1000, shape: "linear" },
      fadeOut: { ms: 500, shape: "linear" },
    });
    expect(fadeWidthPx(c, "in", toX)).toBe(10);
    expect(fadeWidthPx(c, "out", toX)).toBe(5);
    expect(fadeWidthPx({ ...c, playrate: 2 }, "in", toX)).toBe(5);
    expect(fadeWidthPx(clip(), "in", toX)).toBe(0);
  });

  it("puts the handles at the inner end of each fade", () => {
    const c = clip({
      fadeIn: { ms: 1000, shape: "linear" },
      fadeOut: { ms: 500, shape: "linear" },
    });
    expect(fadeHandleX(c, "in", toX)).toBe(30);
    expect(fadeHandleX(c, "out", toX)).toBe(55);
    expect(fadeHandleX(clip(), "out", toX)).toBe(60);
  });

  it("turns a handle position into a fade length in source ms", () => {
    const c = clip();
    expect(fadeMsAtX(c, "in", 25, toMs)).toBe(500);
    expect(fadeMsAtX(c, "out", 50, toMs)).toBe(1000);
    // Past the clip's start, or beyond its other end: clamped.
    expect(fadeMsAtX(c, "in", 10, toMs)).toBe(0);
    expect(fadeMsAtX(c, "in", 90, toMs)).toBe(4000);
    expect(fadeMsAtX(c, "out", 90, toMs)).toBe(0);
    // A clip at double speed covers half the timeline: the same pixels are twice the source.
    expect(fadeMsAtX({ ...c, playrate: 2 }, "in", 25, toMs)).toBe(1000);
  });
});

describe("fade patches", () => {
  const auto = clip({ fadeIn: { ms: 300, shape: "equalPower", auto: true } });

  it("sets a length, keeps the curve and makes the fade the user's own", () => {
    expect(fadeLengthPatch(auto, "in", 800)).toEqual({ fadeIn: { ms: 800, shape: "equalPower" } });
    expect(fadeLengthPatch(auto, "out", 99999)).toEqual({
      fadeOut: { ms: 3700, shape: "linear" },
    });
  });

  it("changes the curve and removes a fade", () => {
    expect(fadeShapePatch(auto, "in", "sCurve")).toEqual({ fadeIn: { ms: 300, shape: "sCurve" } });
    expect(removeFadePatch("out")).toEqual({ fadeOut: { ms: 0, shape: "linear" } });
  });
});

describe("gain", () => {
  it("clamps and rounds to 0.1 dB", () => {
    expect(clampGainDb(3.14159)).toBe(3.1);
    expect(clampGainDb(100)).toBe(MAX_GAIN_DB);
    expect(clampGainDb(-100)).toBe(MIN_GAIN_DB);
    expect(clampGainDb(Number.NaN)).toBe(0);
  });

  it("goes up when dragged up, a tenth as fast with Shift", () => {
    expect(gainAfterDrag(0, -8, false)).toBe(2);
    expect(gainAfterDrag(0, 8, false)).toBe(-2);
    expect(gainAfterDrag(0, -8, true)).toBeCloseTo(0.2);
    expect(gainAfterDrag(20, -100, false)).toBe(MAX_GAIN_DB);
    expect(gainAfterDrag(-50, 100, false)).toBe(MIN_GAIN_DB);
  });

  it("formats with a sign", () => {
    expect(formatGainDb(3.5)).toBe("+3.5 dB");
    expect(formatGainDb(0)).toBe("0.0 dB");
    expect(formatGainDb(-6)).toBe("-6.0 dB");
    expect(formatFadeMs(199.6)).toBe("200 ms");
  });
});

describe("keys", () => {
  const steps = { step: 1, page: 10, min: 0, max: 20 };

  it("maps slider keys and ignores others", () => {
    expect(sliderKeyValue("ArrowRight", 5, steps)).toBe(6);
    expect(sliderKeyValue("ArrowUp", 5, steps)).toBe(6);
    expect(sliderKeyValue("ArrowLeft", 5, steps)).toBe(4);
    expect(sliderKeyValue("ArrowDown", 0, steps)).toBe(0);
    expect(sliderKeyValue("PageUp", 15, steps)).toBe(20);
    expect(sliderKeyValue("PageDown", 5, steps)).toBe(0);
    expect(sliderKeyValue("Home", 5, steps)).toBe(0);
    expect(sliderKeyValue("End", 5, steps)).toBe(20);
    expect(sliderKeyValue("a", 5, steps)).toBeNull();
  });

  it("steps fades by 50 ms, 5 ms with Shift, within the clip", () => {
    const c = clip({
      fadeIn: { ms: 100, shape: "linear" },
      fadeOut: { ms: 3000, shape: "linear" },
    });
    expect(fadeKeyMs(c, "in", "ArrowRight", false)).toBe(150);
    expect(fadeKeyMs(c, "in", "ArrowLeft", true)).toBe(95);
    expect(fadeKeyMs(c, "in", "End", false)).toBe(1000);
    expect(fadeKeyMs(c, "out", "Enter", false)).toBeNull();
  });

  it("steps gain by 1 dB, 0.1 dB with Shift", () => {
    expect(gainKeyDb(0, "ArrowUp", false)).toBe(1);
    expect(gainKeyDb(0, "ArrowDown", true)).toBe(-0.1);
    expect(gainKeyDb(MAX_GAIN_DB, "PageUp", false)).toBe(MAX_GAIN_DB);
    expect(gainKeyDb(0, "Home", false)).toBe(MIN_GAIN_DB);
    expect(gainKeyDb(0, "x", false)).toBeNull();
  });
});
