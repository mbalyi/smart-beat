import { waveformPath } from "@/lib/stems/waveform";

describe("waveformPath", () => {
  it("draws a closed shape that mirrors the peaks around the middle", () => {
    const path = waveformPath([0, 0.5, 1]);
    expect(path.startsWith("M0 50 ")).toBe(true);
    expect(path.endsWith(" Z")).toBe(true);
    // Top edge at 50 - 0.6 (silence keeps a hairline), 50 - 24, 50 - 48; the bottom mirrors it.
    expect(path).toContain("L0 49.4 L1 26.0 L2 2.0 L3 50 L2 98.0 L1 74.0 L0 50.6 Z");
  });

  it("is empty but valid without peaks, and clamps peaks above 1", () => {
    expect(waveformPath([])).toBe("M0 50  L0 50  Z");
    expect(waveformPath([9])).toContain("L0 2.0");
  });
});
