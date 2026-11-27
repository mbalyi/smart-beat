import { describe, expect, it } from "vitest";
import {
  PIANO_ROWS,
  dragNotes,
  drumRows,
  hitNote,
  isBlackKey,
  joinNotes,
  msAt,
  noteBox,
  notesAt,
  notesInRect,
  pitchAt,
  rowName,
  splitNotesAt,
  xOf,
  type View,
} from "@/lib/midi-editor/geometry";
import type { MidiNote } from "@/lib/tauri";

const note = (id: string, startMs: number, lenMs: number, pitch: number): MidiNote => ({
  id,
  startMs,
  lenMs,
  pitch,
  vel: 100,
  chan: 0,
});
// 0.1 px per ms (100 px a second), 10 px rows, the clip at 1 s.
const view: View = { originMs: 1000, pxPerMs: 0.1, rowHeight: 10, rows: PIANO_ROWS };

describe("MIDI editor geometry", () => {
  it("maps time and pitch to the screen and back", () => {
    expect(xOf(view, 1500)).toBe(50);
    expect(msAt(view, 50)).toBe(1500);
    expect(pitchAt(view, 5)).toBe(127);
    expect(pitchAt(view, 1275)).toBe(0);
    expect(pitchAt(view, 1290)).toBeNull();
    expect(noteBox(view, 1000, note("a", 100, 200, 120))).toEqual({ x: 10, y: 70, w: 20, h: 10 });
    expect(isBlackKey(61)).toBe(true);
    expect(isBlackKey(60)).toBe(false);
  });

  it("finds the note and the part under the pointer", () => {
    const notes = [note("a", 0, 1000, 127)];
    expect(hitNote(view, 1000, notes, 50, 5)).toEqual({ id: "a", part: "body" });
    expect(hitNote(view, 1000, notes, 98, 5)).toEqual({ id: "a", part: "end" });
    expect(hitNote(view, 1000, notes, 50, 1)).toEqual({ id: "a", part: "top" });
    expect(hitNote(view, 1000, notes, 150, 5)).toBeNull();
  });

  it("selects the notes a marquee touches", () => {
    const notes = [note("a", 0, 100, 127), note("b", 1000, 100, 120), note("c", 0, 100, 100)];
    expect(notesInRect(view, 1000, notes, { x0: 0, y0: 0, x1: 120, y1: 80 })).toEqual(["a", "b"]);
  });

  it("moves by rows inside the clip, resizes and changes velocity", () => {
    const notes = [{ ...note("a", 100, 100, 60), rawStartMs: 90 }];
    const moved = dragNotes(
      notes,
      { kind: "move", ids: ["a"], deltaMs: -500, deltaRows: -2 },
      PIANO_ROWS,
      1000,
    );
    expect(moved[0]).toEqual(note("a", 0, 100, 62));
    const drums = [38, 36, 42];
    const onDrums = dragNotes(
      [note("a", 0, 10, 36)],
      { kind: "move", ids: ["a"], deltaMs: 0, deltaRows: 1 },
      drums,
      1000,
    );
    expect(onDrums[0]!.pitch).toBe(42);
    const longer = dragNotes(
      notes,
      { kind: "resize", ids: ["a"], deltaMs: 5000 },
      PIANO_ROWS,
      1000,
    );
    expect(longer[0]!.lenMs).toBe(900);
    const louder = dragNotes(notes, { kind: "velocity", ids: ["a"], delta: 100 }, PIANO_ROWS, 1000);
    expect(louder[0]!.vel).toBe(127);
  });

  it("orders drum rows by the kit and names them", () => {
    const rows = drumRows(new Set([36, 120]), false);
    expect(rows[0]).toBe(38);
    expect(rows).toContain(120);
    expect(drumRows(new Set([36]), true, { 40: "My clap" })).toEqual([40, 36]);
    expect(rowName(36, true)).toBe("Kick (hit)");
    expect(rowName(40, true, { 40: "My clap" })).toBe("My clap");
    expect(rowName(60, false)).toBe("C4");
  });

  it("splits and joins notes", () => {
    let id = 0;
    const split = splitNotesAt([note("a", 0, 100, 60)], 40, null, () => `n${++id}`);
    expect(split.map((n) => [n.startMs, n.lenMs])).toEqual([
      [0, 40],
      [40, 60],
    ]);
    expect(notesAt(split, 50).map((n) => n.id)).toEqual(["n1"]);
    const joined = joinNotes(split, new Set(split.map((n) => n.id)));
    expect(joined).toEqual([note("a", 0, 100, 60)]);
  });
});

describe("grid lines", () => {
  it("draws bars, beats and grid lines inside a range", async () => {
    const { gridLines } = await import("@/lib/midi-editor/grid-lines");
    const { EMPTY_AUDIO } = await import("@/lib/audio-lanes/model");
    const song = { barTimes: [0, 2000, 4000], beats: [4, 4, 4] };
    const lines = gridLines(
      EMPTY_AUDIO,
      song,
      { value: 1 / 8, type: "straight", swing: 0 },
      0,
      2000,
    );
    expect(lines.filter((l) => l.kind === "bar").map((l) => l.bar)).toEqual([1, 2]);
    expect(lines.filter((l) => l.kind === "beat")).toHaveLength(3);
    expect(lines.filter((l) => l.kind === "grid")).toHaveLength(4);
    expect(
      gridLines(
        EMPTY_AUDIO,
        { barTimes: [], beats: [] },
        { value: 1 / 8, type: "straight", swing: 0 },
        0,
        1,
      ),
    ).toEqual([]);
  });
});
