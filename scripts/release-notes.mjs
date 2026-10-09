#!/usr/bin/env node
// Prints the CHANGELOG.md section for a release tag and checks that the tag matches the app
// version in package.json. Used by the release workflow for the GitHub Release text.
//
//   node scripts/release-notes.mjs v0.2.0            # notes to stdout
//   node scripts/release-notes.mjs v0.2.0 --check    # only check the tag and the notes

import { readFileSync } from "node:fs";
import path from "node:path";

import { assertTagMatchesVersion, extractReleaseNotes, versionFromTag } from "./release-lib.mjs";

const root = path.resolve(import.meta.dirname, "..");
const [tag, flag] = process.argv.slice(2);

try {
  if (!tag) throw new Error("Usage: release-notes.mjs <tag> [--check]");
  const version = versionFromTag(tag);
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assertTagMatchesVersion(tag, pkg.version);

  const notes = extractReleaseNotes(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), version);
  if (flag === "--check") console.log(`✓ ${tag} matches package.json and has release notes.`);
  else console.log(notes);
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}
