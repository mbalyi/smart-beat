import { describe, expect, it } from "vitest";

import { cleanDrumHits } from "@/lib/import/drum-hits";
import type { RecordedNote } from "@/lib/import/recording";

const hit = (start: number, pitch: number, velocity = 100): RecordedNote => ({
  start,
  end: start + 0.1,
  pitch,
  velocity,
});

describe("cleanDrumHits", () => {
  it("keeps the order in time and the hits of different drums at one moment", () => {
    const out = cleanDrumHits([hit(1, 38), hit(0.5, 36), hit(1, 42)]);
    expect(out.map((h) => [h.start, h.pitch])).toEqual([
      [0.5, 36],
      [1, 38],
      [1, 42],
    ]);
  });

  it("merges a drum found twice within 30 ms and keeps the louder one", () => {
    const out = cleanDrumHits([hit(1, 38, 60), hit(1.02, 38, 110), hit(1.2, 38, 90)]);
    expect(out.map((h) => [h.start, h.velocity])).toEqual([
      [1, 110],
      [1.2, 90],
    ]);
  });

  it("does not merge two hits 30 ms or more apart", () => {
    expect(cleanDrumHits([hit(1, 42), hit(1.03, 42)])).toHaveLength(2);
  });

  it("drops numbers that are not drums and times that are not numbers", () => {
    expect(cleanDrumHits([hit(1, 5), hit(Number.NaN, 38), hit(2, 38)])).toHaveLength(1);
  });

  it("returns nothing for nothing", () => {
    expect(cleanDrumHits([])).toEqual([]);
  });
});
