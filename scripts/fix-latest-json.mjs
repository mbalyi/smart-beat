#!/usr/bin/env node
// Rewrites the API asset URLs tauri-action puts into the updater manifest of a draft release to
// the public download URLs (see useDownloadUrls in release-lib.mjs). Run by the release
// workflow before verify-latest-json.mjs.
//
//   node scripts/fix-latest-json.mjs <tag> <latest.json> <assets.json>
//
// <assets.json> is the release's asset list: [{ "id": 1, "name": "SmartBeat_..." }, ...].

import { readFileSync, writeFileSync } from "node:fs";

import { useDownloadUrls, versionFromTag } from "./release-lib.mjs";

const [tag, file, assetsFile] = process.argv.slice(2);

try {
  if (!tag || !file || !assetsFile) {
    throw new Error("Usage: fix-latest-json.mjs <tag> <latest.json> <assets.json>");
  }
  versionFromTag(tag);
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const changed = useDownloadUrls(manifest, JSON.parse(readFileSync(assetsFile, "utf8")), tag);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Rewrote ${changed} download URL(s) in ${file}.`);
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}
