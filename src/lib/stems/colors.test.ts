import { describe, expect, it } from "vitest";

import { STEM_COLOR_HEX, STEM_COLOR_ORDER, stemColor } from "@/lib/stems/colors";
import { STEM_KINDS } from "@/lib/tauri";

describe("stem colours", () => {
  it("gives every stem kind its own colour", () => {
    const hexes = STEM_KINDS.map((kind) => STEM_COLOR_HEX[kind]);
    expect(new Set(hexes).size).toBe(STEM_KINDS.length);
    for (const hex of hexes) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("follows the stem separation art for the main parts", () => {
    expect(STEM_COLOR_HEX.guitar).toBe("#a43bff");
    expect(STEM_COLOR_HEX.drums).toBe("#ff2fa0");
    expect(STEM_COLOR_HEX.bass).toBe("#19b6ff");
    expect(STEM_COLOR_HEX.vocals).toBe("#ffd21a");
  });

  it("orders every kind once for new lanes", () => {
    expect([...STEM_COLOR_ORDER].sort()).toEqual([...STEM_KINDS].sort());
  });

  it("points at the theme token of the stem", () => {
    expect(stemColor("bass")).toBe("var(--stem-bass)");
  });
});
