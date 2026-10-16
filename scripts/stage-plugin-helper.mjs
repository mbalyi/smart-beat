#!/usr/bin/env node
// Builds the out-of-process plugin helper in release and stages it where
// Tauri's `externalBin` expects it: src-tauri/binaries/<name>-<triple>[.exe].
// macOS also stages a separately signed copy for bundle.macOS.files.
// Runs before every `tauri build` (see src-tauri/tauri.conf.json).
//
// The file has to carry the triple Tauri is building for, not this machine's:
// a `--target universal-apple-darwin` release wants one fat binary, so both
// slices are built and merged with `lipo` under that name. Tauri passes the
// target to build hooks as TAURI_ENV_TARGET_TRIPLE; `--target <triple>` does
// the same by hand.
//
// Idempotent: rebuilds via cargo (a no-op when fresh), then copies only when
// the staged file is missing or differs.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { signPluginHelper } from "./sign-plugin-helper.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = "vst3-host-helper";
// Keep tauri-build from overwriting Cargo's helper in target/debug.
const SIDECAR = "smart-beat-plugin-helper";
const EXE = process.platform === "win32" ? ".exe" : "";
const UNIVERSAL = "universal-apple-darwin";

function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const line = out.split("\n").find((l) => l.startsWith("host: "));
  if (!line) throw new Error("rustc -vV did not report a host triple");
  return line.slice("host: ".length).trim();
}

function requestedTriple() {
  const flag = process.argv.indexOf("--target");
  if (flag !== -1 && process.argv[flag + 1]) return process.argv[flag + 1];
  return process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
}

/** Builds the helper for one triple; returns the binary cargo produced. */
function build(target, host, explicitTarget) {
  const args = ["build", "--release", "--bin", BIN, "--manifest-path", "src-tauri/Cargo.toml"];
  // A host build uses target/release, the way every other command does, so it
  // shares the compiled dependencies. A cross or universal build passes
  // `--target` so its directories line up with the ones Tauri builds itself.
  const cross = explicitTarget || target !== host;
  if (cross) args.push("--target", target);
  execFileSync("cargo", args, { cwd: ROOT, stdio: "inherit" });
  const built = path.join(
    ROOT,
    "src-tauri",
    "target",
    ...(cross ? [target] : []),
    "release",
    `${BIN}${EXE}`,
  );
  if (!existsSync(built)) throw new Error(`Build finished but ${built} is missing`);
  return built;
}

const host = hostTriple();
const triple = requestedTriple();
const slices = triple === UNIVERSAL ? ["aarch64-apple-darwin", "x86_64-apple-darwin"] : [triple];
const explicitTarget = triple !== host;
const staged = path.join(ROOT, "src-tauri", "binaries", `${SIDECAR}-${triple}${EXE}`);

// tauri-build validates externalBin paths at compile time, so a staged file
// must exist before cargo runs build.rs. A stale or placeholder file is fine
// here: everything built below overwrites it before the bundle is made.
mkdirSync(path.dirname(staged), { recursive: true });
if (!existsSync(staged)) writeFileSync(staged, Buffer.alloc(0));

const built = slices.map((target) => build(target, host, explicitTarget));
let fresh;
if (built.length === 1) {
  fresh = readFileSync(built[0]).equals(readFileSync(staged));
  if (!fresh) copyFileSync(built[0], staged);
} else {
  const dir = mkdtempSync(path.join(tmpdir(), "smart-beat-helper-"));
  const fat = path.join(dir, `${SIDECAR}${EXE}`);
  try {
    execFileSync("lipo", ["-create", "-output", fat, ...built], { stdio: "inherit" });
    const merged = readFileSync(fat);
    fresh = merged.equals(readFileSync(staged));
    if (!fresh) copyFileSync(fat, staged);
    // Tauri also bundles Cargo's additional binaries. Its universal build
    // merges only the main executable, so supply the helper at that path too.
    const cargoBinary = path.join(
      ROOT,
      "src-tauri",
      "target",
      UNIVERSAL,
      "release",
      `${BIN}${EXE}`,
    );
    mkdirSync(path.dirname(cargoBinary), { recursive: true });
    if (!existsSync(cargoBinary) || !merged.equals(readFileSync(cargoBinary))) {
      copyFileSync(fat, cargoBinary);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// macOS custom files bypass Tauri's global per-binary entitlements. Sign the
// selected helper before the app is sealed; the ordinary Cargo copy is unused.
if (triple.endsWith("-apple-darwin")) {
  const isolated = path.join(ROOT, "src-tauri", "binaries", "smart-beat-plugin-helper-macos");
  copyFileSync(staged, isolated);
  signPluginHelper(isolated);
}

console.log(`✓ ${path.relative(ROOT, staged)} (${fresh ? "up to date" : "staged"})`);
