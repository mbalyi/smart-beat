import { describe, expect, it } from "vitest";

import { EMPTY_AUDIO, newClip, newLane } from "@/lib/audio-lanes/model";
import {
  FIT_MARGIN_PX,
  clampZoom,
  contentXAtMs,
  fitSpan,
  msAtViewX,
  selectionSpan,
  songSpan,
  wheelAction,
  zoomAroundLine,
  zoomAroundViewX,
  zoomAt,
} from "@/lib/audio-lanes/zoom";
import type { AudioLanesSettings } from "@/lib/tauri";

const LIMITS = { min: 10, max: 400 };
const SOURCE = "a".repeat(64);

function audio(): AudioLanesSettings {
  return {
    ...EMPTY_AUDIO,
    lanes: [
      {
        ...newLane("Vocals", "lane-a"),
        clips: [
          newClip(SOURCE, "a", 2000, 4000, "clip-a"),
          newClip(SOURCE, "b", 10_000, 5000, "clip-b"),
        ],
      },
      { ...newLane("Drums", "lane-b"), clips: [newClip(SOURCE, "c", 1000, 2000, "clip-c")] },
    ],
  };
}

const wheel = (patch: Partial<Parameters<typeof wheelAction>[0]>) =>
  wheelAction({
    deltaX: 0,
    deltaY: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...patch,
  });

describe("clampZoom", () => {
  it("keeps a zoom inside the limits and reads a bad value as the lowest", () => {
    expect(clampZoom(5, LIMITS)).toBe(10);
    expect(clampZoom(500, LIMITS)).toBe(400);
    expect(clampZoom(60, LIMITS)).toBe(60);
    expect(clampZoom(Number.NaN, LIMITS)).toBe(10);
  });
});

describe("timeline positions", () => {
  it("maps ms to content x and a view x back to ms, past the lane headers", () => {
    expect(contentXAtMs(2000, 50)).toBe(100);
    expect(contentXAtMs(2000, 50, 224)).toBe(324);
    expect(msAtViewX({ pxPerSecond: 50, scrollLeft: 100 }, 50)).toBe(3000);
    expect(msAtViewX({ pxPerSecond: 50, scrollLeft: 0 }, 324, 224)).toBe(2000);
    expect(msAtViewX({ pxPerSecond: 50, scrollLeft: 0 }, 100, 224)).toBe(0);
  });
});

describe("zoomAt", () => {
  it("keeps the anchor point where it is on screen", () => {
    const view = zoomAt(100, 4000, 200, LIMITS);
    expect(view).toEqual({ pxPerSecond: 100, scrollLeft: 200 });
    expect(contentXAtMs(4000, view.pxPerSecond) - view.scrollLeft).toBe(200);
  });

  it("never scrolls before the start and clamps the zoom", () => {
    expect(zoomAt(5, 1000, 500, LIMITS)).toEqual({
      pxPerSecond: 10,
      scrollLeft: 0,
    });
  });
});

describe("zoomAroundViewX", () => {
  it("keeps the point under the pointer fixed", () => {
    const before = { pxPerSecond: 60, scrollLeft: 300 };
    const pointerX = 150;
    const underPointer = msAtViewX(before, pointerX);
    const after = zoomAroundViewX(before, 2, pointerX, LIMITS);
    expect(after.pxPerSecond).toBe(120);
    expect(msAtViewX(after, pointerX)).toBeCloseTo(underPointer, 6);
  });

  it("keeps the point fixed with the studio's lane headers on the left", () => {
    const before = { pxPerSecond: 40, scrollLeft: 120 };
    const underPointer = msAtViewX(before, 500, 224);
    const after = zoomAroundViewX(before, 1.5, 500, LIMITS, 224);
    expect(msAtViewX(after, 500, 224)).toBeCloseTo(underPointer, 6);
  });

  it("reads a pointer over the lane headers as the timeline's left edge", () => {
    const before = { pxPerSecond: 40, scrollLeft: 400 };
    const atEdge = msAtViewX(before, 224, 224);
    const after = zoomAroundViewX(before, 2, 50, LIMITS, 224);
    expect(msAtViewX(after, 224, 224)).toBeCloseTo(atEdge, 6);
  });
});

describe("zoomAroundLine", () => {
  it("keeps the position line where it is when it is in view", () => {
    const before = { pxPerSecond: 60, scrollLeft: 0 };
    const after = zoomAroundLine(before, 1.5, 5000, 800, LIMITS);
    expect(after.pxPerSecond).toBe(90);
    expect(contentXAtMs(5000, 90) - after.scrollLeft).toBeCloseTo(300, 6);
  });

  it("brings the position line to the middle when it is out of view", () => {
    const before = { pxPerSecond: 60, scrollLeft: 0 };
    const after = zoomAroundLine(before, 2, 60_000, 800, LIMITS);
    expect(contentXAtMs(60_000, after.pxPerSecond) - after.scrollLeft).toBeCloseTo(400, 6);
  });

  it("centres it in the timeline, not under the lane headers", () => {
    const before = { pxPerSecond: 40, scrollLeft: 2000 };
    const after = zoomAroundLine(before, 1, 0, 1024, LIMITS, 224);
    // Out of view: the middle of 224…1024 is 624, but the start cannot scroll further right.
    expect(after.scrollLeft).toBe(0);
  });
});

describe("fitSpan", () => {
  it("fits the span across the visible width with a margin each side", () => {
    const view = fitSpan({ startMs: 0, endMs: 20_000 }, 832, LIMITS);
    expect(view.pxPerSecond).toBe((832 - 2 * FIT_MARGIN_PX) / 20);
    expect(view.scrollLeft).toBe(0);
  });

  it("starts a later span at the left margin, past the lane headers", () => {
    const view = fitSpan({ startMs: 10_000, endMs: 15_000 }, 1024, LIMITS, 224);
    expect(view.pxPerSecond).toBeCloseTo((1024 - 224 - 2 * FIT_MARGIN_PX) / 5, 9);
    // The span's start shows at the timeline's left edge plus the margin.
    expect(contentXAtMs(10_000, view.pxPerSecond, 224) - view.scrollLeft).toBeCloseTo(
      224 + FIT_MARGIN_PX,
      6,
    );
  });

  it("stays in the zoom range for a very long or a tiny span", () => {
    expect(fitSpan({ startMs: 0, endMs: 3_600_000 }, 800, LIMITS).pxPerSecond).toBe(10);
    expect(fitSpan({ startMs: 1000, endMs: 1000 }, 800, LIMITS).pxPerSecond).toBe(400);
  });

  it("does not break before the scroller is laid out", () => {
    const view = fitSpan({ startMs: 0, endMs: 10_000 }, 0, LIMITS);
    expect(view.pxPerSecond).toBe(10);
  });
});

describe("songSpan", () => {
  it("runs to the last clip or the score's end, whichever is later", () => {
    expect(songSpan(audio(), 8000)).toEqual({ startMs: 0, endMs: 15_000 });
    expect(songSpan(audio(), 30_000)).toEqual({ startMs: 0, endMs: 30_000 });
    expect(songSpan(EMPTY_AUDIO, 16_000)).toEqual({ startMs: 0, endMs: 16_000 });
  });
});

describe("selectionSpan", () => {
  it("covers the selected clips across lanes", () => {
    expect(selectionSpan(audio(), ["clip-a", "clip-c"], null)).toEqual({
      startMs: 1000,
      endMs: 6000,
    });
  });

  it("falls back to the time selection, and is empty without one", () => {
    const range = { startMs: 4000, endMs: 9000 };
    expect(selectionSpan(audio(), [], range)).toEqual(range);
    expect(selectionSpan(audio(), ["gone"], null)).toBeNull();
    expect(selectionSpan(audio(), [], { startMs: 4000, endMs: 4000 })).toBeNull();
  });

  it("prefers the selected clips over the time selection", () => {
    expect(selectionSpan(audio(), ["clip-b"], { startMs: 0, endMs: 1000 })).toEqual({
      startMs: 10_000,
      endMs: 15_000,
    });
  });
});

describe("wheelAction", () => {
  it("zooms with ⌘ or Ctrl: in when turned up, out when turned down", () => {
    const zoomIn = wheel({ deltaY: -100, metaKey: true });
    const zoomOut = wheel({ deltaY: 100, ctrlKey: true });
    expect(zoomIn.kind).toBe("zoom");
    expect(zoomIn.kind === "zoom" && zoomIn.factor).toBeGreaterThan(1);
    expect(zoomOut.kind === "zoom" && zoomOut.factor).toBeLessThan(1);
    // In and out by the same turn come back to the same zoom.
    if (zoomIn.kind === "zoom" && zoomOut.kind === "zoom")
      expect(zoomIn.factor * zoomOut.factor).toBeCloseTo(1, 9);
  });

  it("caps a fast flick", () => {
    const flick = wheel({ deltaY: -5000, metaKey: true });
    const notch = wheel({ deltaY: -120, metaKey: true });
    expect(flick).toEqual(notch);
  });

  it("scrolls sideways on a plain vertical turn, lines read as pixels", () => {
    expect(wheel({ deltaY: 40 })).toEqual({ kind: "scroll", dx: 40 });
    expect(wheel({ deltaY: -3, deltaMode: 1 })).toEqual({ kind: "scroll", dx: -48 });
  });

  it("leaves sideways swipes, Shift and Alt to the browser", () => {
    expect(wheel({ deltaX: 30, deltaY: 5 })).toEqual({ kind: "native" });
    expect(wheel({ deltaY: 40, shiftKey: true })).toEqual({ kind: "native" });
    expect(wheel({ deltaY: 40, altKey: true })).toEqual({ kind: "native" });
    expect(wheel({})).toEqual({ kind: "native" });
  });
});
