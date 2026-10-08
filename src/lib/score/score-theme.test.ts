import { blend, contrast, SCORE_PALETTES } from "@/lib/score/score-theme";

describe("score palettes (#83)", () => {
  it.each(["light", "dark"] as const)("keep the %s score readable", (theme) => {
    const p = SCORE_PALETTES[theme];
    // Notes, tab numbers and text: well above the 4.5:1 for text.
    expect(contrast(p.main, p.paper)).toBeGreaterThanOrEqual(7);
    expect(contrast(p.scoreInfo, p.paper)).toBeGreaterThanOrEqual(7);
    expect(contrast(p.barNumber, p.paper)).toBeGreaterThanOrEqual(4.5);
    // Lines and lighter glyphs: at least the 3:1 for graphics.
    expect(contrast(p.barSeparator, p.paper)).toBeGreaterThanOrEqual(3);
    expect(contrast(blend(p.secondary, p.paper, p.secondaryAlpha), p.paper)).toBeGreaterThanOrEqual(
      3,
    );
  });

  it("draws the dark score's staff lines visibly, but quieter than the notes", () => {
    const p = SCORE_PALETTES.dark;
    expect(contrast(p.staffLine, p.paper)).toBeGreaterThanOrEqual(3);
    expect(contrast(p.staffLine, p.paper)).toBeLessThan(contrast(p.main, p.paper));
  });

  it("computes contrast and blends like WCAG", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(blend("#000000", "#ffffff", 255)).toBe("#000000");
    expect(blend("#000000", "#ffffff", 0)).toBe("#ffffff");
  });
});
