/**
 * e2e/fixtures/structure-song.gp (see scripts/make-fixtures.mjs) read back
 * from Guitar Pro 7: structure, lyrics, chords and techniques survive, and
 * Smart Beat's model code leaves them as they are.
 */
import { model } from "@coderline/alphatab";

import { chordOf } from "@/lib/score/chords";
import { bendOf, NOTE_EFFECTS } from "@/lib/score/effects";
import { lyricsOf } from "@/lib/score/lyrics";
import { refinish } from "@/lib/score/model";
import { parseScore } from "@/lib/score/score";
import { barSettingsOf, structureWarnings } from "@/lib/score/structure";
import { playedBars } from "@/test/playback";
import { fixtureBytes } from "@/test/score";

const { Direction, HarmonicType, SlideOutType, VibratoType } = model;

const load = () => parseScore(fixtureBytes("structure-song.gp")).score;

describe("structure-song.gp", () => {
  it("keeps sections, repeats, endings, jumps, key and tempo", () => {
    const score = load();
    expect(score.masterBars.map((b) => b.section?.text ?? "")).toEqual([
      "Intro",
      "",
      "",
      "Verse",
      "",
      "",
      "Coda",
    ]);
    expect(barSettingsOf(score, 0)).toMatchObject({ repeatStart: true, tempo: { bpm: 100 } });
    expect(barSettingsOf(score, 1)).toMatchObject({ repeatEnd: 2, endings: 0b01 });
    expect(barSettingsOf(score, 2)).toMatchObject({ endings: 0b10 });
    expect(barSettingsOf(score, 3)).toMatchObject({
      keySignature: 1,
      directions: [Direction.TargetSegno],
    });
    expect(barSettingsOf(score, 5).directions).toEqual([Direction.JumpDalSegnoAlCoda]);
    expect(barSettingsOf(score, 6)).toMatchObject({
      tempo: { bpm: 150 },
      directions: [Direction.TargetCoda],
    });
    expect(structureWarnings(score)).toEqual([]);
  });

  it("plays repeats, endings and D.S. al Coda in order", () => {
    expect(playedBars(load())).toEqual([0, 1, 0, 2, 3, 4, 5, 3, 4, 6]);
  });

  it("keeps lyrics, chords and techniques", () => {
    const score = load();
    const track = score.tracks[0]!;
    expect(lyricsOf(track)).toEqual([
      { startBar: 0, text: "Ev-ery bar we sing a lit-tle more of this song for you and me" },
    ]);
    const bars = track.staves[0]!.bars;
    const beat = (bar: number, index: number) => bars[bar]!.voices[0]!.beats[index]!;
    expect(chordOf(beat(3, 0))).toMatchObject({ name: "G", showDiagram: true });
    expect(NOTE_EFFECTS.palmMute.get(beat(3, 1).notes[0]!)).toBe(1);
    expect(NOTE_EFFECTS.hammerPull.get(beat(3, 2).notes[0]!)).toBe(1);
    expect(NOTE_EFFECTS.vibrato.get(beat(4, 0).notes[0]!)).not.toBe(VibratoType.None);
    expect(bendOf(beat(4, 1).notes[0]!)).not.toBeNull();
    expect(beat(4, 2).notes[0]!.slideOutType).toBe(SlideOutType.Legato); // alphaTex "sl"
    expect(beat(5, 0).notes[0]!.harmonicType).toBe(HarmonicType.Natural);
  });

  it("comes out of refinish exactly as it was read, lyrics included", () => {
    const score = load();
    const before = model.JsonConverter.scoreToJson(score);
    refinish(score);
    refinish(score);
    expect(model.JsonConverter.scoreToJson(score)).toBe(before);
  });
});
