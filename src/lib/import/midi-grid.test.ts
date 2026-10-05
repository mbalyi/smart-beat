import { describe, expect, it } from "vitest";

import { findGrid, type Onset } from "@/lib/import/midi-grid";

const STEP = 240; // a sixteenth at 960 ticks per quarter

/** Kick on 1 and 3, snare on 2 and 4, hi-hat eighths: `bars` bars of sixteenths of `size` ticks. */
function groove(size: number, bars: number, lead = 0, drift = 0): Onset[] {
  const onsets: Onset[] = [];
  for (let k = 0; k < bars * 16; k++) {
    const tick = Math.round((lead + k) * size + drift * Math.sin(k / 40));
    if (k % 8 === 0) onsets.push({ tick, pitch: 36, drum: true });
    if (k % 8 === 4) onsets.push({ tick, pitch: 38, drum: true });
    if (k % 2 === 0) onsets.push({ tick, pitch: 42, drum: true });
  }
  return onsets;
}

describe("findGrid", () => {
  it("leaves onsets that follow the file's own grid alone", () => {
    expect(findGrid(groove(STEP, 16), STEP, 16, 4)).toBeNull();
  });

  it("needs enough onsets to measure a grid", () => {
    expect(findGrid(groove(236, 1).slice(0, 10), STEP, 16, 4)).toBeNull();
  });

  it("measures a faster tempo and puts every onset on a sixteenth", () => {
    const onsets = groove(236, 40);
    const grid = findGrid(onsets, STEP, 16, 4)!;
    expect(grid).not.toBeNull();
    expect(grid.speed).toBeCloseTo(240 / 236, 3);
    for (const onset of onsets) {
      const at = grid.map(onset.tick) / STEP;
      expect(Math.abs(at - Math.round(at))).toBeLessThan(0.1);
    }
  });

  it("follows slow drift and lines the kick up with the bar lines", () => {
    // 21 sixteenths of silence, then a groove that drifts by up to ±60 ticks.
    const onsets = groove(244, 60, 21, 60);
    const grid = findGrid(onsets, STEP, 16, 4)!;
    for (const onset of onsets) {
      const step = Math.round(grid.map(onset.tick) / STEP);
      if (onset.pitch === 36) expect(step % 8).toBe(0);
      if (onset.pitch === 38) expect(step % 8).toBe(4);
    }
    const kicks = onsets
      .filter((o) => o.pitch === 36)
      .map((o) => Math.round(grid.map(o.tick) / STEP));
    expect(kicks[0]! % 16).toBe(0);
    // About as much silence as in the file: a whole number of bars.
    expect(kicks[0]).toBe(16);
  });
});
