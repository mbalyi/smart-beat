import { readFileSync } from "node:fs";
import path from "node:path";

import { percussionKeys } from "@/lib/score/sf2-keys";

const SONIVOX = path.join(import.meta.dirname, "../../../public/soundfont/sonivox.sf2");

describe("percussionKeys", () => {
  it("lists the keys of the percussion kit with their samples", () => {
    const keys = percussionKeys(new Uint8Array(readFileSync(SONIVOX)));

    expect(keys.size).toBe(61);
    expect([...keys.keys()].sort((a, b) => a - b)[0]).toBe(27);
    expect(keys.get(38)!.length).toBeGreaterThan(0); // the snare plays
    expect(keys.has(91)).toBe(false); // no rim shot sample
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

  it("reports a SoundFont without a percussion kit", () => {
    const bytes = readFileSync(SONIVOX);
    expect(() => percussionKeys(new Uint8Array(bytes), 99)).toThrow("no percussion kit");
  });
});
