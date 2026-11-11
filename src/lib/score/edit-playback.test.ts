import type { Beat } from "@/lib/score/model";
import { editPlaySpan } from "@/lib/score/edit-playback";

const beat = (name: string) => ({ name }) as unknown as Beat;
const editorWith = (cursor: Beat | null, selected: Beat[] = []) => ({
  cursorBeat: () => cursor,
  selectedBeatList: () => selected,
});

describe("editPlaySpan (#228)", () => {
  const a = beat("a");
  const b = beat("b");
  const c = beat("c");

  it("starts at the cursor beat and plays on", () => {
    expect(editPlaySpan(editorWith(b))).toEqual({ start: b, end: null });
  });

  it("plays only the selected beats, first to last", () => {
    expect(editPlaySpan(editorWith(c, [a, b, c]))).toEqual({ start: a, end: c });
  });

  it("plays on from a selection of one beat", () => {
    expect(editPlaySpan(editorWith(a, [a]))).toEqual({ start: a, end: null });
  });

  it("has nothing to play without a beat", () => {
    expect(editPlaySpan(editorWith(null))).toBeNull();
  });
});
