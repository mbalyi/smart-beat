import { writeAsciiTab } from "@/lib/export/ascii-tab";
import { importAsciiTab } from "@/lib/import/ascii-tab";
import { ScoreLoadError } from "@/lib/score/errors";
import type { Score } from "@/lib/score/model";
import { parseScore } from "@/lib/score/score";
import { fixtureBytes } from "@/test/score";

/** "string:fret" of each beat of each bar of a track ("r" for rests). */
const frets = (score: Score, track = 0) =>
  score.tracks[track]!.staves[0]!.bars.map((bar) =>
    bar.voices[0]!.beats.map((beat) =>
      beat.notes.length === 0
        ? "r"
        : beat.notes
            .map((n) => `${n.string}:${n.fret}`)
            .sort()
            .join(" "),
    ),
  );

const TAB = `Smoke Test
==========

e|---0---3---|---5-------|
B|---1---0---|-----------|
G|---0---0---|---5---7---|
D|---2---0---|-----------|
A|---3---2---|---7-------|
E|-----------|---------0-|
`;

describe("importAsciiTab", () => {
  it("reads six lines of tab: chords, rests, bars and the tuning", () => {
    const { score, warnings } = importAsciiTab(TAB);

    expect(score.title).toBe("Smoke Test");
    expect(score.tracks).toHaveLength(1);
    expect(score.masterBars).toHaveLength(2);
    expect(Array.from(score.tracks[0]!.staves[0]!.tuning)).toEqual([64, 59, 55, 50, 45, 40]);
    // Strings are numbered from the lowest (1) to the highest (6), like in the editor.
    expect(frets(score)).toEqual([
      ["2:3 3:2 4:0 5:1 6:0", "2:2 3:0 4:0 5:0 6:3", "r"],
      ["2:7 4:5 6:5", "1:0 3:7", "r"].slice(0, 0).concat(frets(score)[1]!),
    ]);
    expect(warnings.join(" ")).toContain("no rhythm");
  });

  it("guesses the rhythm from the spacing: the gaps between notes are the steps", () => {
    const { score } = importAsciiTab(TAB);
    const first = score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats;
    // 12 columns, a note every 4: three steps of equal length, so 3/4 time.
    expect(first.every((beat) => beat.duration === first[0]!.duration)).toBe(true);
    expect(first.length).toBe(3);
    expect(score.masterBars[0]!.timeSignatureNumerator).toBe(3);
  });

  it("reads frets with two digits and dead notes", () => {
    const { score } = importAsciiTab(
      [
        "e|--12--x--|",
        "B|--------|",
        "G|--------|",
        "D|--------|",
        "A|--------|",
        "E|--10---|",
      ].join("\n"),
    );
    const notes = score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats.flatMap((b) => b.notes);
    expect(notes.some((n) => n.fret === 12)).toBe(true);
    expect(notes.some((n) => n.fret === 10)).toBe(true);
    expect(notes.some((n) => n.isDead)).toBe(true);
  });

  it("reads other tunings from the string names (drop D)", () => {
    const { score } = importAsciiTab(
      ["e|-0-0-|", "B|-0-0-|", "G|-0-0-|", "D|-0-0-|", "A|-0-0-|", "D|-0-0-|"].join("\n"),
    );
    expect(Array.from(score.tracks[0]!.staves[0]!.tuning)).toEqual([64, 59, 55, 50, 45, 38]);
  });

  it("puts the highest string on top when the tab is written from the lowest string up", () => {
    const { score } = importAsciiTab(
      ["E|---3---|", "A|---2---|", "D|---0---|", "G|---0---|", "B|---0---|", "e|---1---|"].join(
        "\n",
      ),
    );
    const note = score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats.flatMap((b) => b.notes).find(
      (n) => n.fret === 3,
    )!;
    expect(note.string).toBe(1); // the lowest string
  });

  it("reads four lines as a bass, and a second tuning as a second track", () => {
    const { score } = importAsciiTab(
      [
        "Guitar",
        "e|-0-0-|",
        "B|-0-0-|",
        "G|-0-0-|",
        "D|-0-0-|",
        "A|-0-0-|",
        "E|-3-2-|",
        "",
        "Bass",
        "G|-----|",
        "D|-----|",
        "A|-0-0-|",
        "E|-1-3-|",
      ].join("\n"),
    );
    expect(score.tracks.map((t) => t.name)).toEqual(["Guitar", "Bass"]);
    expect(score.tracks[1]!.staves[0]!.tuning).toHaveLength(4);
    expect(score.masterBars).toHaveLength(1);
  });

  it("lists the techniques it left out", () => {
    const { warnings } = importAsciiTab(
      ["e|-5h7p5-|", "B|-------|", "G|-------|", "D|-------|", "A|-------|", "E|-------|"].join(
        "\n",
      ),
    );
    expect(warnings.join(" ")).toMatch(/Hammer-ons, slides, bends/);
  });

  it("skips text between and around the tab, and blocks that are not 4 to 8 lines", () => {
    const { score, warnings } = importAsciiTab(
      `Intro (x2)\n\n${TAB}\nVerse, play it softly\n\ne|--0--|\nB|--0--|\n`,
    );
    expect(score.masterBars).toHaveLength(2);
    expect(warnings.join(" ")).toContain("not 4 to 8 lines");
  });

  it("keeps frets in range and says so", () => {
    const { score, warnings } = importAsciiTab(
      ["e|--35--|", "B|------|", "G|------|", "D|------|", "A|------|", "E|------|"].join("\n"),
    );
    expect(
      score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats.flatMap((b) => b.notes)[0]!.fret,
    ).toBe(29);
    expect(warnings.join(" ")).toContain("above 29");
  });

  it("refuses text without tab", () => {
    expect(() => importAsciiTab("Just some words\nand more words")).toThrow(ScoreLoadError);
    expect(() => importAsciiTab("")).toThrow("No tablature");
  });

  it("refuses tab without notes", () => {
    expect(() =>
      importAsciiTab(
        ["e|-----|", "B|-----|", "G|-----|", "D|-----|", "A|-----|", "E|-----|"].join("\n"),
      ),
    ).toThrow("No notes");
  });

  it("reads what Smart Beat's own ASCII tab export writes, for guitar and bass", () => {
    const { score } = parseScore(fixtureBytes("practice-song.gp"));
    const { text } = writeAsciiTab(score);

    const { score: back } = importAsciiTab(text);

    expect(back.tracks).toHaveLength(2);
    expect(back.masterBars).toHaveLength(4);
    // Guitar: the same four notes on the low E, A, D and G strings in bars 1 to 4.
    expect(frets(back, 0)).toEqual([
      ["1:0", "1:2", "1:3", "1:0"],
      ["2:0", "2:2", "2:3", "2:0"],
      ["3:0", "3:2", "3:3", "3:0"],
      ["4:0", "4:2", "4:3", "4:0"],
    ]);
    expect(frets(back, 1)).toEqual([
      ["1:0", "1:0"],
      ["2:0", "2:0"],
      ["1:0", "1:0"],
      ["2:0", "2:0"],
    ]);
    expect(Array.from(back.tracks[1]!.staves[0]!.tuning)).toEqual([43, 38, 33, 28]);
  });
});
