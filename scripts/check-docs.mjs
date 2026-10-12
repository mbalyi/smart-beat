#!/usr/bin/env node
// Fails when a tracked file names a stale contact address or repository URL, or when a Markdown
// file links to a file that does not exist. Part of `pnpm check`.
//
//   node scripts/check-docs.mjs

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { findBrokenLinks, findStaleContacts } from "./docs-lib.mjs";

const root = path.resolve(import.meta.dirname, "..");
const project = JSON.parse(readFileSync(path.join(root, "src/lib/project-info.json"), "utf8"));

// Generated or third-party text that may name other people's addresses.
const SKIP = [
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/,
  /^LICENSE$/,
  /^scripts\/docs-lib\.test\.mjs$/, // its fixtures are stale on purpose
  /\.(png|jpe?g|gif|ico|icns|svg|webp|gp[345x]?|mid|wav|mp3|flac|ogg|sf[23]|nam|zip|woff2?|ttf|otf)$/i,
];

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\n")
  .filter(
    (file) =>
      file &&
      !SKIP.some((pattern) => pattern.test(file)) &&
      existsSync(path.join(root, file)) &&
      statSync(path.join(root, file)).isFile(),
  );

const errors = [];
for (const file of files) {
  const text = readFileSync(path.join(root, file), "utf8");
  for (const { line, found, expected } of findStaleContacts(text, project)) {
    errors.push(`${file}:${line}: ${found} (use ${expected}, from src/lib/project-info.json)`);
  }
  if (file.endsWith(".md")) {
    for (const { target } of findBrokenLinks(file, text, (target) =>
      existsSync(path.join(root, target)),
    )) {
      errors.push(`${file}: broken link ${target}`);
    }
  }
}

if (errors.length) {
  console.error(errors.map((error) => `✗ ${error}`).join("\n"));
  process.exit(1);
}
console.log(`✓ ${files.length} files: contacts and Markdown links are up to date.`);
