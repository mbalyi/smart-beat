#!/usr/bin/env node
// Collects the outdated npm packages, Cargo crates and GitHub Actions and writes the weekly
// issue body. Run by .github/workflows/dependency-report.yml; see docs/dependencies.md.
//
//   node scripts/dependency-report.mjs --out report.md
//
// Needs `pnpm`, `cargo outdated` (cargo-outdated) and an authenticated `gh` on the PATH.
// Prints the number of outdated dependencies; writes nothing when there are none.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  issueTitle,
  outdatedActions,
  parseActionUses,
  parseCargoOutdated,
  parsePnpmOutdated,
  renderReport,
  totalOutdated,
} from "./dependency-report-lib.mjs";

const root = path.resolve(import.meta.dirname, "..");

/** Runs a command and returns stdout; the `outdated` tools exit 1 when something is outdated. */
function run(command, args, cwd = root) {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    if (error.status === 1 && error.stdout) return error.stdout;
    throw error;
  }
}

function npmOutdated() {
  const output = run("pnpm", ["outdated", "--format", "json"]).trim();
  return parsePnpmOutdated(output ? JSON.parse(output) : {});
}

function cargoOutdated() {
  const output = run(
    "cargo",
    ["outdated", "--root-deps-only", "--format", "json"],
    path.join(root, "src-tauri"),
  );
  return parseCargoOutdated(JSON.parse(output));
}

function actionsOutdated() {
  const dir = path.join(root, ".github/workflows");
  const texts = readdirSync(dir)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => readFileSync(path.join(dir, file), "utf8"));
  const uses = parseActionUses(texts);
  const latestByRepo = {};
  for (const repo of new Set(uses.map(({ action }) => action.split("/").slice(0, 2).join("/")))) {
    try {
      latestByRepo[repo] = run("gh", [
        "api",
        `repos/${repo}/releases/latest`,
        "--jq",
        ".tag_name",
      ]).trim();
    } catch {
      // No releases, or the repo is gone: leave it out of the report.
    }
  }
  return outdatedActions(uses, latestByRepo);
}

const outIndex = process.argv.indexOf("--out");
const outFile = outIndex === -1 ? null : process.argv[outIndex + 1];

const report = { npm: npmOutdated(), cargo: cargoOutdated(), actions: actionsOutdated() };
const total = totalOutdated(report);

if (total > 0 && outFile) {
  const runUrl = process.env.GITHUB_SERVER_URL
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;
  writeFileSync(outFile, renderReport(report, runUrl));
}
if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `count=${total}\ntitle=${issueTitle(new Date())}\n`, {
    flag: "a",
  });
}
console.log(total);
