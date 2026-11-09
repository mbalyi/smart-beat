import { describe, expect, it } from "vitest";

import { EMPTY_AUDIO } from "@/lib/audio-lanes/model";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { monoWav, placeTake } from "@/lib/audio-lanes/takes";

/** Eight bars of 4/4 at 120 bpm: 2 s a bar. */
const grid: SongGrid = {
  barTimes: Array.from({ length: 8 }, (_, i) => i * 2000),
  beats: Array(8).fill(4),
};
const base = { audio: EMPTY_AUDIO, grid, range: null, preRollBars: 0, speed: 1 };

describe("placeTake", () => {
  it("starts a plain take at its bar, from the heard downbeat", () => {
    expect(
      placeTake({ ...base, mode: "playhead", startBar: 2, downbeat: 1.5, takeMs: 9000 }),
    ).toEqual({
      startMs: 4000,
      passes: [1500],
      lengthMs: 7500,
    });
  });

  it("leaves the pre-roll out of the clip", () => {
    const placed = placeTake({
      ...base,
      mode: "playhead",
      startBar: 2,
      preRollBars: 1,
      downbeat: 1,
      takeMs: 9000,
    });
    expect(placed).toEqual({ startMs: 4000, passes: [3000], lengthMs: 6000 });
  });

  it("punches into the selected bars only", () => {
    const placed = placeTake({
      ...base,
      mode: "punch",
      startBar: 0,
      range: { start: 3, end: 4 },
      downbeat: 0.5,
      takeMs: 20_000,
    });
    expect(placed).toEqual({ startMs: 6000, passes: [500], lengthMs: 4000 });
  });

  it("cuts a loop recording into one take per pass", () => {
    const placed = placeTake({
      ...base,
      mode: "loop",
      startBar: 0,
      range: { start: 1, end: 1 },
      downbeat: 0,
      takeMs: 6500,
    });
    expect(placed).toEqual({ startMs: 2000, passes: [0, 2000, 4000], lengthMs: 2000 });
  });

  it("takes the practice speed into account", () => {
    const placed = placeTake({
      ...base,
      mode: "punch",
      startBar: 0,
      range: { start: 0, end: 0 },
      downbeat: 0,
      takeMs: 10_000,
      speed: 0.5,
    });
    expect(placed?.lengthMs).toBe(4000);
  });

  it("gives nothing for a take that stopped before the start", () => {
    expect(
      placeTake({ ...base, mode: "playhead", startBar: 0, downbeat: 3, takeMs: 2000 }),
    ).toBeNull();
  });
});

describe("monoWav", () => {
  it("writes a 16-bit mono WAV", () => {
    const wav = monoWav(new Float32Array([0, 1, -1]), 48000);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32767);
  });
});
