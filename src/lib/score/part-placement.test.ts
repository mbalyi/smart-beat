import { describe, expect, it } from "vitest";

import {
  acceptsPart,
  autoScrollDelta,
  drawnBars,
  drawnTracks,
  firstSpot,
  moveSpot,
  nearestPlacement,
  placementBoxes,
  type PlacementRect,
} from "@/lib/score/part-placement";

/** Two tracks stacked in one system (0 above 1), four bars of 100 px each, then a second system. */
const bar = (track: number, index: number, system: number): PlacementRect => ({
  track,
  bar: index,
  rect: {
    x: (index % 4) * 110,
    y: system * 300 + track * 100,
    w: 100,
    h: 60,
  },
});
const rects: PlacementRect[] = [
  ...[0, 1, 2, 3].flatMap((i) => [bar(0, i, 0), bar(1, i, 0)]),
  ...[4, 5, 6, 7].flatMap((i) => [bar(0, i, 1), bar(1, i, 1)]),
];

describe("acceptsPart", () => {
  it("puts melodic parts on strings and keys, drums on drums only", () => {
    expect(acceptsPart("guitar", "stringed")).toBe(true);
    expect(acceptsPart("bass", "pitched")).toBe(true);
    expect(acceptsPart("piano", "stringed")).toBe(true);
    expect(acceptsPart("piano", "drums")).toBe(false);
    expect(acceptsPart("drums", "drums")).toBe(true);
    expect(acceptsPart("drums", "stringed")).toBe(false);
    expect(acceptsPart("guitar", "audio")).toBe(false);
  });
});

describe("nearestPlacement", () => {
  it("finds the bar and the track under the point", () => {
    expect(nearestPlacement(rects, 120, 20)).toEqual({ track: 0, bar: 1 });
    expect(nearestPlacement(rects, 250, 120)).toEqual({ track: 1, bar: 2 });
  });

  it("picks the nearest staff between two staves", () => {
    // Track 0 ends at y 60, track 1 starts at y 100: 75 is nearer to the first, 90 to the second.
    expect(nearestPlacement(rects, 50, 75)?.track).toBe(0);
    expect(nearestPlacement(rects, 50, 90)?.track).toBe(1);
  });

  it("picks the nearer bar in the gap between two bars", () => {
    expect(nearestPlacement(rects, 103, 20)?.bar).toBe(0);
    expect(nearestPlacement(rects, 107, 20)?.bar).toBe(1);
  });

  it("finds a bar of the second system", () => {
    expect(nearestPlacement(rects, 330, 320)).toEqual({ track: 0, bar: 7 });
  });

  it("is null far from every bar or with no drawn bars", () => {
    expect(nearestPlacement(rects, 2000, 2000)).toBeNull();
    expect(nearestPlacement(null, 10, 10)).toBeNull();
    expect(nearestPlacement([], 10, 10)).toBeNull();
  });
});

describe("boxes and lists", () => {
  it("lists the boxes a part covers on one track", () => {
    expect(placementBoxes(rects, 1, 2, 4)).toHaveLength(3);
    expect(drawnTracks(rects)).toEqual([0, 1]);
    expect(drawnBars(rects, 0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("autoScrollDelta", () => {
  it("is nothing in the middle and ramps up to the edge", () => {
    expect(autoScrollDelta(300, 0, 600)).toBe(0);
    const near = autoScrollDelta(560, 0, 600);
    const edge = autoScrollDelta(600, 0, 600);
    expect(near).toBeGreaterThan(0);
    expect(edge).toBeGreaterThan(near);
    expect(autoScrollDelta(10, 0, 600)).toBeLessThan(0);
    expect(autoScrollDelta(-50, 0, 600)).toBe(-28);
  });
});

describe("keyboard", () => {
  const accepts = () => true;
  it("moves a bar, four bars, to the ends and between tracks", () => {
    const from = { track: 0, bar: 2 };
    expect(moveSpot(from, "ArrowRight", rects, accepts)).toEqual({ track: 0, bar: 3 });
    expect(moveSpot(from, "ArrowLeft", rects, accepts)).toEqual({ track: 0, bar: 1 });
    expect(moveSpot(from, "PageDown", rects, accepts)).toEqual({ track: 0, bar: 6 });
    expect(moveSpot(from, "PageUp", rects, accepts)).toEqual({ track: 0, bar: 0 });
    expect(moveSpot(from, "Home", rects, accepts)).toEqual({ track: 0, bar: 0 });
    expect(moveSpot(from, "End", rects, accepts)).toEqual({ track: 0, bar: 7 });
    expect(moveSpot(from, "ArrowDown", rects, accepts)).toEqual({ track: 1, bar: 2 });
    expect(moveSpot({ track: 1, bar: 2 }, "ArrowDown", rects, accepts)).toEqual({
      track: 1,
      bar: 2,
    });
  });

  it("skips tracks that do not take the part and clamps at the ends", () => {
    expect(moveSpot({ track: 0, bar: 0 }, "ArrowDown", rects, (t) => t === 0)).toEqual({
      track: 0,
      bar: 0,
    });
    expect(moveSpot({ track: 0, bar: 0 }, "ArrowLeft", rects, accepts)).toEqual({
      track: 0,
      bar: 0,
    });
  });

  it("picks up on the wanted spot, or the nearest drawn one", () => {
    expect(firstSpot(rects, accepts, { track: 1, bar: 3 })).toEqual({ track: 1, bar: 3 });
    expect(firstSpot(rects, accepts, { track: 9, bar: 99 })).toEqual({ track: 0, bar: 7 });
    expect(firstSpot(rects, () => false, { track: 0, bar: 0 })).toBeNull();
  });
});
