import { describe, expect, it } from "vitest";

import { SMUFL } from "@/lib/score/smufl";
import { inkCentring, SMUFL_INK } from "@/lib/score/smufl-ink";

describe("SMUFL_INK", () => {
  it("has the ink size of every glyph of the palette", () => {
    expect(Object.keys(SMUFL_INK).sort()).toEqual(Object.keys(SMUFL).sort());
  });

  it("holds sizes in em that fit a glyph (nothing is taller than two em)", () => {
    for (const [name, [above, below]] of Object.entries(SMUFL_INK)) {
      expect(above + below, name).toBeGreaterThan(0);
      expect(above + below, name).toBeLessThan(2);
    }
  });
});

describe("inkCentring", () => {
  it("leaves a glyph that is as high as it is deep on the middle", () => {
    expect(Math.abs(inkCentring(["noteheadBlack"]))).toBeLessThan(0.05);
  });

  it("moves a tall note down so that its middle, not its head, is centred", () => {
    expect(inkCentring(["note64thUp"])).toBeGreaterThan(inkCentring(["noteQuarterUp"]));
    expect(inkCentring(["noteQuarterUp"])).toBeGreaterThan(0.3);
  });

  it("moves a mark drawn above the baseline (an accent) a little down", () => {
    expect(inkCentring(["articAccentAbove"])).toBeGreaterThan(0);
    expect(inkCentring(["articAccentAbove"])).toBeLessThan(inkCentring(["noteQuarterUp"]));
  });

  it("uses the tallest and deepest glyph of a run", () => {
    const both = inkCentring([
      "noteheadParenthesisLeft",
      "noteheadBlack",
      "noteheadParenthesisRight",
    ]);
    expect(both).toBeCloseTo(inkCentring(["noteheadParenthesisLeft"]), 3);
  });
});
