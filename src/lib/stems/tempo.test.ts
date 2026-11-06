import {
  addTap,
  cleanBpm,
  describeSections,
  double,
  effectiveTempo,
  forgetOverrides,
  formatBpm,
  halve,
  LOW_CONFIDENCE,
  otherTempos,
  readOverride,
  sectionAt,
  tapBpm,
  writeOverride,
} from "@/lib/stems/tempo";
import type { StemTempo } from "@/lib/tauri";

const TEMPO: StemTempo = {
  bpm: 92,
  confidence: 0.8,
  firstBeatSec: 1.5,
  alternatives: [46, 184],
  steady: true,
  sections: [],
};
const time = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

describe("halve and double", () => {
  it("round to a tenth and refuse tempos nobody plays", () => {
    expect(halve(93)).toBe(46.5);
    expect(double(46.5)).toBe(93);
    expect(halve(50)).toBeNull();
    expect(double(160)).toBeNull();
    expect(cleanBpm(Number.NaN)).toBeNull();
    expect(cleanBpm(92.04)).toBe(92);
  });

  it("writes whole tempos without a decimal point", () => {
    expect(formatBpm(92)).toBe("92");
    expect(formatBpm(92.46)).toBe("92.5");
  });
});

describe("other tempos", () => {
  it("leaves out the tempo in use, repeats and nonsense", () => {
    expect(otherTempos([46, 92, 184, 184, 5, 1000], 92)).toEqual([46, 184]);
    expect(otherTempos([92.02, 46], 92)).toEqual([46]);
  });
});

describe("the tempo in use", () => {
  it("is what was detected, with the first beat", () => {
    expect(effectiveTempo(TEMPO, undefined)).toMatchObject({
      bpm: 92,
      firstBeatSec: 1.5,
      detected: true,
      notFound: false,
    });
  });

  it("is not found when the detector is not sure, or has not answered", () => {
    expect(
      effectiveTempo({ ...TEMPO, confidence: LOW_CONFIDENCE - 0.01 }, undefined),
    ).toMatchObject({
      bpm: null,
      firstBeatSec: 0,
      notFound: true,
    });
    expect(effectiveTempo(null, undefined).notFound).toBe(true);
  });

  it("lets the user's tempo and first beat win, also when nothing was found", () => {
    expect(effectiveTempo(TEMPO, { bpm: 120, firstBeatSec: 0.25 })).toMatchObject({
      bpm: 120,
      firstBeatSec: 0.25,
      detected: false,
    });
    expect(effectiveTempo(null, { bpm: 100 })).toMatchObject({ bpm: 100, notFound: false });
  });

  it("follows the tempo changes only when asked and while the tempo is the detected one", () => {
    const changes: StemTempo = {
      ...TEMPO,
      sections: [
        { startSec: 0, endSec: 60, bpm: 92 },
        { startSec: 60, endSec: 120, bpm: 140 },
      ],
    };
    expect(effectiveTempo(changes, undefined).followSections).toBe(false);
    expect(effectiveTempo(changes, { followSections: true }).followSections).toBe(true);
    expect(effectiveTempo(changes, { followSections: true, bpm: 100 }).followSections).toBe(false);
    expect(effectiveTempo(TEMPO, { followSections: true }).followSections).toBe(false);
  });
});

describe("tap tempo", () => {
  const tapsAt = (...times: number[]) => times.reduce<number[]>((taps, at) => addTap(taps, at), []);

  it("needs two taps, then averages the gaps", () => {
    expect(tapBpm(tapsAt(1000))).toBeNull();
    expect(tapBpm(tapsAt(1000, 1500))).toBe(120);
    expect(tapBpm(tapsAt(0, 600, 1200, 1800))).toBe(100);
    expect(tapBpm(tapsAt(0, 500, 1010, 1500))).toBeCloseTo(120, 0);
  });

  it("starts again after a pause", () => {
    expect(tapsAt(0, 500, 10_000)).toEqual([10_000]);
  });

  it("keeps only the latest taps, so a drifting hand follows the song", () => {
    const slow = Array.from({ length: 20 }, (_, i) => i * 500);
    const fast = Array.from({ length: 8 }, (_, i) => 10_000 + i * 400);
    expect(tapBpm(tapsAt(...slow, ...fast))).toBe(150);
  });

  it("gives no tempo outside the range", () => {
    expect(tapBpm(tapsAt(0, 100))).toBeNull();
  });
});

describe("tempo changes", () => {
  const sections = [
    { startSec: 0, endSec: 108, bpm: 92 },
    { startSec: 108, endSec: 160, bpm: 140 },
    { startSec: 160, endSec: 215, bpm: 100.5 },
  ];

  it("reads as a sentence", () => {
    expect(describeSections(sections, time)).toBe(
      "92 BPM until 1:48, then 140 BPM until 2:40, then 100.5 BPM",
    );
    expect(describeSections(sections.slice(0, 2), time)).toBe("92 BPM until 1:48, then 140 BPM");
  });

  it("tells the part a moment is in, and the last one after the end", () => {
    expect(sectionAt(sections, 0)?.bpm).toBe(92);
    expect(sectionAt(sections, 108)?.bpm).toBe(140);
    expect(sectionAt(sections, 300)?.bpm).toBe(100.5);
  });
});

describe("what the user changed", () => {
  beforeEach(() => {
    forgetOverrides();
    localStorage.clear();
  });

  it("is kept in memory and in storage, per song", () => {
    writeOverride("a", { bpm: 120, firstBeatSec: 2 });
    expect(readOverride("a")).toEqual({ bpm: 120, firstBeatSec: 2 });
    expect(readOverride("b")).toEqual({});
    forgetOverrides();
    expect(readOverride("a")).toEqual({ bpm: 120, firstBeatSec: 2 });
  });

  it("drops what makes no sense when it is read back", () => {
    localStorage.setItem(
      "smart-beat:stem-tempo:x",
      JSON.stringify({ bpm: 5000, firstBeatSec: -3, followSections: "yes", extra: 1 }),
    );
    expect(readOverride("x")).toEqual({});
    localStorage.setItem("smart-beat:stem-tempo:y", "{broken");
    expect(readOverride("y")).toEqual({});
  });

  it("is removed from storage when it is empty", () => {
    writeOverride("a", { bpm: 100 });
    writeOverride("a", {});
    expect(localStorage.getItem("smart-beat:stem-tempo:a")).toBeNull();
  });
});
