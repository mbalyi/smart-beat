import { describe, expect, it } from "vitest";

import { splitHands } from "@/lib/import/hand-split";

const n = (start: number, pitch: number) => ({ start, pitch });

describe("splitHands", () => {
  it("sends high notes right and low notes left", () => {
    const { right, left } = splitHands([n(0, 72), n(0, 40), n(1, 84), n(1, 48)]);
    expect(right.map((x) => x.pitch)).toEqual([72, 84]);
    expect(left.map((x) => x.pitch)).toEqual([40, 48]);
  });

  it("keeps a melody that dips below middle C in the right hand", () => {
    const melody = [n(0, 67), n(0.5, 64), n(1, 62), n(1.5, 59), n(2, 57), n(2.5, 60)];
    const bass = [n(0, 36), n(1, 43), n(2, 36)];
    const { right, left } = splitHands([...melody, ...bass]);
    expect(right).toEqual(melody);
    expect(left).toEqual(bass);
  });

  it("keeps a bass line that climbs above the split in the left hand", () => {
    const line = [n(0, 48), n(0.5, 52), n(1, 55), n(1.5, 58), n(2, 60), n(2.5, 62)];
    const { right, left } = splitHands([...line, n(0, 76), n(2, 79)]);
    expect(left).toEqual(line);
    expect(right.map((x) => x.pitch)).toEqual([76, 79]);
  });

  it("uses the pitch when no hand played recently", () => {
    expect(splitHands([n(0, 61)]).right).toHaveLength(1);
    expect(splitHands([n(0, 58)]).left).toHaveLength(1);
    expect(splitHands([n(0, 58), n(10, 61)])).toEqual({ right: [n(10, 61)], left: [n(0, 58)] });
  });

  it("keeps each hand's notes in the order they came in", () => {
    const input = [n(2, 70), n(0, 72), n(1, 71)];
    expect(splitHands(input).right).toEqual(input);
    expect(splitHands([])).toEqual({ right: [], left: [] });
  });
});
