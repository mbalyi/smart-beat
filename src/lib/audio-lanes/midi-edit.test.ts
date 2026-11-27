import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUANTIZE,
  barLines,
  changeVelocity,
  fixOverlaps,
  freezeQuantize,
  gridAround,
  gridLabel,
  humanizeNotes,
  legatoNotes,
  noteName,
  parsePitch,
  quantizeNotes,
  SCALES,
  snapPitchToScale,
  snapToGrid,
  unquantizeNotes,
  type MidiGrid,
} from "@/lib/audio-lanes/midi-edit";
import { EMPTY_AUDIO } from "@/lib/audio-lanes/model";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import type { MidiNote } from "@/lib/tauri";

// 120 bpm 4/4: a bar is 2 s, a beat 500 ms, a 1/16 125 ms.
const song: SongGrid = { barTimes: [0, 2000, 4000, 6000], beats: [4, 4, 4, 4] };
const sixteenth: MidiGrid = { value: 1 / 16, type: "straight", swing: 0 };
const around = (ms: number) => gridAround(EMPTY_AUDIO, song, sixteenth, ms);
const note = (id: string, startMs: number, lenMs = 100, pitch = 60): MidiNote => ({
  id,
  startMs,
  lenMs,
  pitch,
  vel: 100,
  chan: 0,
});

describe("the MIDI editor grid", () => {
  it("lays out straight, triplet, dotted and swung lines in a bar", () => {
    expect(barLines(sixteenth, 4)).toHaveLength(17);
    expect(barLines({ value: 1 / 8, type: "triplet", swing: 0 }, 4)).toHaveLength(13);
    expect(barLines({ value: 1 / 4, type: "dotted", swing: 0 }, 4)).toEqual([0, 1.5, 3, 4]);
    expect(barLines({ value: 1 / 8, type: "swing", swing: 1 }, 2)).toEqual([0, 0.75, 1, 1.75, 2]);
    expect(barLines({ value: 1, type: "straight", swing: 0 }, 4)).toEqual([0, 4]);
  });

  it("finds the lines around a point and snaps to the nearest", () => {
    expect(around(130)).toEqual({ prev: 125, next: 250 });
    expect(snapToGrid(EMPTY_AUDIO, song, sixteenth, 190)).toBe(250);
    expect(snapToGrid(EMPTY_AUDIO, song, { value: 2, type: "straight", swing: 0 }, 2500)).toBe(
      4000,
    );
    expect(snapToGrid(EMPTY_AUDIO, song, { value: 2, type: "straight", swing: 0 }, 1500)).toBe(0);
  });

  it("labels grid values", () => {
    expect(gridLabel(1 / 16)).toBe("1/16");
    expect(gridLabel(1)).toBe("1 bar");
    expect(gridLabel(4)).toBe("4 bars");
  });
});

describe("quantize", () => {
  it("moves starts to the grid and keeps the played timing for un-quantize", () => {
    const played = [note("a", 30, 90), note("b", 240, 90)];
    const done = quantizeNotes(played, 0, around, DEFAULT_QUANTIZE);
    expect(done.map((n) => n.startMs)).toEqual([0, 250]);
    expect(done[0]).toMatchObject({ rawStartMs: 30, rawLenMs: 90, lenMs: 90 });
    expect(unquantizeNotes(done)).toEqual(played);
    // A second quantize starts from the performance, not from the first result.
    const half = quantizeNotes(done, 0, around, { ...DEFAULT_QUANTIZE, strength: 0.5 });
    expect(half.map((n) => n.startMs)).toEqual([15, 245]);
    expect(freezeQuantize(done)[0]).not.toHaveProperty("rawStartMs");
  });

  it("works in timeline time for a clip that starts mid-bar", () => {
    const done = quantizeNotes([note("a", 10)], 1000, around, DEFAULT_QUANTIZE);
    expect(done[0]!.startMs).toBe(0);
  });

  it("honours direction, range, selection and length options", () => {
    const n = [note("a", 30), note("b", 100)];
    expect(
      quantizeNotes(n, 0, around, { ...DEFAULT_QUANTIZE, moveLeft: false }).map((x) => x.startMs),
    ).toEqual([30, 125]);
    expect(
      quantizeNotes(n, 0, around, { ...DEFAULT_QUANTIZE, within: [0.5, 1] }).map((x) => x.startMs),
    ).toEqual([30, 100]);
    expect(
      quantizeNotes(n, 0, around, DEFAULT_QUANTIZE, new Set(["b"])).map((x) => x.startMs),
    ).toEqual([30, 125]);
    const ends = quantizeNotes([note("a", 0, 110)], 0, around, {
      ...DEFAULT_QUANTIZE,
      target: "end",
    });
    expect(ends[0]!.lenMs).toBe(125);
    const lengths = quantizeNotes([note("a", 0, 300)], 0, around, {
      ...DEFAULT_QUANTIZE,
      target: "length",
    });
    expect(lengths[0]!.lenMs).toBe(250);
  });

  it("fixes overlaps of one pitch", () => {
    const fixed = fixOverlaps([note("a", 0, 300), note("b", 200, 100), note("c", 250, 100, 61)]);
    expect(fixed.map((n) => n.lenMs)).toEqual([200, 100, 100]);
  });
});

describe("other note edits", () => {
  it("humanizes within the given ranges", () => {
    const out = humanizeNotes([note("a", 100)], { timingMs: 10, velocity: 10 }, () => 1);
    expect(out[0]).toMatchObject({ startMs: 110, vel: 110 });
    const low = humanizeNotes([note("a", 0)], { timingMs: 10, velocity: 200 }, () => 0);
    expect(low[0]).toMatchObject({ startMs: 0, vel: 1 });
  });

  it("makes notes legato and changes velocities", () => {
    expect(legatoNotes([note("a", 0, 10), note("b", 500, 10)]).map((n) => n.lenMs)).toEqual([
      500, 10,
    ]);
    expect(changeVelocity([note("a", 0)], null, 40, "add")[0]!.vel).toBe(127);
    expect(changeVelocity([note("a", 0)], null, 20, "set")[0]!.vel).toBe(20);
  });

  it("snaps to scales and reads note names", () => {
    expect(snapPitchToScale(61, 0, SCALES.major!)).toBe(60);
    expect(noteName(60)).toBe("C4");
    expect(noteName(61)).toBe("C#4");
    expect(parsePitch("C4", 0)).toBe(60);
    expect(parsePitch("bb3", 0)).toBe(58);
    expect(parsePitch("+1o2", 60)).toBe(74);
    expect(parsePitch("-3", 60)).toBe(57);
    expect(parsePitch("200", 0)).toBeNull();
    expect(parsePitch("hello", 0)).toBeNull();
  });
});
