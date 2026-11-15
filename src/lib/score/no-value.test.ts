import { describe, expect, it } from "vitest";
import { model } from "@coderline/alphatab";
import { NO_VALUE, isNoValue } from "@/lib/score/no-value";

describe("no value", () => {
  it("is what alphaTab uses for a note with no string, fret, octave or tone", () => {
    const note = new model.Note();
    expect(Number.isNaN(note.string)).toBe(true);
    expect(Number.isNaN(note.fret)).toBe(true);
    expect(Number.isNaN(note.octave)).toBe(true);
    expect(Number.isNaN(note.tone)).toBe(true);
    expect(Number.isNaN(NO_VALUE)).toBe(true);
  });

  it("makes a pitched note a key, where -1 would still count as a string", () => {
    const key = new model.Note();
    key.string = NO_VALUE;
    key.fret = NO_VALUE;
    key.octave = 4;
    key.tone = 0;
    expect(key.isPiano).toBe(true);
    expect(key.isStringed).toBe(false);

    const stale = new model.Note();
    stale.string = -1;
    stale.fret = -1;
    stale.octave = 4;
    stale.tone = 0;
    expect(stale.isStringed).toBe(true);
  });

  it("reads both NaN and the -1 of older data as no value", () => {
    expect(isNoValue(NaN)).toBe(true);
    expect(isNoValue(-1)).toBe(true);
    expect(isNoValue(0)).toBe(false);
    expect(isNoValue(5)).toBe(false);
  });
});
