import { describe, expect, it } from "vitest";

import { exportScore } from "@/lib/export";
import { importMuseScore, importMuseScoreXml } from "@/lib/import/musescore";
import { listZip, readZipEntry } from "@/lib/import/zip";
import { writeMuseScoreXml } from "@/lib/export/musescore";
import { soundOf, type Score } from "@/lib/score/model";
import { parseScore } from "@/lib/score/score";
import { tempoAt } from "@/lib/score/structure";
import { texScore } from "@/test/playback";
import { fixtureBytes } from "@/test/score";

/** What a reader of the music sees: per track, bar and voice, the length and the sounding pitches of each beat. */
const music = (score: Score, voices = 1) =>
  score.tracks.map((track) =>
    track.staves[0]!.bars.map((bar) =>
      bar.voices.slice(0, voices).map((voice) =>
        voice.beats
          .filter((beat) => beat.graceType === 0)
          .map((beat) => ({
            duration: beat.duration,
            dots: beat.dots,
            tuplet:
              beat.tupletNumerator > 1 ? `${beat.tupletNumerator}:${beat.tupletDenominator}` : "",
            tie: beat.notes.some((note) => note.isTieDestination),
            notes: beat.notes.map(soundOf).sort((a, b) => a - b),
          })),
      ),
    ),
  );

const structure = (score: Score) =>
  score.masterBars.map((bar, index) => ({
    time: `${bar.timeSignatureNumerator}/${bar.timeSignatureDenominator}`,
    key: bar.keySignature,
    tempo: tempoAt(score, index),
    repeatStart: bar.isRepeatStart,
    repeatCount: bar.repeatCount,
  }));

/** Writes the score as MuseScore XML and reads it back with Smart Beat's own importer. */
function roundTrip(score: Score) {
  const written = writeMuseScoreXml(score);
  const { score: again, warnings } = importMuseScoreXml(written.xml);
  return { written, again, importWarnings: warnings };
}

const SONG = String.raw`
\title "Round & Trip <1>"
\artist "Some One"
\tempo 100
\track "Guitar"
  \staff {score tabs}
  \instrument 25
  \ts 3 4
  \ks D
  \ro :4 3.6 5.6 7.6 | :8 {tu 3} 5.5 5.5 5.5 :4 3.6 5.5 {d} 3.6{t}  | 3.6 :8 5.5 5.5 :4 r \rc 3
  \tempo 140
  :2 (3.6 5.5 5.4) :4 r |
\track "Bass"
  \staff {score tabs}
  \tuning (g2 d2 a1 e1)
  \instrument 33
  :4 0.4 0.4 0.4 | :1 0.4 | 0.3 0.3 0.3 | r :2 0.4 |
`;

describe("MuseScore export", () => {
  it("writes the practice song so that our importer reads the same music back", () => {
    const { score } = parseScore(fixtureBytes("practice-song.gp"));
    const { again } = roundTrip(score);
    expect(music(again)).toEqual(music(score));
    expect(structure(again)).toEqual(structure(score));
    expect(again.tracks.map((t) => t.name)).toEqual(score.tracks.map((t) => t.name));
  });

  it("keeps meter and key changes, tempo changes, repeats with their counts, dots, tuplets and ties", () => {
    const score = texScore(SONG);
    const { again, written } = roundTrip(score);
    expect(structure(again)).toEqual(structure(score));
    expect(structure(score).some((bar) => bar.repeatCount === 3)).toBe(true);
    expect(music(again)).toEqual(music(score));
    expect(music(score)[0]![1]![0]!.some((beat) => beat.tuplet === "3:2")).toBe(true);
    expect(music(score)[0]![1]![0]!.some((beat) => beat.tie)).toBe(true);
    expect(written.warnings).toEqual([
      "Tablature is saved as standard notation (the strings stay in the instrument): add a tablature staff in MuseScore.",
    ]);
  });

  it("writes a tie as two spanners that name the other end, in note lengths", () => {
    const score = texScore(
      String.raw`\track "G" \staff {score tabs} \instrument 25 :4 3.6 3.6{t} :8 5.6 5.6{t} 7.6 5.6 |`,
    );
    const doc = new DOMParser().parseFromString(writeMuseScoreXml(score).xml, "application/xml");
    const ties = Array.from(doc.querySelectorAll('Spanner[type="Tie"]')).map((spanner) => ({
      end: spanner.querySelector("next") ? "next" : "prev",
      fraction: spanner.querySelector("fractions")!.textContent,
    }));
    expect(ties).toEqual([
      { end: "next", fraction: "1/4" }, // the quarter note is tied forward by its own length
      { end: "prev", fraction: "-1/4" },
      { end: "next", fraction: "1/8" },
      { end: "prev", fraction: "-1/8" },
    ]);
    expect(music(roundTrip(score).again)).toEqual(music(score));
    expect(music(score)[0]![0]![0]!.filter((beat) => beat.tie)).toHaveLength(2);
  });

  it("writes the tempo in quarter notes per second", () => {
    const score = texScore(String.raw`\tempo 90 \track "G" \staff {score} :4 c4 c4 c4 c4 |`);
    expect(writeMuseScoreXml(score).xml).toContain("<tempo>1.5</tempo>");
  });

  it("keeps the strings of a guitar, lowest first, and marks drums for the drum set", () => {
    const { score } = parseScore(fixtureBytes("practice-song.gp"));
    const doc = new DOMParser().parseFromString(writeMuseScoreXml(score).xml, "application/xml");
    const parts = Array.from(doc.querySelectorAll("Score > Part"));
    expect(parts.map((p) => p.querySelector(":scope > trackName")!.textContent)).toEqual(
      score.tracks.map((t) => t.name),
    );
    const guitar = Array.from(parts[0]!.querySelectorAll("StringData > string")).map((s) =>
      Number(s.textContent),
    );
    expect(guitar).toEqual([...score.tracks[0]!.staves[0]!.stringTuning.tunings].reverse());
    expect(guitar[0]!).toBeLessThan(guitar.at(-1)!);
    expect(parts[2]!.querySelector("useDrumset")?.textContent).toBe("1");
    expect(parts[0]!.querySelector("useDrumset")).toBeNull();
    expect(Number(parts[0]!.querySelector("program")!.getAttribute("value"))).toBe(
      score.tracks[0]!.playbackInfo.program,
    );
  });

  it("writes lyrics with their syllables, and dynamics only where they change", () => {
    const score = texScore(String.raw`
      \track "V" \staff {score} \lyrics "Hel-lo world" 
      :4 c4{dy mf} d4 e4 f4{dy mf} | :4 g4{dy f} a4 b4 c5 |`);
    const { xml } = writeMuseScoreXml(score);
    expect(xml).toContain("<syllabic>begin</syllabic>");
    expect(xml).toContain("<syllabic>end</syllabic>");
    expect(xml.match(/<subtype>mf<\/subtype>/g)).toHaveLength(1); // not again for the next mf
    expect(xml.match(/<subtype>f<\/subtype>/g)).toHaveLength(1);
    const { again } = roundTrip(score);
    const syllables = again.tracks[0]!.staves[0]!.bars.flatMap((bar) =>
      bar.voices[0]!.beats.map((beat) => beat.lyrics?.[0] ?? ""),
    );
    expect(syllables.slice(0, 3)).toEqual(["Hel-", "lo", "world"]);
  });

  it("writes second and further voices", () => {
    const score = texScore(String.raw`
      \track "G" \staff {score}
      \voice :4 c5 d5 e5 f5 | :4 c5 d5 e5 f5 |
      \voice :2 c4 e4 | :1 g3 |`);
    const { again } = roundTrip(score);
    expect(music(again, 2)).toEqual(music(score, 2));
    expect(again.tracks[0]!.staves[0]!.bars[0]!.voices).toHaveLength(2);
  });

  it("writes a bar's rest, and a rest for a whole bar as a measure rest", () => {
    const score = texScore(String.raw`\track "G" \staff {score} :1 r | :4 c4 r r r |`);
    const { xml } = writeMuseScoreXml(score);
    expect(xml).toContain("<durationType>measure</durationType>");
    expect(xml).toContain("<duration>4/4</duration>");
    expect(music(roundTrip(score).again)[0]![1]![0]!.map((b) => b.notes.length)).toEqual([
      1, 0, 0, 0,
    ]);
  });

  it("is well-formed XML with every special character escaped", () => {
    const score = texScore(SONG);
    score.tracks[0]!.name = 'Gu"i<t>ar & ő';
    score.copyright = "© A&B";
    const { xml } = writeMuseScoreXml(score);
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelector("metaTag[name=workTitle]")!.textContent).toBe("Round & Trip <1>");
    expect(doc.querySelector("metaTag[name=copyright]")!.textContent).toBe("© A&B");
    expect(doc.querySelector("Part > trackName")!.textContent).toBe('Gu"i<t>ar & ő');
    expect(doc.documentElement.getAttribute("version")).toBe("3.02");
  });

  it("drops characters XML cannot hold instead of writing a broken file", () => {
    const score = texScore(SONG);
    score.title = "Ti\u0001tle";
    const doc = new DOMParser().parseFromString(writeMuseScoreXml(score).xml, "application/xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelector("metaTag[name=workTitle]")!.textContent).toBe("Title");
  });

  it("writes a ZIP with a container for .mscz that opens like the .mscx", async () => {
    const score = texScore(SONG);
    const { bytes, warnings } = exportScore(score, "mscz");
    const entries = listZip(bytes);
    expect(entries.map((e) => e.name)).toEqual(["META-INF/container.xml", "score.mscx"]);
    const container = new TextDecoder().decode(await readZipEntry(bytes, entries[0]!));
    expect(container).toContain('full-path="score.mscx"');
    const plain = exportScore(score, "mscx");
    expect(new TextDecoder().decode(plain.bytes)).toBe(
      new TextDecoder().decode(await readZipEntry(bytes, entries[1]!)),
    );
    expect(warnings).toEqual(plain.warnings);
    const { score: again } = await importMuseScore(bytes);
    expect(music(again)).toEqual(music(score));
  });

  describe("what MuseScore files here do not carry", () => {
    it("lists the guitar techniques that are left out", () => {
      const score = texScore(String.raw`
        \track "G" \staff {score tabs} \instrument 25
        :4 3.6{v} 5.5{pm} 7.4{lr} 5.3{g} | :4 5.6{ac} 7.6{st} 0.6{h} 2.5{sl} 7.5 | :4 3.6{b (0 4)} 12.2{nh} 3.6 5.6 |`);
      const { warnings } = writeMuseScoreXml(score);
      const lost = warnings.find((w) => w.startsWith("These are left out:"))!;
      for (const what of [
        "vibrato",
        "palm mute",
        "let ring",
        "ghost notes",
        "accents",
        "staccato",
        "hammer-ons and pull-offs",
        "slides",
        "bends",
        "harmonics",
      ]) {
        expect(lost, what).toContain(what);
      }
    });

    it("lists grace notes, endings, jumps, text, chord diagrams and section names", () => {
      const { score } = parseScore(fixtureBytes("structure-song.gp"));
      const { warnings } = writeMuseScoreXml(score);
      expect(warnings).toContain("Volta endings (1st and 2nd time bars) are left out.");
      expect(warnings).toContain("Jumps (Coda, Segno, D.C., D.S.) are left out.");
      expect(warnings).toContain("Text, chord diagrams and section names are left out.");
      const grace = texScore(String.raw`\track "G" \staff {score} :4 c4{gr} d4 e4 f4 |`);
      expect(writeMuseScoreXml(grace).warnings).toContain("Grace notes are left out.");
    });

    it("warns about nothing for plain music", () => {
      const score = texScore(String.raw`\tempo 100 \track "P" \staff {score} :4 c4 d4 e4 f4 |`);
      expect(writeMuseScoreXml(score).warnings).toEqual([]);
    });

    it("saves only the first four voices", () => {
      const score = texScore(
        [1, 2, 3, 4, 5]
          .map((v) => String.raw`\voice :1 ${["c4", "d4", "e4", "f4", "g4"][v - 1]} |`)
          .join("\n")
          .replace(/^/, String.raw`\track "G" \staff {score}` + "\n"),
      );
      expect(writeMuseScoreXml(score).warnings).toContain(
        "Only the first 4 voices of each staff are saved.",
      );
    });
  });
});
