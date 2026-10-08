// Writes src/lib/audio/sound-ranges.json: for each bundled SoundFont and each General MIDI
// program, the lowest pitch at which one of its samples was recorded (run with
// `pnpm ranges:report`). The track settings use it to warn when a tuning goes far below what a
// sound was recorded at (an 8-string guitar on a sound whose lowest sample is B2).
// Needs Node 22.18+ (runs the TypeScript sources directly).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { melodicRootKeys } from "../src/lib/score/sf2-keys.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "src/lib/audio/sound-ranges.json");

// Where each SoundFont (see src/lib/score/soundfonts.ts) can be found, first hit wins.
const FONTS = {
  sonivox: [
    "node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf3",
    "public/soundfont/sonivox.sf3",
  ],
  fluidr3: [
    "public/soundfont/FluidR3Mono_GM.sf3",
    "node_modules/.cache/smart-beat/soundfonts/FluidR3Mono_GM.sf3",
  ],
};

const previous = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : {};
const ranges = { ...previous };
for (const [id, candidates] of Object.entries(FONTS)) {
  const file = candidates.map((c) => path.join(root, c)).find((c) => existsSync(c));
  if (!file) {
    console.warn(
      `${id}: SoundFont not found (run \`pnpm soundfonts:fetch\`); keeping the old data`,
    );
    continue;
  }
  const roots = melodicRootKeys(new Uint8Array(readFileSync(file)));
  ranges[id] = Object.fromEntries(
    [...roots.entries()].sort((a, b) => a[0] - b[0]).map(([program, key]) => [program, key]),
  );
  console.log(`${id}: ${roots.size} programs from ${path.relative(root, file)}`);
}
writeFileSync(output, `${JSON.stringify(ranges, null, 2)}\n`);
console.log(`Wrote ${path.relative(root, output)}`);
