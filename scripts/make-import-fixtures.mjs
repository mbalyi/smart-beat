#!/usr/bin/env node
// Regenerates the import fixtures in e2e/fixtures/ that are not Guitar Pro files:
// text tab (.txt), alphaTex (.atex) and MuseScore (.mscz, a ZIP of the .mscx next to it).
// Run with `node scripts/make-import-fixtures.mjs` and commit the output. The songs are
// original (written for Smart Beat's tests).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

import { ROOT } from "./npm-packages.mjs";

const DIR = path.join(ROOT, "e2e", "fixtures");

const TEXT_TAB = `Text Tab Song
=============

Guitar
e|---0---3---|---5-------|
B|---1---0---|-----------|
G|---0---0---|---5---7---|
D|---2---0---|-----------|
A|---3---2---|---7-------|
E|-----------|---------0-|
`;

const ALPHATEX = String.raw`\title "Tex Song"
\artist "Smart Beat"
\tempo 100
\track "Guitar"
  \staff {score tabs}
  :4 0.6 2.6 3.6 0.6 | 0.5 2.5 3.5 0.5 |
`;

/** A ZIP archive with one deflated file. */
function zip(name, data) {
  const fileName = Buffer.from(name);
  const packed = deflateRawSync(data);
  const u16 = (n) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);
  const u32 = (n) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
  const local = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(8),
    u16(0),
    u16(0),
    u32(0),
    u32(packed.length),
    u32(data.length),
    u16(fileName.length),
    u16(0),
    fileName,
    packed,
  ]);
  const central = Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0),
    u16(8),
    u16(0),
    u16(0),
    u32(0),
    u32(packed.length),
    u32(data.length),
    u16(fileName.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    fileName,
  ]);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(central.length),
    u32(local.length),
    u16(0),
  ]);
  return Buffer.concat([local, central, end]);
}

writeFileSync(path.join(DIR, "text-tab-song.txt"), TEXT_TAB);
writeFileSync(path.join(DIR, "tex-song.atex"), ALPHATEX);
const mscx = readFileSync(path.join(DIR, "practice-song.mscx"));
writeFileSync(path.join(DIR, "practice-song.mscz"), zip("practice-song.mscx", mscx));
console.log("✓ e2e/fixtures/text-tab-song.txt, tex-song.atex, practice-song.mscz");
