import { describe, expect, it } from "vitest";

import { ScoreEditor } from "@/lib/score/editor";
import type { Beat, Score } from "@/lib/score/model";
import {
  applyRetunePlan,
  applyTransposePlan,
  beatsFor,
  findPosition,
  MAX_TRANSPOSE,
  planRetune,
  planTranspose,
  transposeKey,
  transposeMusic,
} from "@/lib/score/transpose";
import { retuneKeepingPitches } from "@/lib/score/tracks";
import { texScore } from "@/test/playback";
import { shotOf } from "@/test/score-snapshot";

const TAB = String.raw`
\track "Guitar" \staff {score tabs} \instrument 25
  :4 0.6 3.5 (2.4 0.3) 24.1 | :4 5.2 7.2 12.6 r
\track "Piano" \staff {score} \instrument 0
  :4 c4 e4 g4 c5 | :1 (c4 e4 g4)
\track "Drums" \instrument percussion \articulation defaults
  :4 38 38 38 38 | :4 38 38 38 38
`;

const beatsOf = (score: Score, track: number): Beat[] =>
  score.tracks[track]!.staves[0]!.bars.flatMap((bar) => bar.voices[0]!.beats);

const frets = (score: Score) =>
  beatsOf(score, 0).map((b) => b.notes.map((n) => `${n.string}/${n.fret}`));

describe("transposing", () => {
  it("moves tab notes along their strings and pitched notes by pitch", () => {
    const score = texScore(TAB);
    const editor = new ScoreEditor(score);
    const result = transposeMusic(editor, { scope: "track", semitones: 2, keySignatures: false });
    expect(result).toMatchObject({ ok: true, moved: 8 });
    // alphaTab numbers strings from the lowest: 1 = low E, 6 = high E.
    expect(frets(score).slice(0, 4)).toEqual([["1/2"], ["2/5"], ["3/4", "4/2"], ["6/26"]]);
    // The piano is another track: unchanged.
    expect(beatsOf(score, 1)[0]!.notes[0]!.realValue).toBe(60);
  });

  it("refuses a move that leaves the fretboard on every string", () => {
    const score = texScore(TAB);
    // 24.1 (high E, fret 24) six semitones up would need fret 30.
    const plan = planTranspose(beatsOf(score, 0), 6);
    expect(plan.unplayable).toBe(1);
    expect(() => applyTransposePlan(plan)).toThrow(/do not fit/);
    // Down: the open low E has nowhere to go.
    expect(planTranspose(beatsOf(score, 0), -2).unplayable).toBeGreaterThan(0);
  });

  it("re-maps to another string when only the fret runs out", () => {
    const score = texScore(String.raw`\track "G" \staff {score tabs} :1 22.6`);
    const plan = planTranspose(beatsOf(score, 0), 9); // low E fret 31 does not exist
    expect(plan.unplayable).toBe(0);
    applyTransposePlan(plan);
    const note = beatsOf(score, 0)[0]!.notes[0]!;
    expect(note.realValue).toBe(40 + 22 + 9);
    expect(note.string).toBeGreaterThan(1);
  });

  it("refuses a transposition that would lose notes, and changes nothing", () => {
    const score = texScore(TAB);
    const editor = new ScoreEditor(score);
    const before = JSON.stringify(shotOf(score));
    const result = transposeMusic(editor, { scope: "score", semitones: -1, keySignatures: true });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.message).toBe(
        "1 note does not fit on the instrument after moving 1 semitone down. Nothing was changed.",
      );
    expect(JSON.stringify(shotOf(score))).toBe(before);
    expect(editor.canUndo).toBe(false);
  });

  it("transposes the whole song, leaves drums alone and can be undone", () => {
    const score = texScore(String.raw`
\track "Piano" \staff {score} \instrument 0 :4 c4 e4 g4 c5
\track "Drums" \instrument percussion \articulation defaults :4 38 38 38 38
`);
    const editor = new ScoreEditor(score);
    const drum = beatsOf(score, 1)[0]!.notes[0]!.percussionArticulation;
    const moved = transposeMusic(editor, { scope: "score", semitones: 12, keySignatures: false });
    expect(moved).toMatchObject({ ok: true, moved: 4 });
    expect(beatsOf(score, 0).map((b) => b.notes[0]!.realValue)).toEqual([72, 76, 79, 84]);
    expect(beatsOf(score, 1)[0]!.notes[0]!.percussionArticulation).toBe(drum);
    editor.undo();
    expect(beatsOf(score, 0).map((b) => b.notes[0]!.realValue)).toEqual([60, 64, 67, 72]);
  });

  it("moves key signatures with the notes, except in a selection", () => {
    const score = texScore(
      String.raw`\track "Piano" \staff {score} \instrument 0 \ks C :4 c4 d4 e4 f4 | :1 c4`,
    );
    const editor = new ScoreEditor(score);
    transposeMusic(editor, { scope: "track", semitones: 2, keySignatures: true });
    expect(score.tracks[0]!.staves[0]!.bars.map((b) => b.keySignature)).toEqual([2, 2]);
    transposeMusic(editor, { scope: "track", semitones: -2, keySignatures: false });
    expect(score.tracks[0]!.staves[0]!.bars.map((b) => b.keySignature)).toEqual([2, 2]);
  });

  it("transposes the selection, or the note at the cursor without one", () => {
    const score = texScore(TAB);
    const editor = new ScoreEditor(score);
    editor.moveBeat(1);
    expect(
      transposeMusic(editor, { scope: "selection", semitones: 1, keySignatures: true }),
    ).toMatchObject({ ok: true, moved: 1 });
    expect(frets(score)[1]).toEqual(["2/4"]);
    expect(frets(score)[0]).toEqual(["1/0"]);
    editor.moveBeat(1, true);
    const both = transposeMusic(editor, { scope: "selection", semitones: 1, keySignatures: false });
    expect(both).toMatchObject({ ok: true, moved: 3 });
  });

  it("validates the amount", () => {
    const editor = new ScoreEditor(texScore(TAB));
    for (const semitones of [0, 1.5, MAX_TRANSPOSE + 1, -MAX_TRANSPOSE - 1, NaN]) {
      const result = transposeMusic(editor, { scope: "track", semitones, keySignatures: false });
      expect(result.ok).toBe(false);
    }
  });

  it("reports when there is nothing to move", () => {
    const editor = new ScoreEditor(texScore(String.raw`\track "G" \staff {score tabs} :1 r`));
    const result = transposeMusic(editor, { scope: "track", semitones: 2, keySignatures: false });
    expect(result).toMatchObject({ ok: false, message: "There are no notes to move." });
  });

  it("folds key signatures to the side with fewer accidentals", () => {
    expect(transposeKey(0, 2)).toBe(2); // C → D
    expect(transposeKey(0, 1)).toBe(-5); // C → D♭
    expect(transposeKey(2, -2)).toBe(0);
    expect(transposeKey(-3, 12)).toBe(-3);
    expect(transposeKey(5, 1)).toBe(0); // B major → C major
  });

  it("chooses scopes", () => {
    const score = texScore(TAB);
    expect(beatsFor(score, "track", 1, []).length).toBe(5);
    expect(beatsFor(score, "score", 0, []).length).toBe(8 + 5 + 8);
    expect(beatsFor(score, "selection", 0, [])).toEqual([]);
  });

  it("finds positions near a string, skipping taken strings", () => {
    const score = texScore(TAB);
    const staff = score.tracks[0]!.staves[0]!;
    expect(findPosition(staff, 64, 6, new Set())).toEqual({ string: 6, fret: 0 });
    expect(findPosition(staff, 64, 6, new Set([6]))).toEqual({ string: 5, fret: 5 });
    expect(findPosition(staff, 20, 1, new Set())).toBeNull();
  });
});

describe("keeping pitches when the tuning changes", () => {
  const SONG = String.raw`\track "G" \staff {score tabs} \instrument 25 :4 0.6 0.5 0.4 (0.6 0.1) | :1 3.3`;

  it("drops the low string by two semitones and moves notes up the neck", () => {
    const score = texScore(SONG);
    const staff = score.tracks[0]!.staves[0]!;
    const before = beatsOf(score, 0).map((b) => b.notes.map((n) => n.realValue).sort());
    const removed = retuneKeepingPitches(staff, [64, 59, 55, 50, 45, 38], 0);
    expect(removed).toBe(0);
    const after = beatsOf(score, 0).map((b) => b.notes.map((n) => n.realValue).sort());
    expect(after).toEqual(before);
    // Dropped D: the open low E is now the second fret of the low string.
    expect(beatsOf(score, 0)[0]!.notes[0]!.fret).toBe(2);
  });

  it("moves notes to another string when they no longer fit and deletes impossible ones", () => {
    const score = texScore(SONG);
    const staff = score.tracks[0]!.staves[0]!;
    // Raise everything by a fourth with a capo: pitches below the new lowest pitch can't be played.
    const plan = planRetune(staff, [64, 59, 55, 50, 45, 40], 5);
    expect(plan.unplayable.length).toBeGreaterThan(0);
    const removed = retuneKeepingPitches(staff, [64, 59, 55, 50, 45, 40], 5);
    expect(removed).toBe(plan.unplayable.length);
    expect(staff.capo).toBe(5);
    for (const beat of beatsOf(score, 0)) {
      for (const note of beat.notes) {
        expect(note.realValue).toBeGreaterThanOrEqual(45);
      }
    }
  });

  it("keeps pitches with fewer strings, putting notes on other strings", () => {
    const score = texScore(SONG);
    const staff = score.tracks[0]!.staves[0]!;
    const plan = planRetune(staff, [64, 59, 55, 50, 45], 0);
    expect(plan.unplayable.length).toBeGreaterThan(0); // low E has no string left
    applyRetunePlan(plan);
  });

  it("ignores tracks without strings", () => {
    const score = texScore(TAB);
    const piano = score.tracks[1]!.staves[0]!;
    expect(planRetune(piano, [64, 59], 0)).toEqual({ placements: [], unplayable: [] });
    expect(retuneKeepingPitches(piano, [64, 59], 0)).toBe(0);
  });
});
