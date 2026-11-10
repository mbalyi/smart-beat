import { scrollToShow } from "@/lib/score/scroll-to-show";

/** A 600 × 400 view scrolled to (1000, 200). */
const VIEW = { left: 1000, top: 200, width: 600, height: 400 };

describe("scrollToShow (#228)", () => {
  it("stays where it is while the target is fully visible", () => {
    expect(scrollToShow({ x: 1200, y: 300, w: 20, h: 16 }, VIEW)).toBeNull();
  });

  it("stays where it is for a target touching the edges of the view", () => {
    expect(scrollToShow({ x: 1000, y: 200, w: 600, h: 400 }, VIEW)).toBeNull();
  });

  it("does not creep for a target a fraction of a pixel past an edge", () => {
    expect(scrollToShow({ x: 1580.5, y: 300, w: 20, h: 16 }, VIEW)).toBeNull();
    expect(scrollToShow({ x: 999.4, y: 300, w: 20, h: 16 }, VIEW)).toBeNull();
  });

  it("scrolls left only as far as needed, not to a bar start or the left edge", () => {
    expect(scrollToShow({ x: 950, y: 300, w: 20, h: 16 }, VIEW)).toEqual({ left: 950, top: 200 });
  });

  it("scrolls right only as far as needed", () => {
    expect(scrollToShow({ x: 1590, y: 300, w: 20, h: 16 }, VIEW)).toEqual({ left: 1010, top: 200 });
  });

  it("scrolls up and down only as far as needed", () => {
    expect(scrollToShow({ x: 1200, y: 150, w: 20, h: 16 }, VIEW)).toEqual({ left: 1000, top: 150 });
    expect(scrollToShow({ x: 1200, y: 590, w: 20, h: 16 }, VIEW)).toEqual({ left: 1000, top: 206 });
  });

  it("moves on both axes when the target is outside on both", () => {
    expect(scrollToShow({ x: 100, y: 900, w: 20, h: 16 }, VIEW)).toEqual({ left: 100, top: 516 });
  });

  it("leaves a target larger than the view alone while it fills the view", () => {
    expect(scrollToShow({ x: 900, y: 250, w: 900, h: 16 }, VIEW)).toBeNull();
  });

  it("brings the nearer edge of a target larger than the view in", () => {
    expect(scrollToShow({ x: 1300, y: 250, w: 900, h: 16 }, VIEW)).toEqual({
      left: 1300,
      top: 200,
    });
    expect(scrollToShow({ x: 0, y: 250, w: 900, h: 16 }, VIEW)).toEqual({ left: 300, top: 200 });
  });

  it("never scrolls before the start", () => {
    expect(scrollToShow({ x: -4, y: -2, w: 20, h: 16 }, VIEW)).toEqual({ left: 0, top: 0 });
  });
});
