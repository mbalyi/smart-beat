import { formatElapsed, levelWords, meterLevel, peakOf, smoothLevel } from "@/lib/audio/level";

describe("meterLevel", () => {
  it("is 1 at full scale and 0 at silence", () => {
    expect(meterLevel(1)).toBe(1);
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(NaN)).toBe(0);
  });

  it("is halfway at -30 dBFS", () => {
    expect(meterLevel(10 ** (-30 / 20))).toBeCloseTo(0.5, 6);
  });

  it("stays between 0 and 1", () => {
    expect(meterLevel(1e-9)).toBe(0);
    expect(meterLevel(4)).toBe(1);
  });
});

describe("peakOf", () => {
  it("is the loudest sample, whatever its sign", () => {
    expect(peakOf([0.1, -0.7, 0.3])).toBeCloseTo(0.7);
    expect(peakOf([])).toBe(0);
  });
});

describe("smoothLevel", () => {
  it("rises at once and falls slowly", () => {
    expect(smoothLevel(0.2, 0.8)).toBe(0.8);
    expect(smoothLevel(0.8, 0.1)).toBeCloseTo(0.68);
  });
});

describe("levelWords", () => {
  it("names the level", () => {
    expect(levelWords(0)).toBe("No sound");
    expect(levelWords(0.2)).toBe("Quiet");
    expect(levelWords(0.6)).toBe("Good");
    expect(levelWords(1)).toBe("Loud");
  });
});

describe("formatElapsed", () => {
  it("shows minutes and seconds", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(9.9)).toBe("0:09");
    expect(formatElapsed(75)).toBe("1:15");
    expect(formatElapsed(600)).toBe("10:00");
    expect(formatElapsed(-3)).toBe("0:00");
  });
});
