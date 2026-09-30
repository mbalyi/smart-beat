/** ASCII tablature export: a plain-text version of the stringed tracks. */
import { beatTicks } from "@/lib/score/bar-duration";
import type { Bar, Score, Track } from "@/lib/score/model";
import { pitchName } from "@/lib/score/music";

/** Lines are wrapped at this many characters. */
export const LINE_WIDTH = 80;

/** Extra dashes after a note, so longer notes take more room. */
function spacing(ticks: number): number {
  if (ticks >= 3840) return 5;
  if (ticks >= 1920) return 4;
  if (ticks >= 960) return 3;
  if (ticks >= 480) return 2;
  return 1;
}

/**
 * String names from the tuning, highest first: "e B G D A E". The top string is
 * lowercase; strings that still share a name (a 12-string, unusual tunings) get
 * their octave.
 */
export function stringNames(tuning: readonly number[]): string[] {
  const names = tuning.map((pitch, i) => {
    const name = pitchName(pitch, { octave: false });
    return i === 0 ? name.toLowerCase() : name;
  });
  return names.map((name, i) =>
    names.indexOf(name) !== i || names.lastIndexOf(name) !== i ? pitchName(tuning[i]!) : name,
  );
}

interface Column {
  /** One entry per string, top string first. */
  cells: string[];
  width: number;
}

function barColumns(bar: Bar, strings: number): Column[] {
  const voice = bar.voices[0];
  const columns: Column[] = [];
  for (const beat of voice?.beats ?? []) {
    if (beat.graceType !== 0) continue;
    const cells = Array.from({ length: strings }, () => "");
    for (const note of beat.notes) {
      if (!note.isStringed) continue;
      const row = strings - note.string;
      const fret = note.isDead ? "x" : String(note.fret);
      cells[row] = note.isGhost ? `(${fret})` : fret;
    }
    const digits = Math.max(1, ...cells.map((cell) => cell.length));
    columns.push({ cells, width: digits + spacing(beatTicks(beat)) });
  }
  return columns;
}

/** The text of a bar: one string per staff line, with its bar line. */
function barText(columns: Column[], strings: number): string[] {
  const lines = Array.from({ length: strings }, () => "-");
  for (const column of columns) {
    for (let row = 0; row < strings; row++) {
      const cell = column.cells[row]!;
      lines[row] += cell + "-".repeat(column.width - cell.length);
    }
  }
  return lines.map((line) => `${line}|`);
}

function trackText(track: Track): string[] {
  const staff = track.staves[0]!;
  const tuning = staff.stringTuning.tunings;
  const names = stringNames(tuning);
  const label = Math.max(...names.map((n) => n.length));
  const bars = staff.bars.map((bar) => barText(barColumns(bar, tuning.length), tuning.length));

  const out: string[] = [];
  let system: string[][] = [];
  let width = 0;
  const flush = () => {
    if (system.length === 0) return;
    for (let row = 0; row < tuning.length; row++) {
      out.push(`${names[row]!.padEnd(label)}|${system.map((bar) => bar[row]!).join("")}`);
    }
    out.push("");
    system = [];
    width = 0;
  };
  bars.forEach((bar) => {
    const barWidth = bar[0]!.length;
    if (system.length > 0 && label + 1 + width + barWidth > LINE_WIDTH) flush();
    system.push(bar);
    width += barWidth;
  });
  flush();
  return out;
}

/**
 * The song as text: title, then each stringed track with its tuning and its
 * bars. Drum and keyboard tracks have no tablature and are listed as skipped.
 */
export function writeAsciiTab(score: Score): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  const lines: string[] = [];
  const title = [score.title, score.artist].filter((part) => part.trim() !== "").join(" - ");
  if (title) lines.push(title, "=".repeat(title.length), "");
  for (const track of score.tracks) {
    const staff = track.staves[0]!;
    const name = track.name.trim() || `Track ${track.index + 1}`;
    if (track.isPercussion || staff.isPercussion || staff.stringTuning.tunings.length === 0) {
      warnings.push(`“${name}” has no strings, so it is left out of the tab.`);
      continue;
    }
    const tuning = [...staff.stringTuning.tunings]
      .reverse()
      .map((p) => pitchName(p, { octave: false }))
      .join(" ");
    lines.push(`${name} (tuning ${tuning}${staff.capo ? `, capo ${staff.capo}` : ""})`, "");
    lines.push(...trackText(track));
  }
  if (lines.length === 0 || lines.every((line) => line === "")) {
    warnings.push("The song has no stringed tracks.");
  }
  return { text: lines.join("\n").trimEnd() + "\n", warnings };
}
