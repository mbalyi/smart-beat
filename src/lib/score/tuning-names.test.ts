import { shortTuningName, STANDARD_GUITAR, tuningLabel, tuningNotes } from "@/lib/score/music";

describe("shortTuningName (#83)", () => {
  it.each([
    ["six-string standard", STANDARD_GUITAR, "Standard"],
    ["D# standard", [63, 58, 54, 49, 44, 39], "D# Standard"],
    ["C# standard", [61, 56, 52, 47, 42, 37], "C# Standard"],
    ["drop D", [64, 59, 55, 50, 45, 38], "Drop D"],
    ["drop C#", [63, 58, 54, 49, 44, 37], "Drop C#"],
    ["seven-string standard", [64, 59, 55, 50, 45, 40, 35], "Standard"],
    ["seven-string drop A", [64, 59, 55, 50, 45, 40, 33], "Drop A"],
    ["bass standard", [43, 38, 33, 28], "Standard"],
    ["five-string bass", [43, 38, 33, 28, 23], "Standard"],
    ["bass a step down", [41, 36, 31, 26], "D Standard"],
    ["bass drop D", [43, 38, 33, 26], "Drop D"],
  ])("names %s", (_, tuning, name) => {
    expect(shortTuningName(tuning)).toBe(name);
  });

  it("names other known tunings without the instrument", () => {
    expect(shortTuningName([62, 59, 55, 50, 43, 38])).toBe("Open G");
  });

  it("calls anything else a custom tuning", () => {
    const odd = [64, 60, 55, 50, 45, 41];
    expect(shortTuningName(odd)).toBeNull();
    expect(tuningLabel(odd)).toBe("Custom tuning");
    expect(tuningLabel(STANDARD_GUITAR)).toBe("Standard");
  });
});

describe("tuningNotes (#119)", () => {
  // `tuning` is highest string first, like the tab lines; players say a tuning lowest first.
  it.each([
    ["six-string standard", STANDARD_GUITAR, "E A D G B E"],
    ["drop D", [64, 59, 55, 50, 45, 38], "D A D G B E"],
    ["open G", [62, 59, 55, 50, 43, 38], "D G D G B D"],
    ["four-string bass", [43, 38, 33, 28], "E A D G"],
    ["five-string bass", [43, 38, 33, 28, 23], "B E A D G"],
    ["seven-string", [64, 59, 55, 50, 45, 40, 35], "B E A D G B E"],
    ["eight-string", [64, 59, 55, 50, 45, 40, 35, 30], "F# B E A D G B E"],
    ["custom", [64, 60, 55, 50, 45, 41], "F A D G C E"],
  ])("lists %s from the lowest string", (_, tuning, notes) => {
    expect(tuningNotes(tuning)).toBe(notes);
  });

  it("leaves the tuning itself in tab order", () => {
    const tuning = [...STANDARD_GUITAR];
    tuningNotes(tuning);
    expect(tuning).toEqual(STANDARD_GUITAR);
  });
});
