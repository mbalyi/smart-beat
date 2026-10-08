import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { melodicRootKeys, NoPercussionError, percussionKeys } from "@/lib/score/sf2-keys";
import { makeDrumSoundFont, makeMelodicSoundFont } from "@/test/sf2";

/** The Sonivox SoundFont is downloaded before a build (public/soundfont is not in the repository). */
const SONIVOX = path.join(import.meta.dirname, "../../../public/soundfont/sonivox.sf2");
/** The copy that ships with alphaTab (always installed). */
const SONIVOX_SF3 = path.join(
  import.meta.dirname,
  "../../../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf3",
);

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

describe("melodicRootKeys (#43)", () => {
  it("finds the lowest recorded pitch of each program", () => {
    const font = makeMelodicSoundFont([
      {
        program: 30,
        zones: [
          { low: 0, high: 59, samplePitch: 47 },
          { low: 60, high: 127, samplePitch: 71 },
        ],
      },
      { program: 33, zones: [{ low: 0, high: 127, samplePitch: 28 }] },
    ]);
    const roots = melodicRootKeys(font);
    expect([...roots.entries()]).toEqual([
      [30, 47],
      [33, 28],
    ]);
  });

  it("lets a zone's own root key win over the sample's pitch", () => {
    const font = makeMelodicSoundFont([
      { program: 25, zones: [{ low: 0, high: 127, samplePitch: 60, rootKey: 45 }] },
    ]);
    expect(melodicRootKeys(font).get(25)).toBe(45);
  });

  it("ignores percussion and other banks, and reads a chosen bank", () => {
    const font = makeMelodicSoundFont([
      { program: 0, bank: 128, zones: [{ low: 35, high: 81, samplePitch: 60 }] },
      { program: 29, bank: 0, zones: [{ low: 0, high: 127, samplePitch: 47 }] },
      { program: 29, bank: 1, zones: [{ low: 0, high: 127, samplePitch: 40 }] },
    ]);
    expect([...melodicRootKeys(font).entries()]).toEqual([[29, 47]]);
    expect(melodicRootKeys(font, 1).get(29)).toBe(40);
    expect(melodicRootKeys(font, 128).get(0)).toBe(60);
  });

  it("leaves out programs the SoundFont does not have", () => {
    const font = makeMelodicSoundFont([
      { program: 30, zones: [{ low: 0, high: 127, samplePitch: 47 }] },
    ]);
    expect(melodicRootKeys(font).has(31)).toBe(false);
  });

  it("rejects a file that is not a SoundFont", () => {
    expect(() => melodicRootKeys(new Uint8Array(16))).toThrow("Not a SoundFont");
  });

  it.skipIf(!existsSync(SONIVOX_SF3))("reads the bundled Sonivox SoundFont", () => {
    const roots = melodicRootKeys(new Uint8Array(readFileSync(SONIVOX_SF3)));
    expect(roots.size).toBe(128);
    // The electric guitars were recorded from B2 up; the finger bass from C#1.
    expect(roots.get(29)).toBe(47);
    expect(roots.get(33)).toBe(25);
  });
});
