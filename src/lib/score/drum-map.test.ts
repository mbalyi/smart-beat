import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  DRUM_FALLBACK,
  DRUM_MIDI_MAP,
  drumNumberName,
  drumOutputKey,
  LAST_PLAYABLE_DRUM,
  playableDrumKey,
} from "@/lib/score/drum-map";
import { drumKey, drumNumber, type Note } from "@/lib/score/model";
import { DRUM_KIT, DRUM_NOTATION } from "@/lib/score/music";
import { percussionKeys } from "@/lib/score/sf2-keys";

const SOUNDFONTS = path.join(import.meta.dirname, "../../../public/soundfont");
const load = (name: string) => new Uint8Array(readFileSync(path.join(SOUNDFONTS, name)));

describe("the drum map", () => {
  it("names every drum number from 27 to 127 that Guitar Pro shows", () => {
    expect(Object.keys(DRUM_MIDI_MAP)).toHaveLength(97);
    expect(drumNumberName(38)).toBe("Snare (hit)");
    expect(drumNumberName(91)).toBe("Snare (rim shot)");
    expect(drumNumberName(46)).toBe("Hi-Hat (open)");
    expect(drumNumberName(130)).toBe("Drum sound 130");
  });

  it("contains every sound of the drum pads and of the drum notation", () => {
    for (const { id } of DRUM_KIT) expect(DRUM_MIDI_MAP[id], `pad ${id}`).toBeDefined();
    for (const id of Object.keys(DRUM_NOTATION)) {
      expect(DRUM_MIDI_MAP[Number(id)], `notation ${id}`).toBeDefined();
    }
  });

  it("plays a number itself, or its fallback where the SoundFont has no sample", () => {
    expect(playableDrumKey(38)).toBe(38);
    expect(playableDrumKey(91)).toBe(38);
    expect(playableDrumKey(97)).toBe(49);
    expect(playableDrumKey(200)).toBe(200);
  });

  it("only has fallbacks for numbers beyond the SoundFont's range, pointing inside it", () => {
    for (const [from, to] of Object.entries(DRUM_FALLBACK)) {
      expect(Number(from), `${from} is silent`).toBeGreaterThan(LAST_PLAYABLE_DRUM);
      expect(to, `${from} → ${to}`).toBeLessThanOrEqual(LAST_PLAYABLE_DRUM);
      expect(DRUM_MIDI_MAP[to], `${from} → ${to} is a named sound`).toBeDefined();
    }
  });

  // The SoundFonts are downloaded before a build (public/soundfont is not in the repository).
  const fonts = [
    ["sonivox.sf2", existsSync(path.join(SOUNDFONTS, "sonivox.sf2"))],
    ["sonivox.sf3", existsSync(path.join(SOUNDFONTS, "sonivox.sf3"))],
    ["FluidR3Mono_GM.sf3", existsSync(path.join(SOUNDFONTS, "FluidR3Mono_GM.sf3"))],
  ] as const;
  for (const [name, present] of fonts) {
    it.skipIf(!present)(`every drum number plays in ${name} or has a fallback that does`, () => {
      const plays = percussionKeys(load(name));
      const missing: string[] = [];
      for (const key of Object.keys(DRUM_MIDI_MAP).map(Number)) {
        if (plays.has(key)) continue;
        const fallback = DRUM_FALLBACK[key];
        if (fallback === undefined || !plays.has(fallback)) {
          missing.push(`${key} ${DRUM_MIDI_MAP[key]}`);
        }
      }
      expect(missing).toEqual([]);
    });
  }

  it.skipIf(!existsSync(path.join(SOUNDFONTS, "sonivox.sf2")))(
    "the playable range really ends at 87 in the bundled SoundFont",
    () => {
      const keys = [...percussionKeys(load("sonivox.sf2")).keys()];
      expect(Math.max(...keys)).toBe(LAST_PLAYABLE_DRUM);
    },
  );
});

describe("drum numbers and the keys they play (#53)", () => {
  /** A note of a track without its own drum map, using a default articulation id. */
  const drumNote = (id: number, own: { outputMidiNumber: number }[] = []) =>
    ({
      percussionArticulation: id,
      isPercussion: true,
      beat: { voice: { bar: { staff: { track: { percussionArticulations: own } } } } },
    }) as unknown as Note;

  it("plays a Guitar Pro articulation through its output key, but shows its number", () => {
    // Regression: 92 "Hi-Hat (half)" was treated as key 92 while alphaTab plays 46.
    expect(drumKey(drumNote(92))).toBe(46);
    expect(drumNumber(drumNote(92))).toBe(92);
    expect(drumKey(drumNote(91))).toBe(38);
    expect(drumKey(drumNote(38))).toBe(38);
  });

  it("uses a track's own articulations as they are", () => {
    const note = drumNote(0, [{ outputMidiNumber: 42 }]);
    expect(drumKey(note)).toBe(42);
    expect(drumNumber(note)).toBe(42);
  });

  it("has an output key below 88 for every articulation above 87", () => {
    for (const id of Object.keys(DRUM_MIDI_MAP)
      .map(Number)
      .filter((n) => n > 87)) {
      expect(drumOutputKey(id), String(id)).toBeLessThanOrEqual(87);
    }
  });
});
