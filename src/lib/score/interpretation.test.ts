import { midi } from "@coderline/alphatab";

import { trackChannels } from "@/lib/audio/native-engine";
import {
  applyInterpretation,
  DEFAULT_INTERPRETATION,
  isDefaultInterpretation,
  normalizeInterpretation,
  type Interpretation,
} from "@/lib/score/interpretation";
import { generateMidi, noteOns, texScore } from "@/test/playback";

const { NoteOffEvent } = midi;

/** Bar 1: a palm-muted note, an accented note, a plain note, a three-note chord. */
const SONG = String.raw`\track "G" \staff {tabs} :4 5.6{pm} 5.6{ac} 5.6 (0.6 2.5 2.4)`;

function play(value: Partial<Interpretation>) {
  const score = texScore(SONG);
  const { file, lookup } = generateMidi(score);
  const before = noteOns(file).map((e) => ({ tick: e.tick, key: e.noteKey, vel: e.noteVelocity }));
  const changed = applyInterpretation(
    file,
    score,
    lookup,
    [{ ...DEFAULT_INTERPRETATION, ...value }],
    trackChannels(score),
  );
  const after = noteOns(file).map((e) => ({ tick: e.tick, key: e.noteKey, vel: e.noteVelocity }));
  const offs = file.events.filter((e): e is midi.NoteOffEvent => e instanceof NoteOffEvent);
  return { before, after, offs, changed, file };
}

describe("applyInterpretation", () => {
  it("leaves the MIDI alone with the default interpretation", () => {
    const { before, after, changed } = play({});
    expect(changed).toBe(0);
    expect(after).toEqual(before);
  });

  it("plays fingerstyle softer and slaps harder", () => {
    const fingers = play({ style: "fingers" });
    expect(fingers.after[2]!.vel).toBeLessThan(fingers.before[2]!.vel);
    const slap = play({ style: "slap" });
    expect(slap.after[2]!.vel).toBeGreaterThan(slap.before[2]!.vel);
  });

  it("makes palm mutes more muted and accents stronger, only on those notes", () => {
    const { before, after } = play({ palmMute: 1, accent: 1 });
    expect(after[0]!.vel).toBeLessThan(before[0]!.vel); // palm-muted
    expect(after[1]!.vel).toBeGreaterThan(before[1]!.vel); // accented
    expect(after[2]!.vel).toBe(before[2]!.vel); // plain
  });

  it("strums chords low to high with auto brush", () => {
    const { before, after } = play({ brush: true });
    const chordTick = before.at(-1)!.tick;
    const chord = after.filter((e) => e.tick >= chordTick).sort((a, b) => a.tick - b.tick);
    expect(chord).toHaveLength(3);
    expect(new Set(chord.map((e) => e.tick)).size).toBe(3);
    expect(chord.map((e) => e.key)).toEqual([...chord.map((e) => e.key)].sort((a, b) => a - b));
  });

  it("lets notes ring on with auto let ring, until the same note comes again", () => {
    const plain = play({});
    const ring = play({ letRing: true });
    const lastOff = (offs: midi.NoteOffEvent[]) => Math.max(...offs.map((o) => o.tick));
    expect(lastOff(ring.offs)).toBeGreaterThan(lastOff(plain.offs));
    // The repeated 5.6 notes still stop before the next one starts.
    const repeated = ring.after.filter((e) => e.key === ring.after[0]!.key);
    const offsOfKey = ring.offs
      .filter((o) => o.noteKey === repeated[0]!.key)
      .sort((a, b) => a.tick - b.tick);
    expect(offsOfKey[0]!.tick).toBeLessThan(repeated[1]!.tick);
  });

  it("does not touch drum tracks", () => {
    const score = texScore(
      String.raw`\track "D" \instrument percussion \staff {score} :4 36 38 36 38`,
    );
    const { file, lookup } = generateMidi(score);
    const before = noteOns(file).map((e) => e.noteVelocity);
    applyInterpretation(
      file,
      score,
      lookup,
      [{ ...DEFAULT_INTERPRETATION, style: "slap" }],
      trackChannels(score),
    );
    expect(noteOns(file).map((e) => e.noteVelocity)).toEqual(before);
  });
});

describe("normalizeInterpretation", () => {
  it("keeps valid values and replaces the rest by the defaults", () => {
    expect(
      normalizeInterpretation({ style: "slap", palmMute: 2, accent: -1, letRing: true }),
    ).toEqual({
      style: "slap",
      palmMute: 1,
      accent: 0,
      letRing: true,
      brush: false,
    });
    expect(normalizeInterpretation(null)).toEqual(DEFAULT_INTERPRETATION);
    expect(isDefaultInterpretation(DEFAULT_INTERPRETATION)).toBe(true);
  });
});
