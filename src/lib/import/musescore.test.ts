import { readFileSync } from "node:fs";
import path from "node:path";

import { importMuseScore, importMuseScoreXml } from "@/lib/import/musescore";
import { ScoreLoadError } from "@/lib/score/errors";
import type { Score } from "@/lib/score/model";
import { tempoAt } from "@/lib/score/structure";
import { makeZip } from "@/test/zip";

const FIXTURE = path.join(import.meta.dirname, "../../../e2e/fixtures/practice-song.mscx");
const xml = () => readFileSync(FIXTURE, "utf8");

/** Pitches (or "r") of each beat of each bar of a track. */
const pitches = (score: Score, track: number) =>
  score.tracks[track]!.staves[0]!.bars.map((bar) =>
    bar.voices[0]!.beats.map((beat) =>
      beat.notes.length === 0 ? "r" : beat.notes.map((n) => n.realValue).join("+"),
    ),
  );

describe("importMuseScoreXml", () => {
  it("reads the parts, notes, chords, rests and durations", () => {
    const { score } = importMuseScoreXml(xml());

    expect(score.title).toBe("MuseScore Practice");
    expect(score.artist).toBe("Smart Beat");
    expect(score.tracks.map((t) => t.name)).toEqual(["Guitar", "Piano"]);
    expect(score.masterBars).toHaveLength(2);
    expect(pitches(score, 0)).toEqual([
      ["40", "52+47", "r", "64", "67"],
      ["45", "r"],
    ]);
    expect(pitches(score, 1)).toEqual([["60+64+67"], ["r"]]);
    const guitar = score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats;
    expect(guitar.map((b) => b.duration)).toEqual([4, 4, 4, 8, 8]);
    const dotted = score.tracks[0]!.staves[0]!.bars[1]!.voices[0]!.beats[0]!;
    expect([dotted.duration, dotted.dots]).toEqual([2, 1]);
  });

  it("writes guitar parts as tablature in their tuning, and others as a score", () => {
    const { score } = importMuseScoreXml(xml());
    const guitar = score.tracks[0]!.staves[0]!;

    expect(Array.from(guitar.tuning)).toEqual([64, 59, 55, 50, 45, 40]);
    expect(guitar.showTablature).toBe(true);
    const frets = guitar.bars[0]!.voices[0]!.beats[1]!.notes.map((n) => `${n.string}:${n.fret}`);
    expect(frets.sort()).toEqual(["2:2", "3:2"]); // B2 and E3: second fret of the A and D strings
    expect(score.tracks[1]!.staves[0]!.tuning).toHaveLength(0);
  });

  it("takes over the key signature and the tempo (quarters per second × 60)", () => {
    const { score } = importMuseScoreXml(xml());
    expect(score.masterBars[0]!.keySignature).toBe(1);
    expect(tempoAt(score, 0)).toBe(90);
    expect(score.masterBars[0]!.timeSignatureNumerator).toBe(4);
  });

  it("warns about what is still left out (grace notes, voltas, a fifth voice, more verses)", () => {
    const fiveVoices = Array.from(
      { length: 5 },
      () => "<voice><Rest><durationType>measure</durationType></Rest></voice>",
    ).join("");
    const doc = xml()
      .replace(
        "<Rest><durationType>quarter</durationType></Rest>",
        '<Chord><acciaccatura/><durationType>eighth</durationType><Note><pitch>60</pitch></Note></Chord><Spanner type="Volta"/><Rest><durationType>quarter</durationType></Rest>',
      )
      .replace(
        "<Measure>\n        <voice>\n          <Chord><durationType>half</durationType>",
        `<Measure>${fiveVoices}<voice><Chord><durationType>half</durationType>`,
      );
    const { warnings } = importMuseScoreXml(doc);
    const all = warnings.join(" ");
    expect(all).toContain("Grace notes");
    expect(all).toContain("Volta");
  });

  it("takes over repeats (MuseScore 3 and 4 write them the same way)", () => {
    const doc = xml()
      .replace("<Measure>", "<Measure><startRepeat/>")
      .replace(
        "<Measure>\n        <voice>\n          <Chord><durationType>half</durationType>",
        "<Measure><endRepeat>3</endRepeat>\n        <voice>\n          <Chord><durationType>half</durationType>",
      );
    const { score } = importMuseScoreXml(doc);
    expect(score.masterBars[0]!.isRepeatStart).toBe(true);
    expect(score.masterBars[1]!.repeatCount).toBe(3);
  });

  it("takes over MuseScore 4 tuplets and MuseScore 3 tuplets", () => {
    const triplet = (chords: string) =>
      xml().replace(
        "<Chord><durationType>eighth</durationType><dots>0</dots><Note><pitch>64</pitch></Note></Chord>\n          <Chord><durationType>eighth</durationType><Note><pitch>67</pitch></Note></Chord>",
        chords,
      );
    const e = (pitch: number, extra = "") =>
      `<Chord>${extra}<durationType>eighth</durationType><Note><pitch>${pitch}</pitch></Note></Chord>`;
    const ms4 = triplet(
      `<Tuplet><normalNotes>2</normalNotes><actualNotes>3</actualNotes></Tuplet>${e(64)}${e(65)}${e(67)}<endTuplet/>`,
    );
    const ms3 = triplet(
      `<Tuplet id="1"><normalNotes>2</normalNotes><actualNotes>3</actualNotes></Tuplet>${e(64, "<Tuplet>1</Tuplet>")}${e(65, "<Tuplet>1</Tuplet>")}${e(67, "<Tuplet>1</Tuplet>")}`,
    );
    for (const doc of [ms4, ms3]) {
      const { score } = importMuseScoreXml(doc);
      const beats = score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats;
      expect(beats.map((b) => b.tupletNumerator)).toEqual([-1, -1, -1, 3, 3, 3]);
    }
  });

  it("takes over ties (MuseScore 3 <Tie>, MuseScore 4 spanners) and dynamics", () => {
    const tied = (start: string, end: string) =>
      xml()
        .replace(
          "<Chord><durationType>eighth</durationType><Note><pitch>67</pitch></Note></Chord>",
          `<Dynamic><subtype>mf</subtype></Dynamic><Chord><durationType>eighth</durationType><Note><pitch>67</pitch>${start}</Note></Chord>`,
        )
        .replace(
          "<Chord><durationType>half</durationType><dots>1</dots><Note><pitch>45</pitch></Note></Chord>",
          `<Chord><durationType>half</durationType><dots>1</dots><Note><pitch>67</pitch>${end}</Note></Chord>`,
        );
    const ms3 = tied('<Tie id="1"/>', '<endSpanner id="1"/>');
    const ms4 = tied(
      '<Spanner type="Tie"><Tie/><next><location><measures>1</measures></location></next></Spanner>',
      '<Spanner type="Tie"><prev><location><measures>-1</measures></location></prev></Spanner>',
    );
    for (const doc of [ms3, ms4]) {
      const { score } = importMuseScoreXml(doc);
      const bars = score.tracks[0]!.staves[0]!.bars;
      expect(bars[1]!.voices[0]!.beats[0]!.notes[0]!.isTieDestination).toBe(true);
      const last = bars[0]!.voices[0]!.beats.at(-1)!;
      expect(last.dynamics).toBe(4); // mf
    }
  });

  it("puts lyrics on their notes and takes over a second voice", () => {
    const syllable = (text: string, syllabic: string) =>
      `<Lyrics><syllabic>${syllabic}</syllabic><text>${text}</text></Lyrics>`;
    const doc = xml()
      .replace(
        "<Note><pitch>40</pitch></Note></Chord>",
        `<Note><pitch>40</pitch></Note>${syllable("Hel", "begin")}</Chord>`,
      )
      .replace(
        "<Note><pitch>64</pitch></Note></Chord>",
        `<Note><pitch>64</pitch></Note>${syllable("lo", "end")}</Chord>`,
      )
      .replace(
        "</voice>\n      </Measure>",
        "</voice><voice><Chord><durationType>whole</durationType><Note><pitch>48</pitch></Note></Chord></voice>\n      </Measure>",
      );
    const { score } = importMuseScoreXml(doc);
    const bar = score.tracks[0]!.staves[0]!.bars[0]!;
    expect(bar.voices[0]!.beats.map((b) => b.lyrics?.[0] ?? null)).toEqual([
      "Hel-",
      null,
      null,
      "lo",
      null,
    ]);
    expect(bar.voices).toHaveLength(2);
    expect(bar.voices[1]!.beats[0]!.notes[0]!.realValue).toBe(48);
    // Bar 2 has no second voice: it stays empty (no rest drawn).
    expect(score.tracks[0]!.staves[0]!.bars[1]!.voices[1]!.beats.every((b) => b.isEmpty)).toBe(
      true,
    );
  });

  it("writes a staff as a score when its notes don't fit the instrument's strings", () => {
    const doc = xml().replace("<pitch>40</pitch>", "<pitch>20</pitch>");
    const { score, warnings } = importMuseScoreXml(doc);
    expect(warnings.join(" ")).toContain("written as a score");
    expect(score.tracks[0]!.staves[0]!.showTablature).toBe(false);
  });

  it("refuses files that are not MuseScore scores", () => {
    expect(() => importMuseScoreXml("not xml <<<")).toThrow(ScoreLoadError);
    expect(() => importMuseScoreXml("<?xml version='1.0'?><other/>")).toThrow("not a MuseScore");
    expect(() => importMuseScoreXml("<museScore><Score></Score></museScore>")).toThrow("no parts");
    expect(() =>
      importMuseScoreXml(
        '<museScore><Score><Part><Staff id="1"/></Part><Staff id="1"></Staff></Score></museScore>',
      ),
    ).toThrow("no measures");
  });
});

describe("importMuseScore", () => {
  it("reads the score inside an .mscz archive, or a plain .mscx", async () => {
    const mscx = new TextEncoder().encode(xml());
    const mscz = makeZip([
      {
        name: "META-INF/container.xml",
        data: new TextEncoder().encode("<container/>"),
        deflate: false,
      },
      { name: "practice.mscx", data: mscx, deflate: true },
    ]);

    const fromZip = await importMuseScore(mscz);
    const plain = await importMuseScore(mscx);

    expect(fromZip.score.tracks.map((t) => t.name)).toEqual(["Guitar", "Piano"]);
    expect(pitches(plain.score, 0)).toEqual(pitches(fromZip.score, 0));
  });

  it("refuses an archive without a score", async () => {
    const zip = makeZip([{ name: "a.txt", data: new Uint8Array([1]), deflate: false }]);
    await expect(importMuseScore(zip)).rejects.toThrow("no MuseScore score");
  });
});
