import { describe, expect, it } from "vitest";

import { clipEndMs, EMPTY_AUDIO, MAX_TAKES, newClip } from "@/lib/audio-lanes/model";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { monoWav, placeTake } from "@/lib/audio-lanes/takes";

/** Eight bars of 4/4 at 120 bpm: 2 s a bar. */
const grid: SongGrid = {
  barTimes: Array.from({ length: 8 }, (_, i) => i * 2000),
  beats: Array(8).fill(4),
};
/** What a take at the written speed adds: played as recorded, nothing left out. */
const unmapped = { playrate: 1, aligned: true, dropped: 0 };
const base = { audio: EMPTY_AUDIO, grid, range: null, preRollBars: 0, speed: 1 };

describe("placeTake", () => {
  it("starts a plain take at its bar, from the heard downbeat", () => {
    expect(
      placeTake({ ...base, mode: "playhead", startBar: 2, downbeat: 1.5, takeMs: 9000 }),
    ).toEqual({
      ...unmapped,
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
    expect(placed).toEqual({ ...unmapped, startMs: 4000, passes: [3000], lengthMs: 6000 });
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
    expect(placed).toEqual({ ...unmapped, startMs: 6000, passes: [500], lengthMs: 4000 });
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
    expect(placed).toEqual({
      ...unmapped,
      startMs: 2000,
      passes: [0, 2000, 4000],
      lengthMs: 2000,
    });
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

  it("fits a take recorded at half speed onto the bar it covers", () => {
    const placed = placeTake({
      ...base,
      mode: "punch",
      startBar: 0,
      range: { start: 0, end: 0 },
      downbeat: 0,
      takeMs: 10_000,
      speed: 0.5,
    })!;
    // The 2 s bar took 4 s to play: the clip plays that 4 s at twice the rate, so it fills 2 s.
    const clip = {
      ...newClip("s", "take", placed.startMs, placed.lengthMs),
      playrate: placed.playrate,
    };
    expect(placed.playrate).toBe(2);
    expect(placed.aligned).toBe(true);
    expect(clipEndMs(clip) - clip.startMs).toBe(2000);
  });

  it("plays a take at the written speed as recorded", () => {
    const placed = placeTake({
      ...base,
      mode: "punch",
      startBar: 0,
      range: { start: 0, end: 0 },
      downbeat: 0,
      takeMs: 10_000,
    })!;
    expect(placed.playrate).toBe(1);
    expect(placed.lengthMs).toBe(2000);
  });

  it("says when the speed is outside what the playrate can map", () => {
    const placed = placeTake({
      ...base,
      mode: "playhead",
      startBar: 0,
      downbeat: 0,
      takeMs: 10_000,
      speed: 0.1,
    })!;
    expect(placed.playrate).toBe(4);
    expect(placed.aligned).toBe(false);
  });

  it("keeps the last passes of a loop recording that fills more takes than a clip holds", () => {
    const longGrid: SongGrid = { barTimes: [0, 2000, 4000], beats: [4, 4, 4] };
    const placed = placeTake({
      ...base,
      grid: longGrid,
      mode: "loop",
      startBar: 0,
      range: { start: 0, end: 0 },
      downbeat: 0,
      takeMs: 130_000,
    })!;
    // 130 s of one-bar passes is 65 passes: the first one is left out.
    expect(placed.passes).toHaveLength(MAX_TAKES);
    expect(placed.passes[0]).toBe(2000);
    expect(placed.passes.at(-1)).toBe(128_000);
    expect(placed.dropped).toBe(1);
  });

  it("leaves nothing out of a loop recording within the limit", () => {
    const placed = placeTake({
      ...base,
      mode: "loop",
      startBar: 0,
      range: { start: 1, end: 1 },
      downbeat: 0,
      takeMs: 6500,
    })!;
    expect(placed.dropped).toBe(0);
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
