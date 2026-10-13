import { readFileSync } from "node:fs";
import path from "node:path";

import { centsFrom, detectPitch, midiOf, nearestString, samplesNeeded } from "@/lib/audio/pitch";

const RATE = 48_000;
const hzOf = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** A plucked-string-like tone: harmonics that fade, plus some noise. */
function tone(
  hz: number,
  { harmonics = 1, noise = 0, length = samplesNeeded(RATE) } = {},
): Float32Array {
  // A fixed seed: the same noise every run.
  let seed = 7;
  const random = () => ((seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647) * 2 - 1;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let v = 0;
    for (let h = 1; h <= harmonics; h++) v += Math.sin((2 * Math.PI * hz * h * i) / RATE) / h;
    out[i] = 0.4 * v + noise * random();
  }
  return out;
}

/**
 * Accuracy over the range of guitars and basses (#83): a five-string bass's low B (B0, MIDI 23)
 * to a guitar's high E at the 12th fret (E5, MIDI 76), clean, rich in harmonics and noisy.
 */
describe("detectPitch", () => {
  const pitches = [23, 28, 33, 38, 40, 45, 50, 55, 59, 64, 69, 76];

  it.each(pitches)("finds MIDI %i within 2 cents in a pure tone", (midi) => {
    const found = detectPitch(tone(hzOf(midi)), RATE);
    expect(found).not.toBeNull();
    expect(Math.abs(centsFrom(found!.hz, midi))).toBeLessThanOrEqual(2);
  });

  it.each(pitches)("finds MIDI %i in a tone rich in harmonics, with noise", (midi) => {
    const found = detectPitch(tone(hzOf(midi), { harmonics: 6, noise: 0.05 }), RATE);
    expect(found).not.toBeNull();
    expect(Math.abs(centsFrom(found!.hz, midi))).toBeLessThanOrEqual(3);
  });

  it("hears a string 10 cents flat as 10 cents flat", () => {
    const found = detectPitch(tone(hzOf(40 - 0.1), { harmonics: 4 }), RATE)!;
    expect(centsFrom(found.hz, 40)).toBeGreaterThanOrEqual(-12);
    expect(centsFrom(found.hz, 40)).toBeLessThanOrEqual(-8);
  });

  it("hears a guitar plugged straight into an interface while it rings on", () => {
    // Three moments of a low E from a real interface, at -42, -47 and -40 dBFS. Its dips stay
    // over the threshold, and one frame has a deeper harmonic dip and one an octave below.
    const bytes = readFileSync(path.join(import.meta.dirname, "fixtures/low-e-di.f32"));
    const recording = new Float32Array(new Uint8Array(bytes).buffer);
    for (let i = 0; i < 3; i++) {
      const found = detectPitch(recording.subarray(i * 4096, (i + 1) * 4096), RATE);
      expect(found, `frame ${i}`).not.toBeNull();
      expect(Math.abs(centsFrom(found!.hz, 40)), `frame ${i}`).toBeLessThanOrEqual(15);
    }
  });

  it("hears a quiet string, down to -55 dBFS", () => {
    const quiet = tone(hzOf(40), { harmonics: 4 }).map((v) => v * 0.005);
    expect(Math.abs(centsFrom(detectPitch(quiet, RATE)!.hz, 40))).toBeLessThanOrEqual(3);
  });

  it("reports silence and noise as no pitch", () => {
    expect(detectPitch(new Float32Array(samplesNeeded(RATE)), RATE)).toBeNull();
    expect(detectPitch(tone(100, { noise: 0.5, harmonics: 0 }), RATE)).toBeNull();
  });

  it("needs about 70 ms of sound at 48 kHz for the lowest bass string", () => {
    // The analysis latency: two periods of the lowest pitch looked for.
    expect((samplesNeeded(RATE) / RATE) * 1000).toBeLessThan(75);
  });
});

describe("nearestString", () => {
  it("names the closest open string and how far off it is", () => {
    const guitar = [64, 59, 55, 50, 45, 40];
    expect(nearestString(hzOf(45.2), guitar)).toEqual({ index: 4, cents: 20 });
    expect(nearestString(hzOf(63.9), guitar)).toEqual({ index: 0, cents: -10 });
    expect(nearestString(440, [])).toBeNull();
    expect(midiOf(440)).toBe(69);
  });
});
