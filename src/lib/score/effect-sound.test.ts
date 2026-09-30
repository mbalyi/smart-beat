import { midi, model } from "@coderline/alphatab";

import {
  approximateSilentEffects,
  remapSilentDrums,
  VELOCITY_CHANGE,
  WAH_EXPRESSION,
} from "@/lib/score/effect-sound";
import { refinish } from "@/lib/score/model";
import { generateMidi, noteOns, texScore } from "@/test/playback";

const { PickStroke, WahPedal } = model;

/** One bar of four quarter notes on the low E string (frets 0–3), repeated once. */
const song = () => {
  const score = texScore(String.raw`\track "G" \staff {tabs} :4 0.6 1.6 2.6 3.6 | 5.6 5.6 5.6 5.6`);
  score.masterBars[0]!.isRepeatStart = true;
  score.masterBars[0]!.repeatCount = 2;
  refinish(score);
  return score;
};

const beats = (score: model.Score) => score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats;

/** Velocity of each note-on with this key, in playing order. */
const velocities = (file: midi.MidiFile, key: number) =>
  noteOns(file)
    .filter((e) => e.noteKey === key)
    .map((e) => e.noteVelocity);

describe("approximateSilentEffects", () => {
  it("plays slap, pop and tapping louder, in every repeat", () => {
    const score = song();
    const [slap, pop, tap] = beats(score);
    slap!.slap = true;
    pop!.pop = true;
    tap!.tap = true;
    refinish(score);
    const plain = generateMidi(score);
    const before = [40, 41, 42, 43].map((key) => velocities(plain.file, key));

    const { file, lookup } = generateMidi(score);
    const result = approximateSilentEffects(file, lookup);

    expect(result.notes).toBe(6); // three beats, played twice
    expect(velocities(file, 40)).toEqual(before[0]!.map((v) => v + VELOCITY_CHANGE.slap));
    expect(velocities(file, 41)).toEqual(before[1]!.map((v) => v + VELOCITY_CHANGE.pop));
    expect(velocities(file, 42)).toEqual(before[2]!.map((v) => v + VELOCITY_CHANGE.tap));
    expect(velocities(file, 43)).toEqual(before[3]); // no effect
  });

  it("plays downstrokes louder than upstrokes", () => {
    const score = song();
    beats(score)[0]!.pickStroke = PickStroke.Down;
    beats(score)[1]!.pickStroke = PickStroke.Up;
    refinish(score);
    const plain = velocities(generateMidi(score).file, 40)[0]!;
    const { file, lookup } = generateMidi(score);
    approximateSilentEffects(file, lookup);
    expect(velocities(file, 40)[0]).toBe(plain + VELOCITY_CHANGE.downstroke);
    expect(velocities(file, 41)[0]).toBe(plain + VELOCITY_CHANGE.upstroke);
  });

  it("turns the wah into expression changes where the pedal moves", () => {
    const score = song();
    beats(score)[1]!.wahPedal = WahPedal.Closed;
    beats(score)[2]!.wahPedal = WahPedal.Open;
    refinish(score);
    const { file, lookup } = generateMidi(score);
    const result = approximateSilentEffects(file, lookup);

    const expression = file.tracks
      .flatMap((t) => t.events)
      .filter(
        (e): e is midi.ControlChangeEvent =>
          e instanceof midi.ControlChangeEvent &&
          e.controller === midi.ControllerType.ExpressionControllerCoarse &&
          e.tick > 0,
      );
    // Closed, open, back to no wah at bar 2; then the same on the repeat.
    expect(result.wah).toBe(6);
    const channels = new Set(expression.map((e) => e.channel)).size;
    expect(expression.map((e) => e.value).filter((_, i) => i % channels === 0)).toEqual([
      WAH_EXPRESSION.closed,
      WAH_EXPRESSION.open,
      WAH_EXPRESSION.open,
      WAH_EXPRESSION.closed,
      WAH_EXPRESSION.open,
      WAH_EXPRESSION.open,
    ]);
    // Events stay in time order.
    const ticks = file.tracks[0]!.events.map((e) => e.tick);
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
  });

  it("leaves songs without these effects alone", () => {
    const score = song();
    const { file, lookup } = generateMidi(score);
    const before = noteOns(file).map((e) => e.noteVelocity);
    expect(approximateSilentEffects(file, lookup)).toEqual({ notes: 0, wah: 0 });
    expect(noteOns(file).map((e) => e.noteVelocity)).toEqual(before);
  });

  it("never goes past the loudest velocity", () => {
    const score = song();
    const beat = beats(score)[0]!;
    beat.slap = true;
    beat.pop = true;
    beat.tap = true;
    for (const note of beat.notes) note.accentuated = model.AccentuationType.Heavy;
    beat.dynamics = model.DynamicValue.FFF;
    refinish(score);
    const { file, lookup } = generateMidi(score);
    approximateSilentEffects(file, lookup);
    expect(Math.max(...velocities(file, 40))).toBeLessThanOrEqual(127);
  });
});

describe("remapSilentDrums", () => {
  const { NoteOffEvent, NoteOnEvent } = midi;
  const fileWith = (...events: midi.MidiEvent[]) =>
    ({ tracks: [{ events }] }) as unknown as midi.MidiFile;

  it("plays the closest sound for drum numbers the SoundFont has no sample for", () => {
    const rimOn = new NoteOnEvent(0, 0, 9, 91, 100);
    const rimOff = new NoteOffEvent(0, 10, 9, 91, 0);
    const snare = new NoteOnEvent(0, 20, 9, 38, 100);
    const crashChoke = new NoteOnEvent(0, 30, 9, 97, 100);

    const replaced = remapSilentDrums(fileWith(rimOn, rimOff, snare, crashChoke));

    expect(replaced).toBe(2); // notes, not note-offs
    expect([rimOn.noteKey, rimOff.noteKey, snare.noteKey, crashChoke.noteKey]).toEqual([
      38, 38, 38, 49,
    ]);
  });

  it("leaves other instruments alone, even on the same key number", () => {
    const piano = new NoteOnEvent(0, 0, 0, 91, 100);
    expect(remapSilentDrums(fileWith(piano))).toBe(0);
    expect(piano.noteKey).toBe(91);
  });
});
