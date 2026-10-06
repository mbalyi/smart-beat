import { importer, model, Settings } from "@coderline/alphatab";
import { describe, expect, it } from "vitest";

import { writeGp3, writeGp4, writeGp5 } from "@/lib/export/gp/writer";
import { lyricsOf } from "@/lib/score/lyrics";
import { tempoAt } from "@/lib/score/structure";
import { applyTempo } from "@/lib/score/tempo";
import { parseScore } from "@/lib/score/score";
import { fixtureBytes } from "@/test/score";
import { shotOf } from "@/test/score-snapshot";

/** Saves as GP5 and reads the file back. */
function roundTrip(bytes: Uint8Array) {
  const { score } = parseScore(bytes);
  const written = writeGp5(score);
  return { score, again: parseScore(written.bytes).score, written };
}

function fromTex(tex: string) {
  const score = importer.ScoreLoader.loadAlphaTex(tex, new Settings());
  return parseScoreBytes(score);
}

import { exporter } from "@coderline/alphatab";
function parseScoreBytes(score: ReturnType<typeof importer.ScoreLoader.loadAlphaTex>) {
  return new exporter.Gp7Exporter().export(score, new Settings());
}

describe("Guitar Pro 5 writer", () => {
  it("writes the practice song so alphaTab reads it back the same", () => {
    const { score, again } = roundTrip(fixtureBytes("practice-song.gp"));
    // The piano has no strings in GP5: its notes are compared by pitch.
    expect(shotOf(again, { pitchOnly: [3] })).toEqual(shotOf(score, { pitchOnly: [3] }));
  });

  it("keeps structure, repeats, endings, jumps, chords and lyrics (structure song)", () => {
    const { score, again } = roundTrip(fixtureBytes("structure-song.gp"));
    expect(shotOf(again)).toEqual(shotOf(score));
    const written = (track: (typeof score.tracks)[number]) =>
      lyricsOf(track).filter((line) => line.text.trim() !== "");
    expect(written(again.tracks[0]!)).toEqual(written(score.tracks[0]!));
    expect(again.masterBars.map((m) => [...(m.directions ?? [])])).toEqual(
      score.masterBars.map((m) => [...(m.directions ?? [])]),
    );
    expect(again.tracks[0]!.staves[0]!.chords?.size).toBe(score.tracks[0]!.staves[0]!.chords?.size);
  });

  it("keeps note techniques, dynamics and tuplets", () => {
    const bytes = fromTex(String.raw`
\title "Techniques"
\tempo 90
\track "Guitar"
  \staff {score tabs}
  \instrument 25
  :4 3.6{v} 5.5{pm} 7.4{lr} 5.3{g} |
  :4 5.6{ac} 7.6{st} 0.6{h} 2.5{sl} 7.5 |
  :8 {tu 3} 5.6 5.6 5.6 :4 3.6{b (0 4)} 12.2{nh} 3.6 |
  :4 5.6{dy mf} :8 5.3{dy pp} 5.3{dy fff} 5.3 :4 5.6 |
`);
    const { score, again } = roundTrip(bytes);
    expect(shotOf(again)).toEqual(shotOf(score));
  });

  it("saves tempo changes made with the tempo tool (song tempo, a bar, some bars) and reads them back", () => {
    const { score } = parseScore(fixtureBytes("practice-song.gp")); // 60, 60, 120, 120
    applyTempo(score, { scope: "song", bpm: 72 });
    applyTempo(score, { scope: "range", from: 1, to: 1, bpm: 90 }); // bar 3 has its own 120

    const again = parseScore(writeGp5(score).bytes).score;

    expect(again.masterBars.map((_, i) => tempoAt(again, i))).toEqual([72, 90, 120, 120]);
  });
});

describe("tempo names", () => {
  const contains = (bytes: Uint8Array, text: string) =>
    new TextDecoder("latin1").decode(bytes).includes(text);

  it("writes the names of the song tempo and of tempo changes", () => {
    const { score } = parseScore(fixtureBytes("practice-song.gp"));
    applyTempo(score, { scope: "song", bpm: 100 });
    score.masterBars[0]!.tempoAutomations[0]!.text = "Moderato";
    applyTempo(score, { scope: "from", bar: 2, beat: 0, bpm: 140 });
    score.masterBars[2]!.tempoAutomations[0]!.text = "Breakdown";
    const { bytes } = writeGp5(score);
    expect(contains(bytes, "Moderato")).toBe(true);
    expect(contains(bytes, "Breakdown")).toBe(true);
    // Still a file alphaTab reads, with the same tempos.
    const back = importer.ScoreLoader.loadScoreFromBytes(bytes, new Settings());
    expect(tempoAt(back, 0)).toBe(100);
    expect(tempoAt(back, 2)).toBe(140);
  });
});

const { TripletFeel } = model;

const TECHNIQUES = String.raw`
\title "Techniques"
\tempo 90
\track "Guitar"
  \staff {score tabs}
  \instrument 25
  :4 3.6{v} 5.5{pm} 7.4{lr} 5.3{g} |
  :4 5.6{ac} 7.6{st} 0.6{h} 2.5{sl} 7.5 |
  :8 {tu 3} 5.6 5.6 5.6 :4 3.6{b (0 4)} 12.2{nh} 3.6 |
  :4 5.6{dy mf} :8 5.3{dy pp} 5.3{dy fff} 5.3 :4 5.6 |
`;

/** A tex song saved as a Guitar Pro 7 file and opened again, like a song opened from disk. */
const openedTex = (tex: string) => parseScore(fromTex(tex)).score;

describe.each([
  { product: "Guitar Pro 4", write: writeGp4, header: "FICHIER GUITAR PRO v4.06", version: 4 },
  { product: "Guitar Pro 3", write: writeGp3, header: "FICHIER GUITAR PRO v3.00", version: 3 },
])("$product writer", ({ product, write, header, version }) => {
  const roundTrip = (score: ReturnType<typeof parseScore>["score"]) => {
    const written = write(score);
    return { written, again: parseScore(written.bytes).score };
  };

  it("starts with the version text Guitar Pro and the file type check look for", () => {
    const { score } = parseScore(fixtureBytes("practice-song.gp"));
    const { bytes } = write(score);
    expect(bytes[0]).toBe(header.length);
    expect(new TextDecoder().decode(bytes.slice(1, 1 + header.length))).toBe(header);
  });

  it("writes the practice song so alphaTab reads it back the same", () => {
    const { score } = parseScore(fixtureBytes("practice-song.gp"));
    const { written, again } = roundTrip(score);
    // The piano has no strings: its notes are compared by pitch.
    expect(shotOf(again, { pitchOnly: [3] })).toEqual(shotOf(score, { pitchOnly: [3] }));
    expect(written.warnings).toContainEqual(
      expect.stringContaining(`${product} has no keyboard staff`),
    );
    // Drums, the mix and the tempo come through.
    expect(again.tracks.map((t) => t.playbackInfo.volume)).toEqual(
      score.tracks.map((t) => t.playbackInfo.volume),
    );
    expect(again.masterBars.map((_, i) => tempoAt(again, i))).toEqual(
      score.masterBars.map((_, i) => tempoAt(score, i)),
    );
  });

  it("keeps the structure: repeats with their counts, endings, sections and chords", () => {
    const { score } = parseScore(fixtureBytes("structure-song.gp"));
    const { written, again } = roundTrip(score);
    const shot = (s: typeof score) => shotOf(s).bars;
    expect(shot(again)).toEqual(shot(score));
    expect(score.masterBars.some((m) => m.repeatCount > 1)).toBe(true); // the counts are really tested
    expect(score.masterBars.some((m) => m.alternateEndings !== 0)).toBe(true);
    expect(again.tracks[0]!.staves[0]!.chords?.size).toBe(score.tracks[0]!.staves[0]!.chords?.size);
    // Jumps (Coda, Segno…) are Guitar Pro 5 only.
    expect(written.warnings).toContainEqual(expect.stringContaining("has no jumps"));
    expect(again.masterBars.every((m) => (m.directions?.size ?? 0) === 0)).toBe(true);
  });

  it("saves tempo changes and reads them back", () => {
    const { score } = parseScore(fixtureBytes("practice-song.gp")); // 60, 60, 120, 120
    applyTempo(score, { scope: "song", bpm: 72 });
    applyTempo(score, { scope: "range", from: 1, to: 1, bpm: 90 });
    const { again } = roundTrip(score);
    expect(again.masterBars.map((_, i) => tempoAt(again, i))).toEqual([72, 90, 120, 120]);
  });

  it("tells that tempo names are not saved", () => {
    const { score } = parseScore(fixtureBytes("practice-song.gp"));
    score.masterBars[0]!.tempoAutomations[0]!.text = "Moderato";
    expect(write(score).warnings).toContain(`${product} has no tempo names: they are left out.`);
  });

  it("saves the notes of the first voice and tells that the other voices are left out", () => {
    const score = openedTex(String.raw`
      \track "G" \staff {score tabs} \instrument 25
      \voice :4 3.6 5.6 7.6 5.6 |
      \voice :4 0.1 0.1 0.1 0.1 |`);
    const { written, again } = roundTrip(score);
    expect(again.tracks[0]!.staves[0]!.bars[0]!.voices).toHaveLength(1);
    expect(shotOf(again).tracks[0]!.bars[0]!.voices[0]!.map((b) => b.notes[0]!.at)).toEqual([
      "1/3",
      "1/5",
      "1/7",
      "1/5",
    ]);
    expect(written.warnings).toContain(
      `${product} has one voice per bar: the notes of the other voices are left out.`,
    );
  });

  it("saves one triplet feel for the whole song, and says when the bars differ", () => {
    const score = openedTex(
      String.raw`\track "G" \staff {score tabs} \instrument 25 :4 3.6 5.6 7.6 5.6 | :4 3.6 5.6 7.6 5.6 |`,
    );
    for (const bar of score.masterBars) bar.tripletFeel = TripletFeel.Triplet8th;
    const same = roundTrip(score);
    expect(same.again.masterBars.map((m) => m.tripletFeel)).toEqual([
      TripletFeel.Triplet8th,
      TripletFeel.Triplet8th,
    ]);
    expect(same.written.warnings).toEqual([]);

    score.masterBars[1]!.tripletFeel = TripletFeel.NoTripletFeel;
    expect(write(score).warnings).toContainEqual(
      expect.stringContaining(`${product} has one triplet feel for the whole song`),
    );
  });

  it("writes alternate endings as numbers and says when they cannot be", () => {
    const score = openedTex(String.raw`
      \track "G" \staff {score tabs} \instrument 25
      \ro :4 3.6 5.6 7.6 5.6 |
      \ae 1 :4 3.6 5.6 7.6 5.6 \rc 2 |
      \ae 2 :4 3.6 5.6 7.6 5.6 \rc 2 |
      :4 1.1 1.1 1.1 1.1 |`);
    expect(roundTrip(score).again.masterBars.map((m) => m.alternateEndings)).toEqual(
      score.masterBars.map((m) => m.alternateEndings),
    );

    // Endings 1 and 3 of one bar skip the number 2: a number can't say that.
    score.masterBars[1]!.alternateEndings = 0b101;
    const { written, again } = roundTrip(score);
    expect(written.warnings).toContainEqual(
      expect.stringContaining(`alternate endings cannot be written in ${product}`),
    );
    expect(again.masterBars[1]!.alternateEndings).toBe(0);
  });

  it("keeps the credits in the one field it has for words and music", () => {
    const { score } = parseScore(fixtureBytes("practice-song.gp"));
    score.words = "A. Writer";
    score.music = "A. Writer";
    expect(parseScore(write(score).bytes).score.words).toBe("A. Writer");
    expect(write(score).warnings.join(" ")).not.toMatch(/credit/);
    score.music = "C. Composer";
    expect(write(score).warnings).toContainEqual(expect.stringContaining("music credit"));
  });

  it("saves a grace note on the beat before it, and says so", () => {
    const score = openedTex(
      String.raw`\track "G" \staff {score tabs} \instrument 25 :4 3.6{gr ob} 5.6 7.6 5.6 |`,
    );
    const { written, again } = roundTrip(score);
    expect(written.warnings).toContain(
      `${product} plays grace notes before the beat, never on it.`,
    );
    const beats = again.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats;
    expect(beats.some((beat) => beat.graceType !== 0)).toBe(true);
  });

  it("saves the techniques the generation has and lists the ones it has not", () => {
    const score = openedTex(TECHNIQUES);
    const { written, again } = roundTrip(score);
    const shot = (s: typeof score) => shotOf(s).tracks[0]!.bars;
    if (version === 4) {
      expect(shot(again)).toEqual(shot(score));
      expect(written.warnings).toEqual([]);
      return;
    }
    // Guitar Pro 3 has no vibrato on a note, palm mute or staccato; legato slides become shift slides.
    expect(written.warnings).toEqual(
      expect.arrayContaining([
        `${product} has no vibrato on a note: it is left out.`,
        `${product} has no palm mute: it is left out.`,
        `${product} has no staccato: it is left out.`,
        `${product} saves legato slides as shift slides.`,
      ]),
    );
    const notes = (s: typeof score) =>
      shot(s).flatMap((bar) => bar.voices.flatMap((v) => v.flatMap((b) => b.notes)));
    const strip = (note: ReturnType<typeof notes>[number]) => {
      const { vibrato, palmMute, staccato, slideOut, ...rest } = note;
      void vibrato;
      void palmMute;
      void staccato;
      void slideOut;
      return rest;
    };
    expect(notes(again).map(strip)).toEqual(notes(score).map(strip));
    expect(notes(again).some((n) => n.hammer && n.letRing === undefined)).toBe(true);
  });

  it("saves a natural harmonic on the beat in Guitar Pro 3 and on the note in Guitar Pro 4", () => {
    const score = openedTex(
      String.raw`\track "G" \staff {score tabs} \instrument 25 :4 12.2{nh} 7.4{nh} 3.6 5.6 |`,
    );
    const { written, again } = roundTrip(score);
    expect(written.warnings).toEqual([]);
    const harmonics = (s: typeof score) =>
      shotOf(s).tracks[0]!.bars[0]!.voices[0]!.map((b) => b.notes.map((n) => n.harmonic));
    expect(harmonics(again)).toEqual(harmonics(score));
  });
});

describe("Guitar Pro 4 and 3 differences", () => {
  it("keeps the lyrics in Guitar Pro 4 and says that Guitar Pro 3 has none", () => {
    const { score } = parseScore(fixtureBytes("structure-song.gp"));
    const written = (s: typeof score) => lyricsOf(s.tracks[0]!).filter((l) => l.text.trim() !== "");
    expect(written(score).length).toBeGreaterThan(0);
    const gp4 = writeGp4(score);
    expect(written(parseScore(gp4.bytes).score)).toEqual(written(score));
    const gp3 = writeGp3(score);
    expect(written(parseScore(gp3.bytes).score)).toEqual([]);
    expect(gp3.warnings).toContain("Guitar Pro 3 has no lyrics: they are left out.");
  });

  it("tells that Guitar Pro 3 has one kind of harmonic for a whole beat", () => {
    const score = openedTex(
      String.raw`\track "G" \staff {score tabs} \instrument 25 :4 12.2{th} 7.4{ph} 3.6 5.6 |`,
    );
    expect(writeGp3(score).warnings).toContainEqual(
      expect.stringContaining("keeps one natural or artificial harmonic"),
    );
    // Guitar Pro 4 keeps each note's harmonic.
    expect(writeGp4(score).warnings).toEqual([]);
  });
});
