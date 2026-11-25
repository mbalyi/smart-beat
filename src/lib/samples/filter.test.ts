import { describe, expect, it } from "vitest";

import {
  countLabel,
  filterSamples,
  formatBytes,
  formatRate,
  formatSampleLength,
  sampleMeta,
} from "@/lib/samples/filter";
import type { SampleFile } from "@/lib/samples/types";
import { scrollToRow, visibleRange } from "@/lib/samples/windowing";

const file = (name: string, rel = `${name}.wav`): Pick<SampleFile, "name" | "rel"> => ({
  name,
  rel,
});

describe("filterSamples", () => {
  const files = [
    file("Kick_Punch_01", "Drums/Kick_Punch_01.wav"),
    file("Snare_Crack", "Drums/Snare_Crack.wav"),
    file("Pad_Warm_Am", "Pads/Pad_Warm_Am.wav"),
  ];
  const all = (q: string) => filterSamples(files, q, (f) => f).map((f) => f.name);

  it("returns everything for an empty or blank query", () => {
    expect(all("")).toHaveLength(3);
    expect(all("   ")).toHaveLength(3);
  });

  it("matches without caring about case", () => {
    expect(all("KICK")).toEqual(["Kick_Punch_01"]);
  });

  it("needs every word to match, in any order", () => {
    expect(all("punch kick")).toEqual(["Kick_Punch_01"]);
    expect(all("kick snare")).toEqual([]);
  });

  it("also looks at the folder part of the path", () => {
    expect(all("pads")).toEqual(["Pad_Warm_Am"]);
    expect(all("drums")).toHaveLength(2);
  });

  it("works on any item that can name its file", () => {
    const refs = files.map((f) => ({ folderId: "a", file: f }));
    expect(filterSamples(refs, "pad", (r) => r.file)).toHaveLength(1);
  });
});

describe("sample labels", () => {
  it("shows short lengths with decimals and long ones as minutes", () => {
    expect(formatSampleLength(null)).toBe("–");
    expect(formatSampleLength(420)).toBe("0.42 s");
    expect(formatSampleLength(7060)).toBe("7.1 s");
    expect(formatSampleLength(12_400)).toBe("12 s");
    expect(formatSampleLength(72_000)).toBe("1:12");
  });

  it("writes the rate in kHz", () => {
    expect(formatRate(44_100)).toBe("44.1 kHz");
    expect(formatRate(48_000)).toBe("48 kHz");
    expect(formatRate(null)).toBe("");
  });

  it("builds the grey line under a name, leaving out what is not measured yet", () => {
    const base: SampleFile = {
      rel: "a.flac",
      name: "a",
      ext: "flac",
      sizeBytes: 1,
      modifiedMs: 0,
      durationMs: 7060,
      sampleRate: 44_100,
      channels: 2,
      peaks: null,
    };
    expect(sampleMeta(base)).toBe("7.1 s · 44.1 kHz · FLAC");
    expect(sampleMeta({ ...base, durationMs: null, sampleRate: null })).toBe("– · FLAC");
  });

  it("formats sizes and counts", () => {
    expect(formatBytes(300)).toBe("1 KB");
    expect(formatBytes(412 * 1024 * 1024)).toBe("412 MB");
    expect(formatBytes(1.8 * 1024 ** 3)).toBe("1.8 GB");
    expect(countLabel(1)).toBe("1 sample");
    expect(countLabel(1204)).toBe("1,204 samples");
  });
});

describe("visibleRange", () => {
  it("draws the rows in view plus a few around them", () => {
    expect(visibleRange(0, 312, 52, 5000)).toEqual({ start: 0, end: 12 });
    expect(visibleRange(5200, 312, 52, 5000)).toEqual({ start: 94, end: 112 });
  });

  it("never goes past the list", () => {
    expect(visibleRange(1_000_000, 312, 52, 40)).toEqual({ start: 34, end: 40 });
    expect(visibleRange(0, 312, 52, 0)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(-50, 312, 52, 3)).toEqual({ start: 0, end: 3 });
  });
});

describe("scrollToRow", () => {
  it("does not scroll to a row that is in view", () => {
    expect(scrollToRow(2, 0, 312, 52)).toBeNull();
  });
  it("scrolls up to a row above and down to a row below", () => {
    expect(scrollToRow(1, 200, 312, 52)).toBe(52);
    expect(scrollToRow(10, 0, 312, 52)).toBe(10 * 52 + 52 - 312);
  });
});
