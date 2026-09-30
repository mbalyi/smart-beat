import { model } from "@coderline/alphatab";

import {
  BEAT_EFFECTS,
  BEND_PRESETS,
  bendOf,
  choiceLabel,
  describeCurve,
  effectAvailable,
  effectOff,
  harmonicValue,
  NOTE_EFFECTS,
  setBend,
  setWhammy,
  stepsText,
  whammyOf,
  WHAMMY_PRESETS,
  type Effect,
} from "@/lib/score/effects";
import { cloneBeat, cloneNote, refinish } from "@/lib/score/model";
import { generateMidi, noteOns, texScore } from "@/test/playback";

const { BendType, HarmonicType, SlideOutType, VibratoType, WhammyType } = model;

const song = () =>
  texScore(String.raw`\track "G" \staff {tabs} :4 5.3 7.3 5.3 7.3 | 12.1 12.1 12.1 12.1`);
const firstNote = (score: model.Score, beat = 0) =>
  score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[beat]!.notes[0]!;

describe("effect catalogue", () => {
  const all = [...Object.values(NOTE_EFFECTS), ...Object.values(BEAT_EFFECTS)] as Effect[];

  it("gives every effect a label, a short name and an off choice first", () => {
    for (const effect of all) {
      expect(effect.label).not.toBe("");
      expect(effect.short).not.toBe("");
      expect(effect.choices.length).toBeGreaterThanOrEqual(2);
      expect(effect.choices.some((c) => c.value === effect.on)).toBe(true);
      if (effect.id !== "trillSpeed") expect(effect.on).not.toBe(effectOff(effect));
    }
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
  });

  it("offers guitar techniques on tab tracks only", () => {
    expect(effectAvailable(NOTE_EFFECTS.palmMute, "stringed")).toBe(true);
    expect(effectAvailable(NOTE_EFFECTS.palmMute, "pitched")).toBe(false);
    expect(effectAvailable(NOTE_EFFECTS.ghost, "drums")).toBe(true);
    expect(effectAvailable(BEAT_EFFECTS.brush, "pitched")).toBe(true);
    expect(effectAvailable(BEAT_EFFECTS.slap, "drums")).toBe(false);
  });

  it("reads and writes every effect on the model", () => {
    const score = song();
    const note = firstNote(score);
    const beat = note.beat;
    for (const effect of Object.values(NOTE_EFFECTS)) {
      if (effect.id === "trillSpeed") continue;
      const on = effect.choices.at(-1)!.value;
      effect.set(note, on);
      expect(effect.get(note), effect.id).toBe(on);
      effect.set(note, effectOff(effect));
      expect(effect.get(note), effect.id).toBe(effectOff(effect));
    }
    for (const effect of Object.values(BEAT_EFFECTS)) {
      const on = effect.choices.at(-1)!.value;
      effect.set(beat, on);
      expect(effect.get(beat), effect.id).toBe(on);
      effect.set(beat, effectOff(effect));
      expect(effect.get(beat), effect.id).toBe(effectOff(effect));
    }
  });

  it("writes harmonics the way the Guitar Pro importer does", () => {
    const score = song();
    const note = firstNote(score, 0); // fret 5
    NOTE_EFFECTS.harmonic.set(note, HarmonicType.Natural);
    expect(note.harmonicValue).toBe(5);
    NOTE_EFFECTS.harmonic.set(note, HarmonicType.Pinch);
    expect(note.harmonicValue).toBe(12);
    NOTE_EFFECTS.harmonic.set(note, HarmonicType.None);
    expect(note.harmonicValue).toBe(0);
    expect(harmonicValue(2)).toBe(2.4);
    expect(harmonicValue(3)).toBe(3.2);
    expect(harmonicValue(7)).toBe(7);
    expect(harmonicValue(8)).toBe(12);
  });

  it("trills to a note a half or whole step up, and the player alternates them", () => {
    const score = song();
    const note = firstNote(score);
    NOTE_EFFECTS.trill.set(note, 2);
    expect(note.trillFret).toBe(note.fret + 2);
    expect(NOTE_EFFECTS.trill.get(note)).toBe(2);
    refinish(score);
    const keys = new Set(noteOns(generateMidi(score).file).map((e) => e.noteKey));
    expect(keys).toContain(note.realValue + 2);
    NOTE_EFFECTS.trill.set(note, 0);
    expect(note.isTrill).toBe(false);
  });

  it("names choices", () => {
    expect(choiceLabel(NOTE_EFFECTS.vibrato, VibratoType.Wide)).toBe("Wide vibrato");
    expect(choiceLabel(NOTE_EFFECTS.slideOut, SlideOutType.Legato)).toBe(
      "Legato slide to the next note",
    );
    expect(choiceLabel(NOTE_EFFECTS.vibrato, 99)).toBe("Vibrato");
  });
});

describe("bends and whammy bar", () => {
  it("bends a note with new points, and alphaTab recognises the bend", () => {
    const score = song();
    const note = firstNote(score);
    const points = BEND_PRESETS.find((p) => p.id === "bend-release")!.points(4);
    setBend(note, points);
    refinish(score);
    expect(note.hasBend).toBe(true);
    expect(note.bendType).toBe(BendType.BendRelease);
    expect(bendOf(note)).toEqual(points);

    setBend(note, [
      { offset: 0, value: 4 },
      { offset: 60, value: 4 },
    ]);
    refinish(score);
    expect(note.bendType).toBe(BendType.Prebend);
    setBend(note, null);
    refinish(score);
    expect(note.hasBend).toBe(false);
    expect(bendOf(note)).toBeNull();
  });

  it("sorts and limits bend points", () => {
    const score = song();
    const note = firstNote(score);
    setBend(note, [
      { offset: 70, value: 20 },
      { offset: -5, value: -3 },
    ]);
    expect(bendOf(note)).toEqual([
      { offset: 0, value: 0 },
      { offset: 60, value: 12 },
    ]);
    setBend(note, [{ offset: 0, value: 4 }]); // a single point is no bend
    expect(note.hasBend).toBe(false);
  });

  it("sets whammy bar dives below the note", () => {
    const score = song();
    const beat = firstNote(score).beat;
    const points = WHAMMY_PRESETS.find((p) => p.id === "dive")!.points(8);
    setWhammy(beat, points);
    refinish(score);
    expect(beat.hasWhammyBar).toBe(true);
    expect(beat.whammyBarType).not.toBe(WhammyType.None);
    expect(whammyOf(beat)).toEqual(points);
    expect(beat.minWhammyPoint!.value).toBe(-8);
    setWhammy(beat, null);
    expect(whammyOf(beat)).toBeNull();
  });

  it("gives copies of notes and beats their own points", () => {
    const score = song();
    const note = firstNote(score);
    setBend(note, BEND_PRESETS[0]!.points(4));
    setWhammy(note.beat, WHAMMY_PRESETS[0]!.points(4));
    BEAT_EFFECTS.tremolo.set(note.beat, 2);

    const noteCopy = cloneNote(note);
    expect(noteCopy.bendPoints).toEqual(note.bendPoints);
    expect(noteCopy.bendPoints![0]).not.toBe(note.bendPoints![0]);
    expect(noteCopy.maxBendPoint!.value).toBe(4);

    const beatCopy = cloneBeat(note.beat);
    expect(beatCopy.whammyBarPoints![1]).not.toBe(note.beat.whammyBarPoints![1]);
    expect(beatCopy.minWhammyPoint!.value).toBe(-4);
    expect(beatCopy.tremoloPicking).not.toBe(note.beat.tremoloPicking);
    expect(beatCopy.tremoloPicking!.marks).toBe(2);
  });

  it("describes curves in words", () => {
    expect(describeCurve(null)).toBe("None");
    expect(describeCurve(BEND_PRESETS[0]!.points(4))).toBe("full step up");
    expect(describeCurve(BEND_PRESETS[1]!.points(2))).toBe("½ step up and back");
    expect(describeCurve(BEND_PRESETS[3]!.points(4))).toBe("Held full step up");
    expect(describeCurve(BEND_PRESETS[4]!.points(6))).toBe("Starts 1½ steps up, released");
    expect(describeCurve(WHAMMY_PRESETS[0]!.points(8))).toBe("2 steps down");
    expect(stepsText(1)).toBe("¼ step");
    expect(stepsText(3)).toBe("¾ step");
    expect(stepsText(12)).toBe("3 steps");
    expect(stepsText(9)).toBe("2¼ steps");
  });
});
