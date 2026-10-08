/**
 * Extended-range guitars (7 to 10 strings), low tunings, odd time signatures
 * and nested tuplets (#43): the model, the editor, playback (alphaTab's MIDI)
 * and the exporters, end to end with real alphaTab objects.
 */
import { writeGp5 } from "@/lib/export/gp/writer";
import { writeGp7 } from "@/lib/export/gp7";
import { writeMusicXml } from "@/lib/export/musicxml";
import { barProblems, fixBarDurations } from "@/lib/score/bar-duration";
import { ScoreEditor } from "@/lib/score/editor";
import { refinish, type Score } from "@/lib/score/model";
import {
  barRests,
  composeTuplet,
  durationTicks,
  getPreset,
  lowestPitch,
  tuningPresets,
} from "@/lib/score/music";
import { parseScore } from "@/lib/score/score";
import { applyBarSettings, barSettingsOf } from "@/lib/score/structure";
import {
  createSong,
  createTrack,
  insertTrack,
  retuneKeepingPitches,
  trackFromPreset,
} from "@/lib/score/tracks";
import { generateMidi, noteOns, texScore } from "@/test/playback";

/** A new song with a 9-string guitar as its second track, and an editor on it. */
function nineStringSong() {
  const score = createSong();
  insertTrack(score, createTrack(score, trackFromPreset(getPreset("guitar-9")!)));
  return { score, editor: new ScoreEditor(score, 1) };
}

const tuningOf = (score: Score, track: number) => [
  ...score.tracks[track]!.staves[0]!.stringTuning.tunings,
];

/** Writes `score` as a Guitar Pro 7 file and reads it back. */
const throughGp7 = (score: Score) => parseScore(writeGp7(score)).score;

describe("a 9-string guitar", () => {
  it("has nine strings, every one tuned a fourth below the one above (after the B)", () => {
    const { score, editor } = nineStringSong();
    expect(editor.stringCount).toBe(9);
    expect(tuningOf(score, 1)).toEqual([64, 59, 55, 50, 45, 40, 35, 30, 25]);
    expect(lowestPitch(tuningOf(score, 1))).toBe(25);
  });

  it("sounds the right pitch on each string", () => {
    const { score, editor } = nineStringSong();
    // Open strings from the top one down, as a chord on the first beat.
    for (let string = 1; string <= 9; string++) {
      editor.typeDigit(0);
      if (string < 9) editor.moveString(-1);
    }
    const beat = score.tracks[1]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!;
    expect(beat.notes).toHaveLength(9);
    expect(beat.notes.map((n) => n.realValue).sort((a, b) => a - b)).toEqual([
      25, 30, 35, 40, 45, 50, 55, 59, 64,
    ]);
    // Every note is on its own string 1..9, and playback has the same keys.
    expect(beat.notes.map((n) => n.string).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const { file } = generateMidi(score);
    const keys = noteOns(file)
      .filter((on) => on.channel === score.tracks[1]!.playbackInfo.primaryChannel)
      .map((on) => on.noteKey)
      .sort((a, b) => a - b);
    expect(keys).toEqual([25, 30, 35, 40, 45, 50, 55, 59, 64]);
  });

  it("maps a fret on the lowest string to the right pitch, up to fret 24", () => {
    const { score, editor } = nineStringSong();
    for (let i = 0; i < 8; i++) editor.moveString(-1);
    expect(editor.cursor.string).toBe(1);
    editor.typeDigit(2);
    const note = score.tracks[1]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!;
    expect([note.string, note.fret, note.realValue]).toEqual([1, 2, 27]);
    // The editor takes frets up to 24 (and beyond, to 29, like Guitar Pro).
    expect(editor.describeCursor()).toContain("string 9");
  });

  it("keeps the pitches when the tuning changes between 6 and 9 strings", () => {
    const score = createSong();
    const staff = score.tracks[0]!.staves[0]!;
    const editor = new ScoreEditor(score, 0);
    editor.typeDigit(0); // open high E (64) on the top string
    for (let i = 0; i < 5; i++) editor.moveString(-1);
    editor.typeDigit(0); // open low E (40)
    const pitches = () =>
      staff.bars[0]!.voices[0]!.beats[0]!.notes.map((n) => n.realValue).sort((a, b) => a - b);
    expect(pitches()).toEqual([40, 64]);
    // To an 8-string F# standard: the low E (40) is fret 5 on the B string or fret 10 on the F#.
    const lost = retuneKeepingPitches(staff, tuningPresets(8)[0]!.tuning, 0);
    expect(lost).toBe(0);
    expect(pitches()).toEqual([40, 64]);
    expect(Math.max(...staff.bars[0]!.voices[0]!.beats[0]!.notes.map((n) => n.fret))).toBeLessThan(
      25,
    );
    // Back to six strings: both notes still fit.
    expect(retuneKeepingPitches(staff, [64, 59, 55, 50, 45, 40], 0)).toBe(0);
    expect(pitches()).toEqual([40, 64]);
  });

  it("drops the notes that no string of the new tuning can play", () => {
    const { score, editor } = nineStringSong();
    for (let i = 0; i < 8; i++) editor.moveString(-1);
    editor.typeDigit(0); // C#1 (25) on the lowest string
    const staff = score.tracks[1]!.staves[0]!;
    // Six strings bottom out at E2 (40): the note cannot be kept.
    expect(retuneKeepingPitches(staff, [64, 59, 55, 50, 45, 40], 0)).toBe(1);
    expect(staff.bars[0]!.voices[0]!.beats[0]!.notes).toHaveLength(0);
  });
});

describe("saving songs with extended-range guitars", () => {
  it("keeps nine strings and the tuning in a Guitar Pro 7 file", () => {
    const { score, editor } = nineStringSong();
    for (let i = 0; i < 8; i++) editor.moveString(-1);
    editor.typeDigit(5);
    const again = throughGp7(score);
    expect(tuningOf(again, 1)).toEqual([64, 59, 55, 50, 45, 40, 35, 30, 25]);
    const note = again.tracks[1]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!;
    expect([note.string, note.fret, note.realValue]).toEqual([1, 5, 30]);
  });

  it("writes the strings and the tuning into MusicXML", () => {
    const { score } = nineStringSong();
    const xml = writeMusicXml(score);
    expect(xml).toContain("<staff-lines>9</staff-lines>");
    // Nine <staff-tuning> entries for the 9-string track.
    expect(xml.match(/<staff-tuning line="9">/g)).toHaveLength(1);
    expect(xml.match(/<staff-tuning line="10">/g)).toBeNull();
  });

  it("saves seven strings in Guitar Pro 5 and says what was left out of an eight, nine or ten string track", () => {
    const { score, editor } = nineStringSong();
    for (let i = 0; i < 8; i++) editor.moveString(-1);
    editor.typeDigit(3); // a note on the 9th string
    const { bytes, warnings } = writeGp5(score);
    expect(warnings.join(" ")).toContain("has 9 strings");
    expect(warnings.join(" ")).toContain("at most 7");
    const again = parseScore(bytes).score;
    expect(tuningOf(again, 1)).toHaveLength(7);
    // The note on the string that does not exist in the file is not smuggled onto another one.
    expect(again.tracks[1]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes).toHaveLength(0);
  });
});

/** An odd-meter song: 7/8, 5/8, 11/16 and a plain 4/4 bar. */
const ODD_METERS = String.raw`
\title "Odd meters"
\tempo 120
\track "Guitar"
  \staff {score tabs}
  \instrument 29
  \ts 7 8 :8 3.5 3.5 3.5 3.5 3.5 3.5 3.5 |
  \ts 5 8 :8 3.5 3.5 3.5 3.5 3.5 |
  \ts 11 16 :16 3.5 3.5 3.5 3.5 3.5 3.5 3.5 3.5 3.5 3.5 3.5 |
  \ts 4 4 :4 3.5 3.5 3.5 3.5
`;

describe("odd time signatures", () => {
  it("fills 7/8, 5/8 and 11/16 bars with exactly the notes they ask for", () => {
    const score = texScore(ODD_METERS);
    expect(
      score.masterBars.map((m) => [m.timeSignatureNumerator, m.timeSignatureDenominator]),
    ).toEqual([
      [7, 8],
      [5, 8],
      [11, 16],
      [4, 4],
    ]);
    expect(score.masterBars.map((m) => m.calculateDuration())).toEqual([3360, 2400, 2640, 3840]);
    // None of them is an incomplete bar.
    expect(barProblems(score)).toEqual([]);
  });

  it("plays every bar for its own length", () => {
    const score = texScore(ODD_METERS);
    const { file, lookup } = generateMidi(score);
    const starts = lookup.masterBars.map((bar) => bar.start);
    expect(starts).toEqual([0, 3360, 3360 + 2400, 3360 + 2400 + 2640]);
    expect(lookup.masterBars.map((bar) => bar.end - bar.start)).toEqual([3360, 2400, 2640, 3840]);
    // The notes of the 7/8 bar are seven eighths apart by 480 ticks; the 11/16 bar's are 240 apart.
    const ticks = noteOns(file).map((on) => on.tick);
    expect(ticks.slice(0, 7)).toEqual([0, 480, 960, 1440, 1920, 2400, 2880]);
    expect(ticks.slice(7, 12)).toEqual([3360, 3840, 4320, 4800, 5280]);
    expect(ticks.slice(12, 23)).toEqual(Array.from({ length: 11 }, (_, i) => 5760 + i * 240));
    expect(ticks.slice(23)).toEqual([8400, 9360, 10320, 11280]);
  });

  it("flags a short or long bar against the odd signature, and fixes it", () => {
    const score = texScore(ODD_METERS);
    // 7/8 → 6/8: the bar of seven eighths is now one eighth too long.
    applyBarSettings(score, 0, {
      ...barSettingsOf(score, 0),
      timeSignature: { numerator: 6, denominator: 8 },
    });
    expect(barProblems(score).map((p) => [p.bar, p.actual, p.expected])).toContainEqual([
      0, 3360, 2880,
    ]);
    // 7/8 → 11/16 of rests only is fine: empty bars are rebuilt, written music never moved.
    expect(fixBarDurations(score, barProblems(score))).toBeGreaterThan(0);
    expect(barProblems(score)).toEqual([]);
  });

  it("changes a bar to 7/8 and writes it with the right number of rests", () => {
    const score = createSong();
    applyBarSettings(score, 1, {
      ...barSettingsOf(score, 1),
      timeSignature: { numerator: 7, denominator: 8 },
    });
    // The change carries on to the later bars; bar 1 is a seven-eighth rest bar.
    expect(score.masterBars.slice(1).map((m) => m.timeSignatureNumerator)).toEqual([7, 7, 7]);
    expect(score.masterBars[1]!.calculateDuration()).toBe(3360);
    expect(barProblems(score)).toEqual([]);
    const rests = score.tracks[0]!.staves[0]!.bars[1]!.voices[0]!.beats;
    expect(rests).toHaveLength(7);
    const { lookup } = generateMidi(score);
    expect(lookup.masterBars[1]!.end - lookup.masterBars[1]!.start).toBe(3360);
  });

  it("builds rests for odd bars: one per beat of the signature", () => {
    expect(barRests(7, 8)).toHaveLength(7);
    expect(barRests(5, 8)).toHaveLength(5);
    expect(barRests(11, 16)).toHaveLength(11);
    expect(barRests(11, 16).every((r) => r.duration === 16)).toBe(true);
    // 4/4 stays one whole rest, 3/4 a dotted half.
    expect(barRests(4, 4)).toHaveLength(1);
    expect(barRests(3, 4)).toEqual([{ duration: 2, dots: 1 }]);
  });
});

describe("nested tuplets", () => {
  /** Nine eighths and a half rest in 4/4, the nine eighths as one nested tuplet. */
  function nestedTriplets() {
    const score = texScore(String.raw`
\title "Nested"
\tempo 120
\track "Guitar"
  \staff {score tabs}
  \instrument 29
  :8 3.5 3.5 3.5 3.5 3.5 3.5 3.5 3.5 3.5 :2 r
`);
    const ratio = composeTuplet({ numerator: 3, denominator: 2 }, { numerator: 3, denominator: 2 });
    const beats = score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats;
    for (const beat of beats.slice(0, 9)) {
      beat.tupletNumerator = ratio.numerator;
      beat.tupletDenominator = ratio.denominator;
    }
    refinish(score);
    return { score, beats };
  }

  it("plays nine notes in the time of four, as one group of the bar", () => {
    const { score } = nestedTriplets();
    expect(durationTicks(8, 0, { numerator: 9, denominator: 4 })).toBeCloseTo(1920 / 9, 6);
    const { file } = generateMidi(score);
    const ticks = noteOns(file).map((on) => on.tick);
    expect(ticks).toHaveLength(9);
    // alphaTab rounds each note's length to whole ticks (213 for 213.33): a few ticks at most.
    ticks.forEach((tick, i) => expect(Math.abs(tick - (i * 1920) / 9)).toBeLessThanOrEqual(4));
    // The nine notes take the first half of the bar; the half rest the second.
    expect(barProblems(score)).toEqual([]);
  });

  it("gives the nine notes one tuplet group", () => {
    const { beats } = nestedTriplets();
    const groups = new Set(beats.slice(0, 9).map((b) => b.tupletGroup));
    expect(groups.size).toBe(1);
    expect(beats[0]!.tupletGroup).not.toBeNull();
    expect(beats[9]!.tupletGroup).toBeNull();
  });

  it("writes both numbers of the ratio to formats that carry them", () => {
    const { score } = nestedTriplets();
    const xml = writeMusicXml(score);
    expect(xml).toContain("<actual-notes>9</actual-notes><normal-notes>4</normal-notes>");
    const again = throughGp7(score);
    const first = again.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!;
    expect([first.tupletNumerator, first.tupletDenominator]).toEqual([9, 4]);
  });

  it("tells a Guitar Pro 5 file that a ratio it cannot hold is saved as plain notes", () => {
    const { score } = nestedTriplets();
    const { warnings } = writeGp5(score);
    expect(warnings.join(" ")).toContain("The 9:4 tuplet is not in Guitar Pro 5");
    expect(warnings.join(" ")).toContain("9 notes in the time of 8");
  });
});
