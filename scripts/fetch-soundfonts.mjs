#!/usr/bin/env node
// Downloads the optional FluidR3 SoundFont into public/soundfont/, next to the
// Sonivox SoundFont that alphaTab's Vite plugin copies there. Runs before
// `tauri dev` and `tauri build` (see src-tauri/tauri.conf.json).
//
// The file is 14.5 MB, so it is not committed. It is pinned to MuseScore's
// v2.1.0 tag (FluidR3Mono 2.312, MIT). Later MuseScore revisions replaced it with
// MS_General, whose license was still "subject to change", so don't bump the
// commit without re-reviewing the license (docs/licensing.md).
// Every file is verified against its SHA-256 and cached in node_modules/.cache.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ROOT } from "./npm-packages.mjs";

const SOURCE =
  "https://raw.githubusercontent.com/musescore/MuseScore/871c8ce2002e8b3c198f532fdb4fbcce7914f951/share/sound";

/** Files to install into public/soundfont/. Keep in sync with src/lib/score/soundfonts.ts. */
const FILES = [
  {
    name: "FluidR3Mono_GM.sf3",
    sha256: "cfcd66d89e8386823400eca64934b14fbea7bf48ba1f00d21189af1262794ec2",
  },
  {
    name: "FluidR3Mono_License.md",
    sha256: "09926f9451f751408abd65162c99343f840234d2a708584808fd46427633063f",
  },
];

const OUTPUT_DIR = path.join(ROOT, "public", "soundfont");
const CACHE_DIR = path.join(ROOT, "node_modules", ".cache", "smart-beat", "soundfonts");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function hasExpectedContent(file, expected) {
  return existsSync(file) && sha256(readFileSync(file)) === expected;
}

async function download(name, expected) {
  const url = `${SOURCE}/${encodeURIComponent(name)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new Error(`${name}: checksum mismatch (expected ${expected}, got ${actual})`);
  }
  return bytes;
}

async function install({ name, sha256: expected }) {
  const target = path.join(OUTPUT_DIR, name);
  if (hasExpectedContent(target, expected)) return "up to date";

  const cached = path.join(CACHE_DIR, name);
  if (!hasExpectedContent(cached, expected)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cached, await download(name, expected));
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });
  copyFileSync(cached, target);
  return "installed";
}

try {
  for (const file of FILES) {
    const status = await install(file);
    console.log(`✓ ${path.relative(ROOT, path.join(OUTPUT_DIR, file.name))} (${status})`);
  }
} catch (error) {
  console.error(`Could not fetch the FluidR3 SoundFont: ${error.message}`);
  console.error("Check your network connection, then run `pnpm soundfonts:fetch` again.");
  process.exit(1);
}
