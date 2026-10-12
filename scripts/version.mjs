#!/usr/bin/env node
// One canonical version: package.json. This script checks that every other version-bearing file
// agrees with it, and bumps all of them together. tauri.conf.json reads package.json directly.
//
//   node scripts/version.mjs check              # pnpm version:check (part of pnpm check)
//   node scripts/version.mjs check --tag v0.2.0 # also: the tag matches (release workflow)
//   node scripts/version.mjs patch|minor|major  # pnpm release:patch|minor|major
//   node scripts/version.mjs 0.3.0-beta.1       # an explicit (pre)release version

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  assertTagMatchesVersion,
  checkVersionFiles,
  isPrerelease,
  nextVersion,
  releaseChangelog,
  setVersion,
} from "./release-lib.mjs";

const root = path.resolve(import.meta.dirname, "..");
const FILES = {
  packageJson: "package.json",
  cargoToml: "src-tauri/Cargo.toml",
  cargoLock: "src-tauri/Cargo.lock",
};

const read = (file) => readFileSync(path.join(root, file), "utf8");
const git = (...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function readAll() {
  return Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, read(file)]));
}

function check(tag) {
  const files = readAll();
  const problems = checkVersionFiles(files);
  const version = JSON.parse(files.packageJson).version;
  if (tag) {
    try {
      assertTagMatchesVersion(tag, version);
    } catch (error) {
      problems.push(error.message);
    }
  }
  if (problems.length) throw new Error(problems.join("\n  "));
  console.log(`✓ Version ${version} is the same everywhere${tag ? ` and matches ${tag}` : ""}.`);
}

function bump(kind) {
  if (git("status", "--porcelain")) throw new Error("Commit or stash your changes first.");
  const files = readAll();
  const problems = checkVersionFiles(files);
  if (problems.length) throw new Error(`Fix the versions first:\n  ${problems.join("\n  ")}`);

  const current = JSON.parse(files.packageJson).version;
  const version = nextVersion(current, kind);
  const tag = `v${version}`;
  if (git("tag", "--list", tag)) throw new Error(`Tag ${tag} already exists.`);
  try {
    if (git("ls-remote", "--tags", "origin", `refs/tags/${tag}`)) {
      throw new Error(`Tag ${tag} already exists on origin.`);
    }
  } catch (error) {
    if (/already exists/.test(error.message)) throw error;
    console.warn(`! Could not check the tags on origin (${error.message.split("\n")[0]}).`);
  }

  const updated = setVersion(files, version);
  for (const [key, file] of Object.entries(FILES))
    writeFileSync(path.join(root, file), updated[key]);
  writeFileSync(path.join(root, "CHANGELOG.md"), releaseChangelog(read("CHANGELOG.md"), version));

  console.log(`✓ ${current} → ${version}${isPrerelease(version) ? " (prerelease)" : ""}`);
  console.log(
    "  Updated package.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock and CHANGELOG.md.",
  );
  console.log("  Next: review the CHANGELOG section, merge the change to main, then:");
  console.log(`    git tag ${tag} && git push origin ${tag}`);
}

const [command, flag, value] = process.argv.slice(2);
try {
  if (command === "check") check(flag === "--tag" ? value : undefined);
  else if (command) bump(command);
  else
    throw new Error("Usage: version.mjs check [--tag vX.Y.Z] | patch | minor | major | <version>");
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}
