// Turns recorded notes into tab with the app's own code, for the comparison harness.
//
//   node --import ./scripts/record-to-tab/register.mjs scripts/record-to-tab/notes-to-tab.ts \
//     [--tuning standard] [--strings 6] [--program 25] < notes.json
//
// Input on stdin: { "notes": [{ "start", "end", "pitch", "velocity" }] }, times in seconds.
// Output: { bpm, notes: [{ start, end, pitch, string, fret }], warnings }, times in seconds
// after the notes were moved onto the measured grid. `--tuning` is a preset name from the app
// ("standard", "drop-d", ...) for `--strings` strings, or a comma list of MIDI pitches, highest
// string first. Run with `--list` to see the names.
import { readFileSync } from "node:fs";

import { recordingToSong, tabNotes, type RecordedNote } from "@/lib/import/recording";
import { shortTuningName, tuningPresets } from "@/lib/score/music";
import { tempoAt } from "@/lib/score/structure";

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const strings = Number(option("strings", "6"));
const presets = tuningPresets(strings);
/** The names a preset answers to: its full name and the short one ("drop-d"). */
const names = (preset: { name: string; tuning: number[] }) => [
  slug(preset.name),
  slug(shortTuningName(preset.tuning) ?? ""),
];

if (process.argv.includes("--list")) {
  console.log(
    presets.map((preset) => `${names(preset).join(" | ")}  ${preset.tuning.join(",")}`).join("\n"),
  );
  process.exit(0);
}

const wanted = option("tuning", "standard");
const tuning = /^\d+(,\d+)+$/.test(wanted)
  ? wanted.split(",").map(Number)
  : wanted === "standard"
    ? presets[0]?.tuning
    : presets.find((preset) => names(preset).includes(slug(wanted)))?.tuning;
if (!tuning) {
  console.error(`Unknown tuning "${wanted}" for ${strings} strings. Try --list.`);
  process.exit(1);
}

const input = JSON.parse(readFileSync(0, "utf8")) as { notes: RecordedNote[] };
const { score, warnings } = recordingToSong(input.notes, {
  tuning: [...tuning],
  trackName: "Guitar",
  program: Number(option("program", "25")),
});
console.log(
  JSON.stringify({ bpm: Math.round(tempoAt(score, 0)), notes: tabNotes(score, 0), warnings }),
);
