import { model } from "@coderline/alphatab";

import {
  barRests,
  composeTuplet,
  describeStaffLine,
  DRUM_KIT,
  DRUM_NOTATION,
  drumSound,
  durationTicks,
  GM_FAMILIES,
  GM_INSTRUMENTS,
  getPreset,
  INSTRUMENT_PRESETS,
  instrumentName,
  isTuplet,
  lowestPitch,
  MAX_STRINGS,
  MIN_STRINGS,
  NO_TUPLET,
  transposeTuning,
  tupletKey,
  tupletLabel,
  TUPLETS,
  noteValueLabel,
  pitchFromLetter,
  pitchName,
  resizeTuning,
  stepDuration,
  STANDARD_GUITAR,
  tuningName,
  tuningNotes,
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

  it("knows tunings for 3 to 10 strings", () => {
    for (const strings of [3, 4, 5, 6, 7, 8, 9, 10]) {
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

describe("extended-range guitars and heavy tunings (#43)", () => {
  const note = (pitch: number) => pitchName(pitch, { octave: false });

  it("allows 3 to 10 strings", () => {
    expect([MIN_STRINGS, MAX_STRINGS]).toEqual([3, 10]);
    // Every guitar and bass the Add track dialog offers is inside that range.
    for (const preset of INSTRUMENT_PRESETS.filter((p) => p.kind === "stringed")) {
      expect(preset.tuning!.length).toBeGreaterThanOrEqual(MIN_STRINGS);
      expect(preset.tuning!.length).toBeLessThanOrEqual(MAX_STRINGS);
    }
    expect(getPreset("guitar-9")!.tuning).toEqual([64, 59, 55, 50, 45, 40, 35, 30, 25]);
    expect(getPreset("bass-5")!.tuning).toHaveLength(5);
    expect(getPreset("bass-6")!.tuning).toHaveLength(6);
  });

  it.each([6, 7, 8, 9, 10])("has sensible tunings for %i strings", (strings) => {
    const presets = tuningPresets(strings);
    const names = presets.map((p) => p.name);
    expect(new Set(names).size, "names are unique").toBe(names.length);
    const tunings = presets.map((p) => p.tuning.join());
    expect(new Set(tunings).size, "no tuning twice").toBe(tunings.length);
    for (const { name, tuning } of presets) {
      expect(tuning, name).toHaveLength(strings);
      expect(Math.min(...tuning), name).toBeGreaterThanOrEqual(0);
      expect(Math.max(...tuning), name).toBeLessThan(128);
    }
    // The heavy tunings are ordinary guitars: every string lower than the one above.
    for (const { name, tuning } of presets.filter((p) => /standard$|^Drop /.test(p.name))) {
      expect(
        tuning.every((p, i) => i === 0 || p < tuning[i - 1]!),
        name,
      ).toBe(true);
    }
  });

  it("starts every guitar with its standard tuning", () => {
    // Six to ten strings: E A D G B E, then a fourth lower for every extra string.
    expect(tuningPresets(6)[0]!.tuning).toEqual([64, 59, 55, 50, 45, 40]);
    expect(tuningPresets(7)[0]!.tuning).toEqual([64, 59, 55, 50, 45, 40, 35]);
    expect(tuningPresets(8)[0]).toEqual({
      name: "F# standard",
      tuning: [64, 59, 55, 50, 45, 40, 35, 30],
    });
    expect(tuningPresets(9)[0]!.name).toBe("C# standard");
    expect(tuningPresets(10)[0]!.name).toBe("G# standard");
  });

  it("offers drop D, C, B, A and A# on six strings", () => {
    const low = (name: string) => tuningPresets(6).find((p) => p.name === name)!.tuning;
    expect(low("Guitar Dropped D Tuning")).toEqual([64, 59, 55, 50, 45, 38]);
    expect(low("Guitar Dropped C Tuning")).toEqual([62, 57, 53, 48, 43, 36]);
    // Drop B: B F# B E G# C#.
    expect(low("Drop B").map((p) => note(p))).toEqual(["C#", "G#", "E", "B", "F#", "B"]);
    // Drop A#: A# F A# D# G C.
    expect(low("Drop A#").map((p) => note(p))).toEqual(["C", "G", "D#", "A#", "F", "A#"]);
    // Drop A: A E A D F# B.
    expect(low("Drop A").map((p) => note(p))).toEqual(["B", "F#", "D", "A", "E", "A"]);
    expect(tuningName(low("Drop C#"))).toBe("Drop C#");
  });

  it("offers F# standard and drop E on eight strings, B standard and drop A on seven", () => {
    const named = (strings: number, name: string) =>
      tuningPresets(strings).find((p) => p.name === name)!.tuning;
    expect(named(8, "F# standard").map((p) => note(p))).toEqual([
      "E",
      "B",
      "G",
      "D",
      "A",
      "E",
      "B",
      "F#",
    ]);
    expect(named(8, "Drop E").map((p) => note(p))).toEqual([
      "E",
      "B",
      "G",
      "D",
      "A",
      "E",
      "B",
      "E",
    ]);
    expect(named(7, "Drop A").map((p) => note(p))).toEqual(["E", "B", "G", "D", "A", "E", "A"]);
    expect(
      named(9, "Drop B")
        .map((p) => note(p))
        .at(-1),
    ).toBe("B");
    expect(
      named(10, "Drop F#")
        .map((p) => note(p))
        .at(-1),
    ).toBe("F#");
  });

  it("makes every drop tuning from its standard by lowering only the lowest string", () => {
    for (const strings of [7, 8, 9, 10]) {
      const presets = tuningPresets(strings);
      const standard = presets[0]!.tuning;
      const drop = presets.find((p) => p.name.startsWith("Drop"))!;
      expect(drop.tuning.slice(0, -1)).toEqual(standard.slice(0, -1));
      expect(drop.tuning.at(-1)).toBe(standard.at(-1)! - 2);
    }
  });

  it("finds the name of a tuning and tells a custom one", () => {
    expect(tuningName([64, 59, 55, 50, 45, 40, 35, 28])).toBe("Drop E");
    expect(tuningName([64, 59, 55, 50, 45, 40, 35, 29])).toBeNull();
    // Every preset can be found again by its pitches.
    for (const strings of [3, 4, 5, 6, 7, 8, 9, 10]) {
      for (const preset of tuningPresets(strings)) {
        expect(tuningPresets(strings).some((p) => p.name === tuningName(preset.tuning))).toBe(true);
      }
    }
  });

  it("moves a tuning down and finds its lowest pitch", () => {
    expect(transposeTuning([64, 59, 55, 50, 45, 40], -2)).toEqual([62, 57, 53, 48, 43, 38]);
    expect(transposeTuning([5, 3], -10)).toEqual([0, 0]);
    expect(transposeTuning([120], 20)).toEqual([127]);
    expect(lowestPitch([64, 59, 55, 50, 45, 40, 35, 30])).toBe(30);
    expect(lowestPitch([64, 40], 2)).toBe(42);
    expect(lowestPitch([])).toBe(0);
  });

  it("grows a tuning one string at a time, down to G#0 on ten strings", () => {
    let tuning = tuningPresets(6)[0]!.tuning;
    for (let strings = 7; strings <= 10; strings++) {
      tuning = resizeTuning(tuning, strings);
      expect(tuning).toHaveLength(strings);
    }
    expect(tuning).toEqual(tuningPresets(10)[0]!.tuning);
    expect(note(tuning.at(-1)!)).toBe("G#");
  });
});

describe("tuning notes (#119)", () => {
  it("names the open strings from the lowest up, for any string count", () => {
    expect(tuningNotes(STANDARD_GUITAR)).toBe("E A D G B E");
    expect(tuningNotes([64, 59, 55, 50, 45, 38])).toBe("D A D G B E");
    expect(tuningNotes([43, 38, 33, 28])).toBe("E A D G");
    expect(tuningNotes([43, 38, 33, 28, 23])).toBe("B E A D G");
    expect(tuningNotes([64, 59, 55, 50, 45, 40, 35])).toBe("B E A D G B E");
    expect(tuningNotes([64, 59, 55, 50, 45, 40, 35, 30])).toBe("F# B E A D G B E");
  });
});

describe("nested tuplets (#43)", () => {
  const triplet = { numerator: 3, denominator: 2 };
  const quintuplet = { numerator: 5, denominator: 4 };

  it("multiplies the ratios of a tuplet inside a tuplet", () => {
    expect(composeTuplet(triplet, triplet)).toEqual({ numerator: 9, denominator: 4 });
    expect(composeTuplet(triplet, quintuplet)).toEqual({ numerator: 15, denominator: 8 });
    expect(composeTuplet(quintuplet, triplet)).toEqual({ numerator: 15, denominator: 8 });
    expect(composeTuplet(NO_TUPLET, triplet)).toEqual(triplet);
  });

  it("plays a nested tuplet in the time its notes add up to", () => {
    // Three triplet eighths of three: nine notes in the time of four eighths,
    // so nine of them fill two quarters (1920 ticks).
    const nested = composeTuplet(triplet, triplet);
    expect(9 * durationTicks(Duration.Eighth, 0, nested)).toBeCloseTo(4 * 480, 6);
    // And a quintuplet inside a triplet: fifteen sixteenths take eight sixteenths.
    const mixed = composeTuplet(triplet, quintuplet);
    expect(15 * durationTicks(Duration.Sixteenth, 0, mixed)).toBeCloseTo(8 * 240, 6);
  });

  it("tells real tuplets from plain notes and nonsense", () => {
    expect(isTuplet(triplet)).toBe(true);
    expect(isTuplet(composeTuplet(triplet, triplet))).toBe(true);
    expect(isTuplet(NO_TUPLET)).toBe(false);
    expect(isTuplet({ numerator: 2, denominator: 3 })).toBe(false);
    expect(isTuplet({ numerator: 3, denominator: 0 })).toBe(false);
    expect(isTuplet({ numerator: 2.5, denominator: 2 })).toBe(false);
    expect(isTuplet({ numerator: 99, denominator: 8 })).toBe(false);
  });

  it("labels the ones the list names and shows the ratio of the others", () => {
    expect(tupletLabel(triplet)).toBe("Triplet (3:2)");
    expect(tupletLabel({ numerator: 9, denominator: 4 })).toBe("9:4");
    expect(TUPLETS.every((t) => tupletLabel(t) === t.label)).toBe(true);
    expect(tupletKey({ numerator: 15, denominator: 8 })).toBe("15:8");
  });
});
