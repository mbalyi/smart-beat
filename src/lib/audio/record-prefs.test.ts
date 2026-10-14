import {
  readAlignToBeat,
  readInstrument,
  readPianoEngine,
  readPlayOthers,
  readTuningChoice,
  standardTuningChoice,
  storeAlignToBeat,
  storeInstrument,
  storePianoEngine,
  storePlayOthers,
  storeTuningChoice,
  tuningOf,
} from "@/lib/audio/record-prefs";
import { tuningPresets } from "@/lib/score/music";

describe("record preferences", () => {
  it("plays the other tracks unless the player said no", () => {
    expect(readPlayOthers()).toBe(true);
    storePlayOthers(false);
    expect(readPlayOthers()).toBe(false);
    storePlayOthers(true);
    expect(readPlayOthers()).toBe(true);
  });

  it("lines a take up with the beat unless the player said no", () => {
    expect(readAlignToBeat()).toBe(true);
    storeAlignToBeat(false);
    expect(readAlignToBeat()).toBe(false);
    storeAlignToBeat(true);
    expect(readAlignToBeat()).toBe(true);
  });

  it("starts with the standard six-string tuning", () => {
    const choice = readTuningChoice();
    expect(choice.strings).toBe(6);
    expect(tuningOf(choice)).toEqual([64, 59, 55, 50, 45, 40]);
  });

  it("remembers a tuning", () => {
    const drop = tuningPresets(7).find((p) => /^Drop/.test(p.name))!;
    storeTuningChoice({ strings: 7, name: drop.name });
    expect(readTuningChoice()).toEqual({ strings: 7, name: drop.name });
    expect(tuningOf(readTuningChoice())).toEqual(drop.tuning);
  });

  it("ignores a saved tuning that no longer exists", () => {
    localStorage.setItem("smart-beat:record-tuning", JSON.stringify({ strings: 6, name: "Gone" }));
    expect(readTuningChoice().strings).toBe(6);
    expect(readTuningChoice().name).not.toBe("Gone");
    localStorage.setItem("smart-beat:record-tuning", "not json");
    expect(readTuningChoice().strings).toBe(6);
  });

  it("names the standard tuning of 7 and 8 strings", () => {
    for (const strings of [7, 8]) {
      const choice = standardTuningChoice(strings);
      expect(choice.name).not.toBe("");
      expect(tuningOf(choice)).toHaveLength(strings);
    }
  });

  it("starts on the guitar and remembers guitar, bass, piano or drums", () => {
    expect(readInstrument()).toBe("guitar");
    for (const instrument of ["bass", "piano", "drums", "guitar"] as const) {
      storeInstrument(instrument);
      expect(readInstrument()).toBe(instrument);
    }
    localStorage.setItem("smart-beat:record-instrument", "kazoo");
    expect(readInstrument()).toBe("guitar");
  });

  it("starts on the built-in piano model and remembers the choice", () => {
    expect(readPianoEngine()).toBe("standard");
    storePianoEngine("accurate");
    expect(readPianoEngine()).toBe("accurate");
    localStorage.setItem("smart-beat:record-piano-engine", "something");
    expect(readPianoEngine()).toBe("standard");
  });

  it("starts a bass with the standard four strings and keeps its tuning apart from the guitar's", () => {
    const bass = readTuningChoice("bass");
    expect(bass.strings).toBe(4);
    expect(tuningOf(bass)).toEqual([43, 38, 33, 28]);
    storeTuningChoice({ strings: 5, name: tuningPresets(5)[0]!.name }, "bass");
    expect(readTuningChoice("bass").strings).toBe(5);
    expect(readTuningChoice("guitar").strings).toBe(6);
    // A guitar tuning is not a bass tuning, and the other way round.
    storeTuningChoice({ strings: 7, name: tuningPresets(7)[0]!.name }, "bass");
    expect(readTuningChoice("bass").strings).toBe(4);
    storeTuningChoice({ strings: 4, name: tuningPresets(4)[0]!.name }, "guitar");
    expect(readTuningChoice("guitar").strings).toBe(6);
  });
});
