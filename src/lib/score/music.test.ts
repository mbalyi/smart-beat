import { model } from "@coderline/alphatab";

import {
  barRests,
  describeStaffLine,
  DRUM_KIT,
  DRUM_NOTATION,
  drumSound,
  durationTicks,
  GM_FAMILIES,
  GM_INSTRUMENTS,
  instrumentName,
  noteValueLabel,
  pitchFromLetter,
  pitchName,
  resizeTuning,
  stepDuration,
  tuningName,
  tuningPresets,
} from "@/lib/score/music";

const { Duration } = model;

describe("pitch names", () => {
  it("names MIDI pitches in scientific notation", () => {
    expect(pitchName(60)).toBe("C4");
    expect(pitchName(40)).toBe("E2");
    expect(pitchName(61)).toBe("C#4");
    expect(pitchName(61, { octave: false })).toBe("C#");
    expect(pitchName(61, { spoken: true })).toBe("C sharp4");
  });

  it("finds a letter's pitch in the nearest octave", () => {
    expect(pitchFromLetter("C", 62)).toBe(60);
    expect(pitchFromLetter("b", 62)).toBe(59);
    expect(pitchFromLetter("A", 45)).toBe(45);
    expect(pitchFromLetter("H", 60)).toBeNull();
  });
});

describe("note values", () => {
  it("steps between note values", () => {
    expect(stepDuration(Duration.Quarter, 1)).toBe(Duration.Eighth);
    expect(stepDuration(Duration.Quarter, -1)).toBe(Duration.Half);
    expect(stepDuration(Duration.Whole, -1)).toBe(Duration.Whole);
    expect(stepDuration(Duration.SixtyFourth, 1)).toBe(Duration.SixtyFourth);
    expect(noteValueLabel(Duration.Sixteenth)).toBe("16th");
    expect(noteValueLabel(Duration.OneHundredTwentyEighth)).toBe("1/128");
  });

  it("computes lengths with dots and tuplets", () => {
    expect(durationTicks(Duration.Quarter)).toBe(960);
    expect(durationTicks(Duration.Quarter, 1)).toBe(1440);
    expect(durationTicks(Duration.Quarter, 2)).toBe(1680);
    expect(durationTicks(Duration.Eighth, 0, { numerator: 3, denominator: 2 })).toBe(320);
  });

  it("fills bars with rests", () => {
    expect(barRests(4, 4)).toEqual([{ duration: Duration.Whole, dots: 0 }]);
    expect(barRests(3, 4)).toEqual([{ duration: Duration.Half, dots: 1 }]);
    expect(barRests(6, 8)).toEqual([{ duration: Duration.Half, dots: 1 }]);
    expect(barRests(2, 2)).toEqual([{ duration: Duration.Whole, dots: 0 }]);
    expect(barRests(5, 4)).toHaveLength(5);
    expect(barRests(7, 8)).toEqual(Array(7).fill({ duration: Duration.Eighth, dots: 0 }));
  });
});

describe("instruments", () => {
  it("lists all 128 General MIDI programs in 16 families", () => {
    expect(GM_INSTRUMENTS).toHaveLength(128);
    expect(GM_FAMILIES).toHaveLength(16);
    expect(instrumentName(25)).toBe("Acoustic Guitar (steel)");
    expect(instrumentName(200)).toBe("Program 201");
  });

  it("knows tunings for 3 to 8 strings", () => {
    for (const strings of [3, 4, 5, 6, 7, 8]) {
      const presets = tuningPresets(strings);
      expect(presets.length).toBeGreaterThan(0);
      expect(presets.every((p) => p.tuning.length === strings)).toBe(true);
    }
    expect(tuningName([64, 59, 55, 50, 45, 38])).toBe("Guitar Dropped D Tuning");
    expect(tuningName([64, 59, 55, 50, 45, 39])).toBeNull();
  });

  it("adds strings a fourth lower", () => {
    expect(resizeTuning([64, 59, 55, 50, 45, 40], 7)).toEqual([64, 59, 55, 50, 45, 40, 35]);
    expect(resizeTuning([64, 59, 55, 50, 45, 40], 4)).toEqual([64, 59, 55, 50]);
    expect(resizeTuning([], 4)).toEqual([43, 38, 33, 28]);
  });
});

describe("drum kit", () => {
  it("describes where every drum is written", () => {
    for (const drum of DRUM_KIT) expect(DRUM_NOTATION[drum.id]).toBeDefined();
    expect(drumSound(38)?.name).toBe("Snare");
    expect(drumSound(0)).toBeUndefined();
  });

  it("names staff positions", () => {
    expect(describeStaffLine(0)).toBe("1st line from the top");
    expect(describeStaffLine(3)).toBe("Space below the 2nd line");
    expect(describeStaffLine(8)).toBe("5th line from the top");
    expect(describeStaffLine(-1)).toBe("Space above the staff");
    expect(describeStaffLine(-2)).toBe("1st ledger line above");
    expect(describeStaffLine(-3)).toBe("Space above 1st ledger line");
    expect(describeStaffLine(9)).toBe("Space below the staff");
    expect(describeStaffLine(10)).toBe("1st ledger line below");
    expect(describeStaffLine(11)).toBe("Space below 1st ledger line");
  });
});
