import { importer, Settings } from "@coderline/alphatab";
import { describe, expect, it } from "vitest";

import { writeGp5 } from "@/lib/export/gp5/writer";
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
