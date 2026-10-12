import {
  readPlayOthers,
  readTuningChoice,
  standardTuningChoice,
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
});
