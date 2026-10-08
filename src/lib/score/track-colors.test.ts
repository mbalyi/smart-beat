import { TRACK_PALETTE, hexToOklch, isTrackColor, trackColor } from "@/lib/score/track-colors";

describe("trackColor", () => {
  it("cycles through the eight default colours by position", () => {
    expect(trackColor(0)).toBe("var(--track-1)");
    expect(trackColor(7)).toBe("var(--track-8)");
    expect(trackColor(8)).toBe("var(--track-1)");
    expect(trackColor(3, null)).toBe("var(--track-4)");
  });

  it("uses the chosen colour, held between the theme's lightest and darkest (#83)", () => {
    const blue = hexToOklch("#3e63dd");
    expect(trackColor(0, "#3e63dd")).toBe(
      `oklch(clamp(var(--track-l-min), ${blue.l.toFixed(3)}, var(--track-l-max)) ${blue.c.toFixed(3)} ${blue.h.toFixed(1)})`,
    );
    // Black and white keep their lightness here; the theme's range then holds them in view.
    expect(trackColor(0, "#000000")).toContain("clamp(var(--track-l-min), 0.000,");
    expect(trackColor(0, "#ffffff")).toContain("clamp(var(--track-l-min), 1.000,");
  });

  it("ignores a colour that is not #rrggbb", () => {
    expect(trackColor(1, "red")).toBe("var(--track-2)");
    expect(trackColor(1, "#12345")).toBe("var(--track-2)");
  });
});

describe("TRACK_PALETTE", () => {
  it("offers distinct #rrggbb colours with names", () => {
    expect(new Set(TRACK_PALETTE.map((c) => c.hex)).size).toBe(TRACK_PALETTE.length);
    expect(new Set(TRACK_PALETTE.map((c) => c.name)).size).toBe(TRACK_PALETTE.length);
    for (const { hex } of TRACK_PALETTE) expect(isTrackColor(hex)).toBe(true);
  });
});
