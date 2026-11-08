import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { SMUFL } from "@/lib/score/smufl";

/** The font alphaTab ships and the app serves as /font/Bravura.woff2 (same glyphs as the SVG). */
const FONT_SVG = resolve(process.cwd(), "node_modules/@coderline/alphatab/dist/font/Bravura.svg");

describe("SMUFL code points", () => {
  const svg = readFileSync(FONT_SVG, "utf8");

  it.each(Object.entries(SMUFL))("%s exists in the bundled Bravura font", (_name, codePoint) => {
    expect(svg).toContain(`unicode="&#x${codePoint.toString(16)};"`);
  });

  it("has no code point twice under different names", () => {
    const values = Object.values(SMUFL);
    expect(new Set(values).size).toBe(values.length);
  });
});
