import { tempoMap, tickToMs } from "@/lib/audio/tempo-map";

describe("tickToMs", () => {
  it("counts 120 beats a minute from the start when no tempo is given", () => {
    const map = tempoMap(960, []);
    expect(tickToMs(map, 0)).toBe(0);
    expect(tickToMs(map, 960)).toBeCloseTo(500, 6);
    expect(tickToMs(map, 960 * 4)).toBeCloseTo(2000, 6);
  });

  it("follows tempo changes, and a change at tick 0 replaces the default", () => {
    const map = tempoMap(960, [
      [0, 60],
      [960 * 2, 120],
    ]);
    expect(tickToMs(map, 960)).toBeCloseTo(1000, 6);
    expect(tickToMs(map, 960 * 2)).toBeCloseTo(2000, 6);
    // After the change a beat is 500 ms.
    expect(tickToMs(map, 960 * 3)).toBeCloseTo(2500, 6);
  });

  it("takes changes in any order, and clamps a silly tempo like the engine does", () => {
    const map = tempoMap(480, [
      [480 * 4, 240],
      [0, 90],
    ]);
    expect(tickToMs(map, 480 * 4)).toBeCloseTo((60_000 / 90) * 4, 6);
    expect(tickToMs(map, 480 * 5)).toBeCloseTo((60_000 / 90) * 4 + 250, 6);
    expect(tickToMs(tempoMap(480, [[0, 0]]), 480)).toBeCloseTo(500, 6);
    expect(tickToMs(tempoMap(480, [[0, 1e9]]), 480)).toBeCloseTo(30, 6);
  });

  it("is zero before the start", () => {
    expect(tickToMs(tempoMap(960, []), -50)).toBe(0);
  });
});
