#!/usr/bin/env node
// Checks the updater manifest of a (draft) GitHub Release: every supported target has a signature
// and a download URL inside this repository's release. Run by the release workflow after all
// installers are uploaded; you can also run it by hand.
//
//   node scripts/verify-latest-json.mjs <tag> <path-to-latest.json>
//   node scripts/verify-latest-json.mjs v0.2.0 latest.json

import { readFileSync } from "node:fs";

import { verifyLatestJson, versionFromTag } from "./release-lib.mjs";

const [tag, file] = process.argv.slice(2);

try {
  if (!tag || !file) throw new Error("Usage: verify-latest-json.mjs <tag> <latest.json>");
  const version = versionFromTag(tag);
  const problems = verifyLatestJson(JSON.parse(readFileSync(file, "utf8")), { tag, version });
  if (problems.length > 0) {
    console.error(`✗ ${file} is not ready for ${tag}:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`✓ ${file} covers every updater target for ${tag}.`);
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}
