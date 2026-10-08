import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { lowestRecording, lowSoundWarning } from "@/lib/audio/sound-ranges";
import ranges from "@/lib/audio/sound-ranges.json";
import { melodicRootKeys } from "@/lib/score/sf2-keys";

const ROOT = path.join(import.meta.dirname, "../../..");
const SONIVOX = path.join(ROOT, "node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf3");
const FLUIDR3 = path.join(ROOT, "node_modules/.cache/smart-beat/soundfonts/FluidR3Mono_GM.sf3");

const OVERDRIVEN_GUITAR = 29;
const FINGER_BASS = 33;

describe("the lowest recordings of the bundled sounds", () => {
  it("knows them for every General MIDI program of both sound sets", () => {
    for (const soundFont of ["sonivox", "fluidr3"] as const) {
      for (let program = 0; program < 128; program++) {
        expect(lowestRecording(soundFont, program), `${soundFont} ${program}`).not.toBeNull();
      }
    }
    expect(lowestRecording("sonivox", OVERDRIVEN_GUITAR)).toBe(47);
    expect(lowestRecording("fluidr3", OVERDRIVEN_GUITAR)).toBe(40);
    expect(lowestRecording("sonivox", 500)).toBeNull();
  });

  // The committed table is generated; this keeps it in step with the SoundFonts.
  it.skipIf(!existsSync(SONIVOX))("matches the Sonivox SoundFont", () => {
    const fresh = Object.fromEntries(melodicRootKeys(new Uint8Array(readFileSync(SONIVOX))));
    expect(fresh).toEqual(ranges.sonivox);
  });

  it.skipIf(!existsSync(FLUIDR3))("matches the FluidR3 SoundFont", () => {
    const fresh = Object.fromEntries(melodicRootKeys(new Uint8Array(readFileSync(FLUIDR3))));
    expect(fresh).toEqual(ranges.fluidr3);
  });
});

describe("lowSoundWarning", () => {
  it("stays quiet for a guitar within an octave of its recordings", () => {
    // Sonivox: recorded from B2 (47), so down to B1 (35) is fine: a 7-string guitar.
    expect(lowSoundWarning("sonivox", OVERDRIVEN_GUITAR, 35)).toBeNull();
    expect(lowSoundWarning("sonivox", OVERDRIVEN_GUITAR, 40)).toBeNull();
    // Standard guitar tuning on every guitar sound of both sets.
    for (const program of [24, 25, 26, 27, 28, 29, 30]) {
      expect(lowSoundWarning("sonivox", program, 40), `sonivox ${program}`).toBeNull();
      expect(lowSoundWarning("fluidr3", program, 40), `fluidr3 ${program}`).toBeNull();
    }
  });

  it("leaves the usual guitar range alone even on a sound that is one stretched recording", () => {
    // Sonivox's jazz guitar is a single recording at D#5 for the whole keyboard (MIDI 75).
    expect(lowestRecording("sonivox", 26)).toBe(75);
    for (const lowest of [40, 38, 36, 35])
      expect(lowSoundWarning("sonivox", 26, lowest)).toBeNull();
    // Below B1 it is reported.
    expect(lowSoundWarning("sonivox", 26, 34)).not.toBeNull();
  });

  it("warns for an 8-string guitar and says what to do", () => {
    const warning = lowSoundWarning("sonivox", OVERDRIVEN_GUITAR, 30)!;
    expect(warning).not.toBeNull();
    expect(warning.lowest).toBe("F#1");
    expect(warning.recorded).toBe("B2");
    expect(warning.message).toContain("The lowest string (F#1)");
    expect(warning.message).toContain("lowest recording of this sound (B2)");
    // FluidR3 goes lower, so it is suggested by its name.
    expect(warning.betterSoundFont).toBe("fluidr3");
    expect(warning.message).toContain("High quality");
  });

  it("suggests a bass sound when no sound set helps", () => {
    // C#1 (25), a 9-string guitar: thin in both sound sets.
    const warning = lowSoundWarning("fluidr3", OVERDRIVEN_GUITAR, 25)!;
    expect(warning.betterSoundFont).toBeNull();
    expect(warning.message).toContain("bass sound");
  });

  it("is quiet for a bass on its own sound, and when nothing is known", () => {
    // A 5-string bass (B0 = 23) and a 6-string bass on the finger bass.
    expect(lowSoundWarning("sonivox", FINGER_BASS, 23)).toBeNull();
    expect(lowSoundWarning("fluidr3", FINGER_BASS, 23)).toBeNull();
    expect(lowSoundWarning("sonivox", 999, 0)).toBeNull();
  });

  it("uses an octave as the limit: exactly 12 semitones below is fine, 13 is not", () => {
    // A sound recorded from B1 (35): its octave limit (B0 = 23) is below the usual guitar floor.
    const lowRoot = lowestRecording("sonivox", 39)!; // synth bass 2: recorded from G#1 (32)
    expect(lowSoundWarning("sonivox", 39, lowRoot - 12)).toBeNull();
    expect(lowSoundWarning("sonivox", 39, lowRoot - 13)).not.toBeNull();
  });
});
