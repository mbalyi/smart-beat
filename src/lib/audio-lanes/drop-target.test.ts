import { describe, expect, it } from "vitest";

import {
  laneDropTarget,
  registerLaneResolver,
  sameDropTarget,
  type DropHit,
  type DropLaneElement,
} from "@/lib/audio-lanes/drop-target";

const lane = (
  dataset: DropLaneElement["dataset"],
  rect = { left: 100, top: 50, width: 800, height: 52 },
): DropLaneElement => ({ dataset, getBoundingClientRect: () => rect });

/** A point over `element`: `closest` finds the lane (or nothing for a part outside lanes). */
const over =
  (element: DropLaneElement | null): (() => DropHit) =>
  () => ({
    closest: () => element,
  });

/** Bars of 2 s. */
const msAtBar = (bar: number) => bar * 2000;

describe("laneDropTarget", () => {
  it("reads the track list's pixels as bars from the lane's left edge", () => {
    const target = laneDropTarget(
      { x: 160, y: 60 },
      msAtBar,
      over(lane({ laneId: "a", pxPerBar: "20" })),
    );
    // 60 px in is bar 3 at 20 px a bar.
    expect(target).toMatchObject({ laneId: "a", atMs: 6000 });
    expect(target?.rect).toEqual({ left: 100, top: 50, width: 800, height: 52 });
  });

  it("reads the lane editor's and the studio's pixels as plain time", () => {
    const target = laneDropTarget(
      { x: 400, y: 60 },
      msAtBar,
      over(lane({ laneId: "b", msPerPx: "10" })),
    );
    expect(target).toMatchObject({ laneId: "b", atMs: 3000 });
  });

  it("asks a lane that reads its own pixels (bars of different widths) before its attributes", () => {
    const own = lane({ laneId: "c", pxPerBar: "20" });
    registerLaneResolver(own, (x) => x * 7);
    const target = laneDropTarget({ x: 160, y: 60 }, msAtBar, over(own));
    expect(target).toMatchObject({ laneId: "c", atMs: 420 });
  });

  it("follows a lane scrolled off to the left", () => {
    const scrolled = lane(
      { laneId: "b", msPerPx: "10" },
      { left: -200, top: 0, width: 900, height: 80 },
    );
    expect(laneDropTarget({ x: 100, y: 10 }, msAtBar, over(scrolled))?.atMs).toBe(3000);
  });

  it("never goes before the start of the lane", () => {
    const target = laneDropTarget(
      { x: 90, y: 60 },
      msAtBar,
      over(lane({ laneId: "b", msPerPx: "10" })),
    );
    expect(target?.atMs).toBe(0);
  });

  it("lands at 0 when the lane says nothing about its scale", () => {
    expect(laneDropTarget({ x: 300, y: 60 }, msAtBar, over(lane({ laneId: "c" })))?.atMs).toBe(0);
  });

  it("finds no lane outside a lane, or on one without an id (a folder)", () => {
    expect(laneDropTarget({ x: 5, y: 5 }, msAtBar, over(null))).toBeNull();
    expect(laneDropTarget({ x: 5, y: 5 }, msAtBar, () => null)).toBeNull();
    expect(laneDropTarget({ x: 5, y: 5 }, msAtBar, over(lane({ pxPerBar: "20" })))).toBeNull();
  });

  it("asks the page for the element under the point", () => {
    const asked: Array<[number, number]> = [];
    laneDropTarget({ x: 7, y: 9 }, msAtBar, (x, y) => {
      asked.push([x, y]);
      return null;
    });
    expect(asked).toEqual([[7, 9]]);
  });
});

describe("sameDropTarget", () => {
  const element = lane({ laneId: "a", pxPerBar: "20" });
  const hit = (x: number) => laneDropTarget({ x, y: 60 }, msAtBar, over(element));

  it("ignores the pointer moving inside the same lane", () => {
    expect(sameDropTarget(hit(150), hit(300))).toBe(true);
  });

  it("tells another lane, or none, apart", () => {
    const other = laneDropTarget(
      { x: 150, y: 60 },
      msAtBar,
      over(lane({ laneId: "b", pxPerBar: "20" })),
    );
    expect(sameDropTarget(hit(150), other)).toBe(false);
    expect(sameDropTarget(hit(150), null)).toBe(false);
    expect(sameDropTarget(null, null)).toBe(true);
  });
});
