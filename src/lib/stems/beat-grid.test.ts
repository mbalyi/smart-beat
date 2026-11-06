import { beatsBetween, bpmAt, sectionGrid, steadyGrid, type BeatGrid } from "@/lib/stems/beat-grid";

const times = (grid: BeatGrid, from: number, to: number) =>
  beatsBetween(grid, from, to).map((beat) => +beat.time.toFixed(6));

describe("a steady grid", () => {
  it("puts a beat every 60 / bpm seconds from the first beat", () => {
    expect(times(steadyGrid(120, 1), 1, 3.1)).toEqual([1, 1.5, 2, 2.5, 3]);
    expect(times(steadyGrid(90, 0.2), 0, 2.1)).toEqual([0.2, 0.866667, 1.533333]);
  });

  it("goes back before the first beat so a seek there still clicks in time", () => {
    expect(times(steadyGrid(120, 1), 0, 1.2)).toEqual([0, 0.5, 1]);
  });

  it("includes the start of the range and leaves out its end", () => {
    expect(times(steadyGrid(60, 0), 2, 4)).toEqual([2, 3]);
  });

  it("gives every beat once when walked in pieces that meet", () => {
    const grid = steadyGrid(133.3, 0.37);
    const pieces: number[] = [];
    let at = 0;
    for (; at < 20; at += 0.0731) pieces.push(...times(grid, at, at + 0.0731));
    expect(pieces).toEqual(times(grid, 0, at));
    expect(new Set(pieces).size).toBe(pieces.length);
  });

  it("accents the first beat of each bar, counted from the first beat, also backwards", () => {
    const accents = beatsBetween(steadyGrid(120, 1), 0, 5).map((b) => [b.time, b.accent]);
    expect(accents).toEqual([
      [0, false],
      [0.5, false],
      [1, true],
      [1.5, false],
      [2, false],
      [2.5, false],
      [3, true],
      [3.5, false],
      [4, false],
      [4.5, false],
    ]);
  });

  it("has no beats in an empty range or without a tempo", () => {
    expect(beatsBetween(steadyGrid(120, 0), 3, 3)).toEqual([]);
    expect(beatsBetween(steadyGrid(0, 0), 0, 10)).toEqual([]);
  });
});

describe("a grid with tempo changes", () => {
  const grid = sectionGrid(
    [
      { startSec: 0, bpm: 120 },
      { startSec: 2, bpm: 60 },
      { startSec: 5, bpm: 240 },
    ],
    0,
  )!;

  it("uses each part's tempo from where it starts", () => {
    expect(times(grid, 0, 6)).toEqual([0, 0.5, 1, 1.5, 2, 3, 4, 5, 5.25, 5.5, 5.75]);
  });

  it("restarts the bar at the start of a part", () => {
    const accents = beatsBetween(grid, 1.9, 3.1)
      .filter((b) => b.accent)
      .map((b) => b.time);
    expect(accents).toEqual([2]);
  });

  it("tells the tempo in force", () => {
    expect([0, 1.9, 2, 4.9, 5, 100].map((t) => bpmAt(grid, t))).toEqual([
      120, 120, 60, 60, 240, 240,
    ]);
  });

  it("is null without usable parts", () => {
    expect(sectionGrid([], 0)).toBeNull();
    expect(sectionGrid([{ startSec: 0, bpm: 0 }], 0)).toBeNull();
  });
});
