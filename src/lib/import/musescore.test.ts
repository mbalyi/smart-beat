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

  it("lists what was left out", () => {
    const { warnings } = importMuseScoreXml(xml());
    expect(warnings.join(" ")).toMatch(/repeats, ties, tuplets/);
  });

  it("warns about extra voices, ties, grace notes and tuplets", () => {
    const doc = xml()
      .replace(
        "<Rest><durationType>quarter</durationType></Rest>",
        "<Chord><acciaccatura/><durationType>eighth</durationType><Note><pitch>60</pitch></Note></Chord><Tuplet/><Rest><durationType>quarter</durationType></Rest>",
      )
      .replace(
        "</voice>",
        "</voice><voice><Rest><durationType>quarter</durationType></Rest></voice>",
      );
    const { warnings } = importMuseScoreXml(doc);
    expect(warnings.join(" ")).toContain("first voice");
    expect(warnings.join(" ")).toContain("Grace notes");
    expect(warnings.join(" ")).toContain("Tuplets");
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
