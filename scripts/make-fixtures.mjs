#!/usr/bin/env node
// Regenerates the Guitar Pro test fixtures in e2e/fixtures/. Run with
// `node scripts/make-fixtures.mjs` after changing a song below, and commit the output.
//
// The songs are original (written for Smart Beat's tests), so they are safe to
// commit. They are written in alphaTex and saved as Guitar Pro 7 (.gp) with
// alphaTab's exporter.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as alphaTab from "@coderline/alphatab";

import { ROOT } from "./npm-packages.mjs";

const OUTPUT_DIR = path.join(ROOT, "e2e", "fixtures");

/**
 * Four tracks (guitar, bass, drums, piano). Bars 1–2 are at 60 BPM and bars
 * 3–4 at 120 BPM, so the song lasts exactly 2 × 4 s + 2 × 2 s = 12 s.
 * The bass has its own mixer values (volume 12/16, balance 4/16 = left) and
 * the piano starts muted, to check that the mixer starts from the file.
 */
const PRACTICE_SONG = String.raw`
\title "Practice Song"
\artist "Smart Beat"
\tempo 60
\track "Guitar"
  \staff {score tabs}
  \instrument 29
  :4 0.6 2.6 3.6 0.6 | 0.5 2.5 3.5 0.5 | \tempo 120 :4 0.4 2.4 3.4 0.4 | 0.3 2.3 3.3 0.3
\track "Bass" { volume 12 balance 4 }
  \staff {tabs}
  \tuning (G2 D2 A1 E1)
  \instrument 33
  :2 0.4 0.4 | 0.3 0.3 | 0.4 0.4 | 0.3 0.3
\track "Drums"
  \instrument percussion
  \articulation defaults
  :4 ("Kick (hit)" "Hi-Hat (closed)") "Hi-Hat (closed)" ("Snare (hit)" "Hi-Hat (closed)") "Hi-Hat (closed)" |
  :4 ("Kick (hit)" "Hi-Hat (closed)") "Hi-Hat (closed)" ("Snare (hit)" "Hi-Hat (closed)") "Hi-Hat (closed)" |
  :8 ("Kick (hit)" "Hi-Hat (closed)") "Hi-Hat (closed)" "Hi-Hat (closed)" "Hi-Hat (closed)" ("Snare (hit)" "Hi-Hat (closed)") "Hi-Hat (closed)" "Hi-Hat (closed)" "Hi-Hat (closed)" |
  :8 ("Kick (hit)" "Hi-Hat (closed)") "Hi-Hat (closed)" "Hi-Hat (closed)" "Hi-Hat (closed)" ("Snare (hit)" "Hi-Hat (closed)") "Hi-Hat (closed)" "Hi-Hat (closed)" "Hi-Hat (closed)"
\track "Piano" { mute }
  \staff {score}
  \instrument 0
  :1 (C4 E4 G4) | (A3 C4 E4) | (F3 A3 C4) | (G3 B3 D4)
`;

const settings = new alphaTab.Settings();

function writeGp7(name, tex) {
  const score = alphaTab.importer.ScoreLoader.loadAlphaTex(tex, settings);
  const bytes = new alphaTab.exporter.Gp7Exporter().export(score, settings);
  writeFileSync(path.join(OUTPUT_DIR, name), bytes);
  console.log(`✓ e2e/fixtures/${name} (${score.tracks.length} tracks, ${bytes.length} bytes)`);
}

/**
 * Passes the desktop app's signature check (GP5 header) but is not a valid
 * song, so the score renderer has to report it as damaged.
 */
function writeCorruptGp5(name) {
  const version = "FICHIER GUITAR PRO v5.00";
  const bytes = Buffer.alloc(64, 0xff);
  bytes[0] = version.length;
  bytes.write(version, 1, "latin1");
  writeFileSync(path.join(OUTPUT_DIR, name), bytes);
  console.log(`✓ e2e/fixtures/${name} (${bytes.length} bytes)`);
}

mkdirSync(OUTPUT_DIR, { recursive: true });
writeGp7("practice-song.gp", PRACTICE_SONG);
writeCorruptGp5("corrupt.gp5");
