import { describe, expect, it } from "vitest";

import { createBarBounds, sameSpans, type BarSpan } from "@/lib/audio-lanes/bar-bounds";
import { EMPTY_AUDIO } from "@/lib/audio-lanes/model";
import type { SongGrid } from "@/lib/audio-lanes/sync";

/** Four 4/4 bars at 120 bpm (2 s each), drawn with a clef's worth of room before the first. */
const grid: SongGrid = {
  barTimes: [0, 2000, 4000, 6000],
  beats: [4, 4, 4, 4],
};
/** Bars of different widths: a crowded bar is narrow, a bar with a long rhythm is wide. */
const spans: BarSpan[] = [
  { x: 100, width: 200 },
  { x: 300, width: 100 },
  { x: 400, width: 300 },
  { x: 700, width: 150 },
];

const bounds = (audio = EMPTY_AUDIO, g = grid, s = spans) => createBarBounds(audio, g, s)!;

describe("bar bounds", () => {
  it("puts bar starts and middles where the notation draws them", () => {
    const b = bounds();
    expect(b.msToX(0)).toBe(100);
    expect(b.msToX(2000)).toBe(300);
    expect(b.msToX(3000)).toBe(350);
    expect(b.msToX(5000)).toBe(550);
    expect(b.msToX(8000)).toBe(850);
    expect(b.end).toBe(850);
  });

  it("is proportional inside a bar and not across bars of different widths", () => {
    const b = bounds();
    // The same second is 100 px in bar 0, 50 px in bar 1 and 150 px in bar 2.
    expect(b.msToX(1000) - b.msToX(0)).toBe(100);
    expect(b.msToX(3000) - b.msToX(2000)).toBe(50);
    expect(b.msToX(5000) - b.msToX(4000)).toBe(150);
  });

  it("round trips time through pixels and back", () => {
    const b = bounds();
    for (const ms of [0, 1, 999, 2000, 2500, 3999, 4000, 6500, 7999]) {
      expect(b.xToMs(b.msToX(ms))).toBeCloseTo(ms, 6);
    }
    for (const x of [100, 150, 299, 300, 399, 650, 699, 700, 849]) {
      expect(b.msToX(b.xToMs(x))).toBeCloseTo(x, 6);
    }
  });

  it("never goes backwards", () => {
    const b = bounds();
    let before = -Infinity;
    for (let ms = -1500; ms <= 12000; ms += 250) {
      const x = b.msToX(ms);
      expect(x).toBeGreaterThanOrEqual(before);
      before = x;
    }
    let msBefore = -Infinity;
    for (let x = -300; x <= 1500; x += 25) {
      const ms = b.xToMs(x);
      expect(ms).toBeGreaterThanOrEqual(msBefore);
      msBefore = ms;
    }
  });

  it("goes on at the first bar's width before the score and the last bar's width after it", () => {
    const b = bounds();
    // 1 s before the start is half of bar 0's 200 px.
    expect(b.msToX(-1000)).toBe(0);
    expect(b.xToMs(0)).toBeCloseTo(-1000);
    // One whole bar past the end is another 150 px.
    expect(b.msToX(10000)).toBe(1000);
    expect(b.xToMs(1000)).toBeCloseTo(10000);
  });

  it("maps a one-bar score", () => {
    const one = createBarBounds(EMPTY_AUDIO, { barTimes: [0], beats: [4] }, [
      { x: 40, width: 120 },
    ])!;
    expect(one.msToX(0)).toBe(40);
    expect(one.end).toBe(160);
    // With one bar the grid goes on at 2 s a bar.
    expect(one.msToX(1000)).toBe(100);
    expect(one.xToMs(100)).toBeCloseTo(1000);
    expect(one.msToX(-2000)).toBe(-80);
    expect(one.xToMs(280)).toBeCloseTo(4000);
  });

  it("follows the sync points and the padding (a non-linear audio timeline)", () => {
    // The audio plays bar 1 late and bar 2 quickly: bar starts are not at 2 s steps any more.
    const audio = {
      ...EMPTY_AUDIO,
      sync: [
        { bar: 0, ms: 500 },
        { bar: 1, ms: 3000 },
        { bar: 2, ms: 3500 },
      ],
    };
    const b = bounds(audio);
    expect(b.msToX(500)).toBe(100);
    expect(b.msToX(3000)).toBe(300);
    expect(b.msToX(3500)).toBe(400);
    expect(b.msToX(1750)).toBe(200);
    expect(b.msToX(3250)).toBe(350);
    expect(b.xToMs(200)).toBeCloseTo(1750);
    expect(b.xToMs(350)).toBeCloseTo(3250);
    // Audio before the first sync point (the padding) sits before the first bar.
    expect(b.msToX(0)).toBeLessThan(100);
    for (const ms of [0, 500, 1234, 3000, 3333, 3500, 6000]) {
      expect(b.xToMs(b.msToX(ms))).toBeCloseTo(ms, 6);
    }
  });

  it("takes a gap between two bars as part of the earlier one", () => {
    const gapped = createBarBounds(EMPTY_AUDIO, grid, [
      { x: 0, width: 100 },
      { x: 150, width: 100 },
      { x: 250, width: 100 },
      { x: 350, width: 100 },
    ])!;
    expect(gapped.xToBar(125)).toBeCloseTo(1);
    expect(gapped.xToMs(125)).toBeCloseTo(2000);
    expect(gapped.xToMs(200)).toBeCloseTo(3000);
  });

  it("copes with a bar drawn without width and with no bars at all", () => {
    const flat = createBarBounds(EMPTY_AUDIO, grid, [
      { x: 0, width: 0 },
      { x: 0, width: 100 },
    ])!;
    expect(Number.isFinite(flat.msToX(1000))).toBe(true);
    expect(Number.isFinite(flat.xToMs(50))).toBe(true);
    expect(createBarBounds(EMPTY_AUDIO, grid, [])).toBeNull();
  });
});

describe("same spans", () => {
  it("tells a redraw that changed nothing from one that did", () => {
    expect(
      sameSpans(
        spans,
        spans.map((s) => ({ ...s })),
      ),
    ).toBe(true);
    expect(sameSpans(spans, [...spans.slice(0, 3), { x: 700, width: 151 }])).toBe(false);
    expect(sameSpans(spans, spans.slice(1))).toBe(false);
    expect(sameSpans(null, null)).toBe(true);
    expect(sameSpans(null, spans)).toBe(false);
  });
});
