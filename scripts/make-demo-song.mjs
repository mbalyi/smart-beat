#!/usr/bin/env node
// Regenerates src/demo/demo-song.atex, the demo song of the guided tour (#84). Run with
// `node scripts/make-demo-song.mjs` after changing the song below, and commit the output.
//
// The song is original (written for Smart Beat) and belongs to the project like the rest of
// the source: 24 bars at 100 BPM for drums, guitar, bass and piano, in four named sections.

import { writeFileSync } from "node:fs";
import path from "node:path";

import * as alphaTab from "@coderline/alphatab";

import { ROOT } from "./npm-packages.mjs";

const OUTPUT = path.join(ROOT, "src", "demo", "demo-song.atex");

/** Per chord: guitar power chord, bass root, piano chord. */
const CHORDS = {
  Am: { guitar: "(5.6 7.5)", bass: "0.3", piano: "(A3 C4 E4)" },
  Dm: { guitar: "(5.5 7.4)", bass: "0.2", piano: "(D4 F4 A4)" },
  E: { guitar: "(0.6 2.5)", bass: "0.4", piano: "(E4 G#4 B4)" },
  F: { guitar: "(1.6 3.5)", bass: "1.4", piano: "(F3 A3 C4)" },
  C: { guitar: "(3.5 5.4)", bass: "3.3", piano: "(C4 E4 G4)" },
  G: { guitar: "(3.6 5.5)", bass: "3.4", piano: "(G3 B3 D4)" },
};

const SECTIONS = [
  ["Intro", ["Am", "Am", "E", "E"]],
  ["Verse", ["Am", "Am", "Dm", "Dm", "Am", "Am", "E", "E"]],
  ["Chorus", ["F", "F", "C", "C", "G", "G", "Am", "E"]],
  ["Outro", ["Am", "Dm", "E", "Am"]],
];

const HAT = '"Hi-Hat (closed)"';
const KICK = '("Kick (hit)" "Hi-Hat (closed)")';
const SNARE = '("Snare (hit)" "Hi-Hat (closed)")';
const DRUM_BAR = `:8 ${KICK} ${HAT} ${HAT} ${HAT} ${SNARE} ${HAT} ${KICK} ${HAT}`;
const DRUM_FILL = `:8 ${KICK} ${HAT} ${HAT} ${HAT} ${SNARE} ${HAT} ${SNARE} ${SNARE}`;

const bars = SECTIONS.flatMap(([section, chords]) =>
  chords.map((chord, i) => ({
    section: i === 0 ? section : null,
    chord,
    last: i === chords.length - 1,
  })),
);

/** One bar of the first track, with the section name on its first bar. */
const withSection = (bar, content) =>
  `${bar.section ? `\\section "${bar.section}" ` : ""}${content}`;
const join = (parts) => parts.join(" |\n  ");

const guitar = join(
  bars.map((b) => withSection(b, `:8 ${Array(8).fill(CHORDS[b.chord].guitar).join(" ")}`)),
);
const bass = join(bars.map((b) => `:4 ${Array(4).fill(CHORDS[b.chord].bass).join(" ")}`));
const drums = join(bars.map((b, i) => (b.last && i < bars.length - 1 ? DRUM_FILL : DRUM_BAR)));
const piano = join(bars.map((b) => `:2 ${CHORDS[b.chord].piano} ${CHORDS[b.chord].piano}`));

const tex = `\\title "Smart Beat Demo"
\\artist "Smart Beat"
\\subtitle "An original song to try the app on"
\\tempo 100
\\track "Guitar"
  \\staff {score tabs}
  \\instrument 29
  ${guitar}
\\track "Bass"
  \\staff {tabs}
  \\tuning (G2 D2 A1 E1)
  \\instrument 33
  ${bass}
\\track "Drums"
  \\instrument percussion
  \\articulation defaults
  ${drums}
\\track "Piano"
  \\staff {score}
  \\instrument 0
  ${piano}
`;

const score = alphaTab.importer.ScoreLoader.loadAlphaTex(tex, new alphaTab.Settings());
if (score.tracks.length !== 4 || score.masterBars.length !== bars.length) {
  throw new Error(
    `Unexpected demo song: ${score.tracks.length} tracks, ${score.masterBars.length} bars`,
  );
}
writeFileSync(OUTPUT, tex);
console.log(
  `✓ src/demo/demo-song.atex (${score.tracks.length} tracks, ${score.masterBars.length} bars)`,
);
