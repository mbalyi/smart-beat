import { describe, expect, it } from "vitest";

import {
  barProblems,
  beatTicks,
  describeProblem,
  fillDurations,
  fixBarDurations,
  fixTargets,
  isShort,
  voiceTicks,
} from "@/lib/score/bar-duration";
import { ScoreEditor } from "@/lib/score/editor";
import { refinish } from "@/lib/score/model";
import { texScore } from "@/test/playback";

const fixed = (tex: string) => texScore(tex);

describe("bar durations", () => {
  it("finds no problems in a correct song", () => {
    const score = fixed(String.raw`\track "G" \staff {score tabs} :4 3.6 5.6 7.6 5.6 | :2 3.6 5.6`);
    expect(barProblems(score)).toEqual([]);
  });

  it("finds short and long bars with their length", () => {
    const score = fixed(
      String.raw`\track "G" \staff {score tabs} :4 3.6 5.6 7.6 | :4 3.6 5.6 7.6 5.6 5.6 | :1 3.6`,
    );
    const problems = barProblems(score);
    expect(problems.map((p) => [p.bar, p.actual, p.expected, isShort(p)])).toEqual([
      [0, 2880, 3840, true],
      [1, 4800, 3840, false],
    ]);
    expect(describeProblem(problems[0]!)).toBe("Bar 1 is 1 beat too short");
    expect(describeProblem(problems[1]!)).toBe("Bar 2 is 1 beat too long");
  });

  it("measures triplets and dotted notes exactly", () => {
    const score = fixed(
      String.raw`\track "G" \staff {score tabs} :8 {tu 3} 3.6 3.6 3.6 :4 3.6 :2 3.6 | :4 3.6{d} :8 3.6 :2 3.6`,
    );
    expect(barProblems(score)).toEqual([]);
    const beat = score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!;
    expect(beatTicks(beat)).toBeCloseTo(320);
  });

  it("does not judge pickup bars, empty second voices or other tracks when asked for one", () => {
    const score = fixed(String.raw`
\track "A" \staff {score tabs} :4 3.6 | :1 3.6
\track "B" \staff {score tabs} :4 3.6 | :1 3.6
`);
    score.masterBars[0]!.isAnacrusis = true;
    expect(barProblems(score)).toEqual([]);
    score.masterBars[0]!.isAnacrusis = false;
    expect(barProblems(score).map((p) => [p.track, p.bar])).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(barProblems(score, 1).map((p) => p.track)).toEqual([1]);
    const voice = score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!;
    expect(voiceTicks(voice)).toBe(960);
  });

  it("decomposes a length into note values, longest first", () => {
    expect(fillDurations(3840)).toEqual([{ duration: 1, dots: 0 }]);
    expect(fillDurations(2880)).toEqual([{ duration: 2, dots: 1 }]);
    expect(fillDurations(960 + 240)).toEqual([
      { duration: 4, dots: 0 },
      { duration: 16, dots: 0 },
    ]);
    expect(fillDurations(0)).toEqual([]);
    expect(fillDurations(30)).toEqual([]); // shorter than a 64th: left alone
  });

  it("fills a short bar with rests, keeping the notes", () => {
    const score = fixed(String.raw`\track "G" \staff {score tabs} :4 3.6 5.6 7.6 | :1 3.6`);
    const editor = new ScoreEditor(score);
    const problems = barProblems(score);
    editor.run(
      "Fix",
      () => fixTargets(score, problems),
      () => fixBarDurations(score, problems),
    );
    expect(barProblems(score)).toEqual([]);
    const beats = score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats;
    expect(beats.map((b) => [b.duration, b.isRest])).toEqual([
      [4, false],
      [4, false],
      [4, false],
      [4, true],
    ]);
    editor.undo();
    expect(barProblems(score)).toHaveLength(1);
  });

  it("trims a long bar: notes after the end go, a crossing note is shortened", () => {
    const score = fixed(
      String.raw`\track "G" \staff {score tabs} :4 3.6 5.6 :2 7.6 :4 9.6 | :1 3.6`,
    );
    const problems = barProblems(score);
    expect(problems).toHaveLength(1);
    fixBarDurations(score, problems);
    refinish(score);
    expect(barProblems(score)).toEqual([]);
    const beats = score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats;
    expect(beats.map((b) => b.notes[0]?.fret)).toEqual([3, 5, 7]);
    expect(voiceTicks(score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!)).toBe(3840);
  });

  it("changes nothing for problems that no longer exist", () => {
    const score = fixed(String.raw`\track "G" \staff {score tabs} :1 3.6`);
    expect(fixBarDurations(score, [{ bar: 9, track: 0, voice: 0, actual: 1, expected: 2 }])).toBe(
      0,
    );
  });
});
