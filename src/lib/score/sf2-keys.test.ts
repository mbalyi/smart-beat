import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { NoPercussionError, percussionKeys } from "@/lib/score/sf2-keys";
import { makeDrumSoundFont } from "@/test/sf2";

/** The Sonivox SoundFont is downloaded before a build (public/soundfont is not in the repository). */
const SONIVOX = path.join(import.meta.dirname, "../../../public/soundfont/sonivox.sf2");

describe("percussionKeys", () => {
  it("lists the keys of the percussion kit with the samples that sound on them", () => {
    const font = makeDrumSoundFont([
      { low: 35, high: 36, sample: "Kick" },
      { low: 38, high: 38, sample: "Snare" },
      { low: 40, high: 41, sample: "Snare 2" },
      { low: 41, high: 42, sample: "Tom" },
    ]);

    const keys = percussionKeys(font);

    expect([...keys.keys()]).toEqual([35, 36, 38, 40, 41, 42]);
    expect(keys.get(36)).toEqual(["Kick"]);
    expect(keys.get(41)).toEqual(["Snare 2", "Tom"]); // two samples on one key
    expect(keys.has(37)).toBe(false); // no sample: silent
  });

  it("finds another program of the kit, and refuses a SoundFont without a percussion kit", () => {
    const font = makeDrumSoundFont([{ low: 36, high: 36, sample: "Kick" }], { program: 8 });
    expect(percussionKeys(font, 8).has(36)).toBe(true);
    expect(() => percussionKeys(font, 0)).toThrow(NoPercussionError);
    const melodic = makeDrumSoundFont([{ low: 36, high: 36, sample: "Kick" }], { bank: 0 });
    expect(() => percussionKeys(melodic)).toThrow("no percussion kit");
  });

  it("refuses files that are not SoundFonts", () => {
    expect(() => percussionKeys(new TextEncoder().encode("<!DOCTYPE html><html></html>"))).toThrow(
      "Not a SoundFont",
    );
  });

  it("refuses a SoundFont without instrument data", () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode("RIFF"),
      4,
      0,
      0,
      0,
      ...new TextEncoder().encode("sfbk"),
    ]);
    expect(() => percussionKeys(bytes)).toThrow("no instrument data");
  });

  it.skipIf(!existsSync(SONIVOX))("reads the bundled Sonivox SoundFont", () => {
    const keys = percussionKeys(new Uint8Array(readFileSync(SONIVOX)));
    expect(keys.size).toBe(61);
    expect(Math.min(...keys.keys())).toBe(27);
    expect(Math.max(...keys.keys())).toBe(87);
    expect(keys.has(91)).toBe(false); // no rim shot sample
  });
});
