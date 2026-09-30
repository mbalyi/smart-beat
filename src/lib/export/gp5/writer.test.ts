import { importer, Settings } from "@coderline/alphatab";
import { describe, expect, it } from "vitest";

import { writeGp5 } from "@/lib/export/gp5/writer";
import { lyricsOf } from "@/lib/score/lyrics";
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
});
