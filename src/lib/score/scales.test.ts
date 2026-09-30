import {
  describeScale,
  SCALE_ROOTS,
  SCALE_TYPES,
  scaleDegree,
  scaleName,
  scalePitchClasses,
  scalePrefersFlats,
  scaleType,
} from "@/lib/score/scales";

describe("scales", () => {
  it("builds scales from their root", () => {
    expect(scalePitchClasses({ root: 0, type: "major" })).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(scalePitchClasses({ root: 9, type: "minor-pentatonic" })).toEqual([9, 0, 2, 4, 7]);
    expect(scalePitchClasses({ root: 4, type: "blues" })).toEqual([4, 7, 9, 10, 11, 2]);
  });

  it("marks the root and the other scale notes", () => {
    const scale = { root: 9, type: "minor-pentatonic" };
    expect(scaleDegree(scale, 57)).toBe("root"); // A3
    expect(scaleDegree(scale, 60)).toBe("in"); // C4
    expect(scaleDegree(scale, 61)).toBeNull(); // C#4
  });

  it("names and spells scales in their key", () => {
    expect(describeScale({ root: 9, type: "minor-pentatonic" })).toBe(
      "A minor pentatonic: A C D E G",
    );
    expect(describeScale({ root: 5, type: "major" })).toBe("F major: F G A Bb C D E");
    // D dorian comes from C major: no flats. G minor comes from B flat major.
    expect(scalePrefersFlats({ root: 2, type: "dorian" })).toBe(false);
    expect(describeScale({ root: 7, type: "minor" })).toBe("G natural minor: G A Bb C D Eb F");
    expect(scaleName({ root: 10, type: "mixolydian" }, { spoken: true })).toBe("B flat mixolydian");
    expect(describeScale({ root: 6, type: "major" }, { spoken: true })).toContain("F sharp major");
  });

  it("has every scale with notes inside one octave", () => {
    for (const type of SCALE_TYPES) {
      expect(type.intervals[0]).toBe(0);
      expect(type.intervals.every((i) => i >= 0 && i < 12)).toBe(true);
    }
    expect(scaleType("nope")).toBe(SCALE_TYPES[0]);
  });

  it("lists twelve roots with both spellings", () => {
    expect(SCALE_ROOTS).toHaveLength(12);
    expect(SCALE_ROOTS[1]!.label).toBe("C#/Db");
    expect(SCALE_ROOTS[0]!.label).toBe("C");
  });
});
