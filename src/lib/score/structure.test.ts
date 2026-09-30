import { model } from "@coderline/alphatab";

import { masterBarContent, refinish, type Score } from "@/lib/score/model";
import {
  applyBarSettings,
  barSettingsOf,
  barSettingsRange,
  changedParts,
  describeBar,
  DIRECTIONS,
  directionInfo,
  structureWarnings,
  tempoAt,
  toggleRepeatEnd,
  toggleRepeatStart,
  type BarSettings,
} from "@/lib/score/structure";
import { Snapshot } from "@/lib/score/snapshot";
import { playedBars, texScore } from "@/test/playback";

const { Direction, KeySignatureType, TripletFeel } = model;

/** Six bars of quarter notes on a guitar and a bass, at 100 BPM. */
const song = () =>
  texScore(String.raw`
\tempo 100
\track "Guitar" \staff {tabs}
:4 0.6 0.6 0.6 0.6 | 1.6 1.6 1.6 1.6 | 2.6 2.6 2.6 2.6 | 3.6 3.6 3.6 3.6 | r.1 | r.1
\track "Bass" \staff {tabs} \tuning (G2 D2 A1 E1)
:1 0.4 | 0.4 | 0.4 | 0.4 | 0.4 | 0.4
`);

function edit(score: Score, index: number, change: Partial<BarSettings>) {
  applyBarSettings(score, index, { ...barSettingsOf(score, index), ...change });
  refinish(score);
}

const times = (score: Score) =>
  score.masterBars.map((b) => `${b.timeSignatureNumerator}/${b.timeSignatureDenominator}`);

describe("bar settings", () => {
  it("reads a bar's structure", () => {
    const settings = barSettingsOf(song(), 0);
    expect(settings).toEqual({
      timeSignature: { numerator: 4, denominator: 4 },
      tripletFeel: TripletFeel.NoTripletFeel,
      keySignature: 0,
      keyType: KeySignatureType.Major,
      tempo: { bpm: 100, label: "" },
      section: "",
      repeatStart: false,
      repeatEnd: 0,
      endings: 0,
      directions: [],
    });
  });

  it("carries a time signature change on until the next change", () => {
    const score = song();
    edit(score, 4, { timeSignature: { numerator: 6, denominator: 8 } });
    edit(score, 1, { timeSignature: { numerator: 3, denominator: 4 } });
    expect(times(score)).toEqual(["4/4", "3/4", "3/4", "3/4", "6/8", "6/8"]);
  });

  it("gives bars that only hold rests new rests, and never moves notes", () => {
    const score = song();
    edit(score, 3, { timeSignature: { numerator: 3, denominator: 4 } });
    const guitar = score.tracks[0]!.staves[0]!;
    // Bar 4 keeps its four quarter notes (too full now); bar 5 gets a dotted half rest.
    expect(guitar.bars[3]!.voices[0]!.beats).toHaveLength(4);
    const rest = guitar.bars[4]!.voices[0]!.beats;
    expect(rest.map((b) => [b.duration, b.dots])).toEqual([[model.Duration.Half, 1]]);
  });

  it("sets the key on every track, until the next change", () => {
    const score = song();
    edit(score, 2, { keySignature: -3, keyType: KeySignatureType.Minor });
    for (const track of score.tracks) {
      expect(track.staves[0]!.bars.map((b) => b.keySignature)).toEqual([0, 0, -3, -3, -3, -3]);
    }
    expect(score.tracks[1]!.staves[0]!.bars[5]!.keySignatureType).toBe(KeySignatureType.Minor);
  });

  it("sets the triplet feel from a bar on, and the player swings", () => {
    const score = song();
    edit(score, 1, { tripletFeel: TripletFeel.Triplet8th });
    expect(score.masterBars.map((b) => b.tripletFeel)).toEqual([
      0,
      ...Array(5).fill(TripletFeel.Triplet8th),
    ]);
  });

  it("changes the tempo at a bar and keeps the song's tempo on the first bar", () => {
    const score = song();
    edit(score, 2, { tempo: { bpm: 140, label: "Faster" } });
    expect(tempoAt(score, 0)).toBe(100);
    expect(tempoAt(score, 3)).toBe(140);
    expect(barSettingsOf(score, 2).tempo).toEqual({ bpm: 140, label: "Faster" });
    expect(score.masterBars[2]!.tempoAutomations[0]!.text).toBe("Faster");

    edit(score, 2, { tempo: null });
    expect(tempoAt(score, 3)).toBe(100);
    edit(score, 0, { tempo: null }); // the first bar can't lose its tempo
    expect(barSettingsOf(score, 0).tempo?.bpm).toBe(100);
    expect(tempoAt(texScore(String.raw`\track "G" :1 r`), 0)).toBe(120);
  });

  it("keeps tempo changes later in the bar", () => {
    const score = song();
    const later = model.Automation.buildTempoAutomation(false, 0.5, 60, 2);
    score.masterBars[1]!.tempoAutomations.push(later);
    edit(score, 1, { tempo: { bpm: 90, label: "" } });
    expect(score.masterBars[1]!.tempoAutomations.map((a) => a.value)).toEqual([90, 60]);
    expect(tempoAt(score, 2)).toBe(60);
  });

  it("names sections, and removes them", () => {
    const score = song();
    edit(score, 1, { section: "  Chorus " });
    expect(score.masterBars[1]!.section?.text).toBe("Chorus");
    edit(score, 1, { section: "" });
    expect(score.masterBars[1]!.section).toBeNull();
  });

  it("writes repeats, endings and jumps", () => {
    const score = song();
    edit(score, 0, { repeatStart: true });
    edit(score, 2, { repeatEnd: 40, endings: 0b1_0000_0001 });
    edit(score, 3, { directions: [Direction.TargetFine, Direction.JumpDaCapo] });
    const bars = score.masterBars;
    expect(bars[0]!.isRepeatStart).toBe(true);
    expect(bars[2]!.repeatCount).toBe(32); // clamped
    expect(bars[2]!.alternateEndings).toBe(1); // only 8 endings
    expect([...bars[3]!.directions!]).toEqual([Direction.TargetFine, Direction.JumpDaCapo]);
    edit(score, 3, { directions: [], repeatEnd: 1 });
    expect(bars[3]!.directions).toBeNull();
    expect(bars[3]!.repeatCount).toBe(0);
  });

  it("toggles repeat signs", () => {
    const score = song();
    toggleRepeatStart(score, 1);
    toggleRepeatEnd(score, 2);
    expect(score.masterBars[1]!.isRepeatStart).toBe(true);
    expect(score.masterBars[2]!.repeatCount).toBe(2);
    toggleRepeatStart(score, 1);
    toggleRepeatEnd(score, 2);
    expect(score.masterBars[1]!.isRepeatStart).toBe(false);
    expect(score.masterBars[2]!.repeatCount).toBe(0);
  });

  it("says which parts changed", () => {
    const score = song();
    const before = barSettingsOf(score, 1);
    expect(changedParts(before, before)).toEqual([]);
    expect(
      changedParts(before, {
        ...before,
        timeSignature: { numerator: 7, denominator: 8 },
        tempo: { bpm: 80, label: "" },
        directions: [Direction.TargetCoda],
        repeatStart: true,
      }),
    ).toEqual(["time signature", "tempo", "repeat", "jump"]);
  });

  it("covers the bars an edit can change, for undo", () => {
    const score = song();
    const settings = barSettingsOf(score, 2);
    expect(barSettingsRange(score, 2, { ...settings, section: "A" })).toEqual({ from: 2, to: 2 });
    expect(barSettingsRange(score, 2, { ...settings, keySignature: 2 })).toEqual({
      from: 2,
      to: 5,
    });

    // Undo through snapshots of the range brings everything back.
    const next = { ...settings, timeSignature: { numerator: 2, denominator: 4 } };
    const range = barSettingsRange(score, 2, next);
    const json = model.JsonConverter.scoreToJson(score);
    const before = Snapshot.of(masterBarContent(score, range.from, range.to));
    applyBarSettings(score, 2, next);
    refinish(score);
    before.restore();
    refinish(score);
    expect(model.JsonConverter.scoreToJson(score)).toBe(json);
  });

  it("describes a bar for screen readers", () => {
    const score = song();
    edit(score, 0, { section: "Intro", repeatStart: true, directions: [Direction.TargetSegno] });
    expect(describeBar(score, 0)).toBe("4/4, C major, 100 BPM, Intro, repeat start, Segno");
  });
});

describe("playback order", () => {
  /** Six bars, one quarter-note each (bars are numbered from 0 below). */
  const bars = () =>
    texScore(String.raw`\track "G" \staff {tabs} :1 0.6 | 1.6 | 2.6 | 3.6 | 4.6 | 5.6`);

  it("plays repeats as often as they say", () => {
    const score = bars();
    edit(score, 1, { repeatStart: true });
    edit(score, 2, { repeatEnd: 3 });
    expect(playedBars(score)).toEqual([0, 1, 2, 1, 2, 1, 2, 3, 4, 5]);
  });

  it("plays first and second endings", () => {
    const score = bars();
    edit(score, 1, { repeatStart: true });
    edit(score, 2, { endings: 0b01, repeatEnd: 2 });
    edit(score, 3, { endings: 0b10 });
    expect(playedBars(score)).toEqual([0, 1, 2, 1, 3, 4, 5]);
  });

  it("jumps D.S. al Coda: back to the Segno, then to the Coda", () => {
    const score = bars();
    edit(score, 1, { directions: [Direction.TargetSegno] });
    edit(score, 2, { directions: [Direction.JumpDaCoda] });
    edit(score, 3, { directions: [Direction.JumpDalSegnoAlCoda] });
    edit(score, 5, { directions: [Direction.TargetCoda] });
    expect(playedBars(score)).toEqual([0, 1, 2, 3, 1, 2, 5]);
    expect(structureWarnings(score)).toEqual([]);
  });

  it("jumps D.C. al Fine: back to the start, and stops at Fine", () => {
    const score = bars();
    edit(score, 1, { directions: [Direction.TargetFine] });
    edit(score, 3, { directions: [Direction.JumpDaCapoAlFine] });
    expect(playedBars(score)).toEqual([0, 1, 2, 3, 0, 1]);
  });
});

describe("structure warnings", () => {
  const bars = () => texScore(String.raw`\track "G" :1 r | r | r | r`);

  it("warns about jumps without the signs they need", () => {
    const score = bars();
    edit(score, 3, { directions: [Direction.JumpDalSegnoAlCoda] });
    expect(structureWarnings(score)).toEqual([
      "A D.S. jump has no Segno to go back to.",
      "An “al Coda” jump needs a “To Coda” sign and a Coda.",
    ]);
    edit(score, 2, {
      directions: [Direction.JumpDalSegnoSegnoAlFine, Direction.JumpDaCapoAlDoubleCoda],
    });
    expect(structureWarnings(score)).toEqual(
      expect.arrayContaining([
        "A D.S.S. jump has no Segno Segno to go back to.",
        "An “al Double Coda” jump needs a “To Double Coda” sign and a Double Coda.",
        "An “al Fine” jump needs a Fine to stop at.",
      ]),
    );
  });

  it("warns that endings play again when a D.C. or D.S. goes back over them", () => {
    const warning =
      "After a D.C. or D.S. jump, playback plays every alternate ending (repeats are not played again).";
    const score = bars();
    edit(score, 1, { endings: 1 });
    expect(structureWarnings(score)).toEqual([]);
    edit(score, 3, { directions: [Direction.JumpDaCapo] });
    expect(structureWarnings(score)).toEqual([warning]);

    // A D.S. to a Segno after the endings never plays them again.
    edit(score, 2, { directions: [Direction.TargetSegno] });
    edit(score, 3, { directions: [Direction.JumpDalSegno] });
    expect(structureWarnings(score)).toEqual([]);
    // ...but one before them does.
    edit(score, 2, { directions: [] });
    edit(score, 0, { directions: [Direction.TargetSegno] });
    expect(structureWarnings(score)).toEqual([warning]);
    // The bar being edited counts with its draft values.
    expect(
      structureWarnings(score, { index: 1, settings: { directions: [], endings: 0 } }),
    ).toEqual([]);
  });

  it("describes every direction", () => {
    expect(DIRECTIONS).toHaveLength(19);
    expect(new Set(DIRECTIONS.map((d) => d.value)).size).toBe(19);
    expect(directionInfo(Direction.JumpDaCoda).label).toBe("To Coda");
  });
});
