/**
 * Synthetic Guitar Pro 5 fixtures for #53, written with Smart Beat's own GP5
 * writer: track names with Central European letters (Windows-1250), and drum
 * notes placed on chosen strings of the drum tab. Original test songs, safe
 * to commit. `legacy-fixtures.test.ts` keeps e2e/fixtures in sync with them.
 */
import { importer, Settings, type model } from "@coderline/alphatab";

import { writeGp5 } from "@/lib/export/gp5/writer";
import { setDrumLine } from "@/lib/score/drum-lines";
import { setSourceEncoding } from "@/lib/score/encoding";
import { drumNumber, refinish } from "@/lib/score/model";

const tex = (source: string) => importer.ScoreLoader.loadAlphaTex(source, new Settings());

/** "Őszi dal" with the tracks "Szóló 1" and "Ütős hangszer", saved in Windows-1250. */
export function accentedNamesGp5(): Uint8Array {
  const score = tex(String.raw`
\title "Őszi dal"
\artist "Kovács Erzsébet"
\tempo 100
\track "Szóló 1"
  \staff {score tabs}
  \instrument 29
  :4 0.6 2.6 3.6 0.6 | 0.5 2.5 3.5 0.5
\track "Ütős hangszer"
  \instrument percussion
  \articulation defaults
  :4 "Kick (hit)" "Snare (hit)" "Kick (hit)" "Snare (hit)" | "Kick (hit)" "Snare (hit)" "Kick (hit)" "Snare (hit)"
`);
  setSourceEncoding(score, "windows-1250");
  return writeGp5(score).bytes;
}

/** Where the drum-lines fixture puts the hits of bar 2's first beat (alphaTab lines, 6 = top). */
export const BAR2_LINES: Readonly<Record<number, number>> = { 52: 5, 35: 3, 38: 1 };

/** A drum track whose bar 2 stacks China (52) and kick (35), with the snare (38), on chosen strings. */
export function drumLinesGp5(): Uint8Array {
  const score = tex(String.raw`
\title "Drum Lines"
\tempo 100
\track "Drums"
  \instrument percussion
  \articulation defaults
  :4 ("Kick (hit)" "Hi-Hat (closed)") "Hi-Hat (closed)" ("Snare (hit)" "Hi-Hat (closed)") "Hi-Hat (closed)" |
  :4 ("China (hit)" "Kick (hit)" "Snare (hit)") "Hi-Hat (closed)" "Snare (hit)" "Hi-Hat (closed)"
`);
  refinish(score);
  const beat = score.tracks[0]!.staves[0]!.bars[1]!.voices[0]!.beats[0]!;
  for (const note of beat.notes) setDrumLine(note, BAR2_LINES[drumNumber(note)] ?? null);
  return writeGp5(score).bytes;
}

/** The lines of the drum notes of a beat, by drum number. */
export function linesOf(beat: model.Beat, line: (note: model.Note) => number | null) {
  return Object.fromEntries(beat.notes.map((n) => [drumNumber(n), line(n)]));
}
