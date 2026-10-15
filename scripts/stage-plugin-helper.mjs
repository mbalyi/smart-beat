#!/usr/bin/env node
// Builds the out-of-process plugin helper in release and stages it where
// Tauri's `externalBin` expects it: src-tauri/binaries/<name>-<triple>[.exe].
// Runs before every `tauri build` (see src-tauri/tauri.conf.json).
// Idempotent: rebuilds via cargo (a no-op when fresh), then copies only
// when the staged file is missing or differs.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = "vst3-host-helper";
// Keep tauri-build from overwriting Cargo's helper in target/debug.
const SIDECAR = "smart-beat-plugin-helper";
const EXE = process.platform === "win32" ? ".exe" : "";

function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const line = out.split("\n").find((l) => l.startsWith("host: "));
  if (!line) throw new Error("rustc -vV did not report a host triple");
  return line.slice("host: ".length).trim();
}

const triple = hostTriple();
const built = path.join(ROOT, "src-tauri", "target", "release", `${BIN}${EXE}`);
const staged = path.join(ROOT, "src-tauri", "binaries", `${SIDECAR}-${triple}${EXE}`);

// tauri-build validates externalBin paths at compile time, so the staged
// file must exist before cargo runs build.rs: touch an empty placeholder,
// build the real helper, then overwrite the placeholder with the copy.
mkdirSync(path.dirname(staged), { recursive: true });
if (!existsSync(staged)) writeFileSync(staged, Buffer.alloc(0));

execFileSync(
  "cargo",
  ["build", "--release", "--bin", BIN, "--manifest-path", "src-tauri/Cargo.toml"],
  { cwd: ROOT, stdio: "inherit" },
);
if (!existsSync(built)) throw new Error(`Build finished but ${built} is missing`);

const fresh = existsSync(staged) && readFileSync(built).equals(readFileSync(staged));
if (fresh) {
  console.log(`✓ ${path.relative(ROOT, staged)} (up to date)`);
} else {
  mkdirSync(path.dirname(staged), { recursive: true });
  copyFileSync(built, staged);
  console.log(`✓ ${path.relative(ROOT, staged)} (staged)`);
}
