/**
 * ASCII tab import (`.txt`): the plain-text tablature found on forums and tab
 * sites. Six lines of dashes and fret numbers, one per string:
 *
 *     e|--0---3---|
 *     B|--1---0---|
 *
 * Text has no rhythm, so the import guesses it from the spacing: the distance
 * between notes sets the note value, and a bar's number of steps sets the time
 * signature. Techniques (hammer-ons, slides, bends...) are left out and listed
 * in the warnings. The notes are written as alphaTex and read by alphaTab.
 */
import { importer, Settings } from "@coderline/alphatab";

import { ScoreLoadError } from "@/lib/score/errors";
import { STANDARD_GUITAR } from "@/lib/score/music";
import type { Score } from "@/lib/score/model";

export interface TextImport {
  score: Score;
  warnings: string[];
}

const MAX_FRET = 29;
const MAX_BARS = 2000;
const MAX_STEPS = 32;

/** Pitch classes of the note names that label a string. */
const PITCH_CLASS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** Standard tunings (highest string first) a string label's pitch class is placed near. */
const REFERENCE: Record<number, number[]> = {
  4: [43, 38, 33, 28],
  5: [64, 59, 55, 50, 45],
  6: STANDARD_GUITAR,
  7: [...STANDARD_GUITAR, 35],
  8: [...STANDARD_GUITAR, 35, 30],
};

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
/** alphaTex pitch of a MIDI number, e.g. 64 → "E4". */
const texPitch = (midi: number) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

/** Where the label of a string line ends, and what it names (pitch class), if it has one. */
function splitLabel(line: string): { body: number; pitchClass: number | null } {
  const match = /^\s*([A-Ga-g])([#b]?)\s*(?=[|:\-0-9])/.exec(line);
  if (!match) return { body: /^\s*/.exec(line)![0].length, pitchClass: null };
  let pitchClass = PITCH_CLASS[match[1]!.toLowerCase()]!;
  if (match[2] === "#") pitchClass += 1;
  if (match[2] === "b") pitchClass -= 1;
  return { body: match[0].length, pitchClass: (pitchClass + 12) % 12 };
}

/** A line of tablature: dashes (and the marks tab uses) with fret numbers, after an optional string name. */
function isStringLine(line: string): boolean {
  const { body } = splitLabel(line);
  const rest = line.slice(body);
  return (
    /^[-0-9|hpbrsxX/\\~^()<>*.=vt\s]+$/.test(rest) &&
    (rest.match(/-/g)?.length ?? 0) >= 2 &&
    rest.trim().length >= 5
  );
}

interface Hit {
  col: number;
  string: number;
  /** A number, or "x" for a dead note. */
  fret: number | "x";
  width: number;
}

interface System {
  /** String names (pitch classes), top line first. */
  labels: (number | null)[];
  hits: Hit[];
  /** Columns of bar lines. */
  bars: number[];
  start: number;
  end: number;
  techniques: boolean;
}

function parseSystem(lines: string[]): System {
  const labels: (number | null)[] = [];
  const hits: Hit[] = [];
  const barCounts = new Map<number, number>();
  let start = Infinity;
  let end = 0;
  let techniques = false;

  lines.forEach((line, string) => {
    const { body, pitchClass } = splitLabel(line);
    labels.push(pitchClass);
    start = Math.min(start, body);
    end = Math.max(end, line.trimEnd().length);
    for (let col = body; col < line.length; col++) {
      const char = line[col]!;
      if (char === "|") {
        barCounts.set(col, (barCounts.get(col) ?? 0) + 1);
      } else if (/\d/.test(char)) {
        let width = 1;
        while (/\d/.test(line[col + width] ?? "")) width++;
        hits.push({ col, string, fret: Number(line.slice(col, col + width)), width });
        col += width - 1;
      } else if (char === "x" || char === "X") {
        hits.push({ col, string, fret: "x", width: 1 });
      } else if (/[hpbrs/\\~^<>*vt]/.test(char)) {
        techniques = true;
      }
    }
  });

  // A bar line is a column most of the lines have a `|` at.
  const need = Math.ceil(lines.length / 2);
  const bars = [...barCounts]
    .filter(([, n]) => n >= need)
    .map(([col]) => col)
    .sort((a, b) => a - b);
  return { labels, hits, bars, start, end, techniques };
}

/** The MIDI pitches of the string labels, near the standard tuning (highest string first). */
function tuningFor(labels: (number | null)[]): number[] {
  const reference = REFERENCE[labels.length] ?? STANDARD_GUITAR.slice(0, labels.length);
  return labels.map((pitchClass, i) => {
    const standard = reference[i] ?? 40;
    if (pitchClass === null) return standard;
    let best = pitchClass;
    for (let candidate = pitchClass; candidate < 128; candidate += 12) {
      if (Math.abs(candidate - standard) < Math.abs(best - standard)) best = candidate;
    }
    return best;
  });
}

/** Whether the string names go up from line to line (E A D G B E), a fourth at a time. */
function isAscending(labels: (number | null)[]): boolean {
  let up = 0;
  let down = 0;
  for (let i = 1; i < labels.length; i++) {
    const a = labels[i - 1];
    const b = labels[i];
    if (a === null || a === undefined || b === null || b === undefined) continue;
    const interval = (b - a + 12) % 12;
    if (interval === 5 || interval === 4) up++;
    if (interval === 7 || interval === 8) down++;
  }
  return up > down;
}

/** How many dashes there are between the notes, usually: the most common gap. */
function stepOf(columns: number[]): number {
  const gaps = new Map<number, number>();
  for (let i = 1; i < columns.length; i++) {
    const gap = columns[i]! - columns[i - 1]!;
    if (gap > 0) gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
  }
  let best = 1;
  let count = 0;
  for (const [gap, n] of gaps) {
    if (n > count || (n === count && gap < best)) {
      best = gap;
      count = n;
    }
  }
  return best;
}

/** The note value and time signature for a bar of `steps` equal steps. */
function meterFor(steps: number): { duration: number; numerator: number; denominator: number } {
  if ([1, 2, 4, 8, 16, 32].includes(steps))
    return { duration: steps, numerator: 4, denominator: 4 };
  if (steps === 3 || steps === 5 || steps === 7) {
    return { duration: 4, numerator: steps, denominator: 4 };
  }
  if (steps === 6 || steps === 9 || steps === 12) {
    return { duration: 8, numerator: steps, denominator: 8 };
  }
  return { duration: 4, numerator: Math.min(steps, MAX_STEPS), denominator: 4 };
}

/** The alphaTex bars of one track, from its systems. */
function trackBars(
  systems: System[],
  flipped: boolean,
  strings: number,
  withTime: boolean,
  warnings: Set<string>,
): string[] {
  const tex: string[] = [];
  let meter = "";
  for (const system of systems) {
    if (system.techniques)
      warnings.add("Hammer-ons, slides, bends and other techniques were left out.");
    // Bar columns: the system's lines start and end at bar lines or at their content.
    const edges = [...new Set([system.start, ...system.bars, system.end + 1])].sort(
      (a, b) => a - b,
    );
    const ranges: [number, number][] = [];
    for (let i = 0; i + 1 < edges.length; i++) {
      // A bar starts after its bar line (the first one may be the start of the text itself).
      const from = system.bars.includes(edges[i]!) ? edges[i]! + 1 : edges[i]!;
      if (edges[i + 1]! - from >= 2) ranges.push([from, edges[i + 1]!]);
    }
    const step = stepOf([...new Set(system.hits.map((h) => h.col))].sort((a, b) => a - b));

    for (const [from, to] of ranges) {
      const inBar = system.hits.filter((h) => h.col >= from && h.col < to);
      if (inBar.length === 0 && ranges.length > 1) continue; // text between the bars
      const steps = Math.max(1, Math.min(MAX_STEPS, Math.round((to - from) / step)));
      const slots = new Map<number, Hit[]>();
      for (const hit of inBar) {
        const slot = Math.min(steps - 1, Math.floor((hit.col - from) / step + 0.0001));
        slots.set(slot, [...(slots.get(slot) ?? []), hit]);
      }
      const { duration, numerator, denominator } = meterFor(steps);
      const bar: string[] = [];
      const ts = `${numerator} ${denominator}`;
      if (ts !== meter) {
        // The first track sets the time signatures of the song.
        if (withTime) bar.push(`\\ts ${ts}`);
        meter = ts;
      }
      bar.push(`:${duration}`);
      for (let slot = 0; slot < steps; slot++) {
        const here = slots.get(slot);
        if (!here) {
          bar.push("r");
          continue;
        }
        const notes = [...new Map(here.map((h) => [h.string, h])).values()].map((h) => {
          const string = (flipped ? strings - 1 - h.string : h.string) + 1;
          let fret = h.fret;
          if (fret !== "x" && fret > MAX_FRET) {
            warnings.add(`Frets above ${MAX_FRET} were set to ${MAX_FRET}.`);
            fret = MAX_FRET;
          }
          return `${fret}.${string}`;
        });
        bar.push(notes.length === 1 ? notes[0]! : `(${notes.join(" ")})`);
      }
      tex.push(bar.join(" "));
      if (tex.length >= MAX_BARS) {
        warnings.add("The tab is very long: the end was cut off.");
        return tex;
      }
    }
  }
  return tex;
}

/** Builds a score from ASCII tab. Throws {@link ScoreLoadError} when the text has no tab. */
export function importAsciiTab(text: string): TextImport {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const warnings = new Set<string>();

  // Blocks of consecutive string lines are the systems of the tab.
  const systems: (System & { heading: string })[] = [];
  let block: string[] = [];
  let lastText = "";
  let ignored = 0;
  const closeBlock = () => {
    if (block.length >= 4 && block.length <= 8) {
      systems.push({ ...parseSystem(block), heading: lastText });
    } else if (block.length > 0) ignored += block.length;
    block = [];
  };
  for (const line of lines) {
    if (isStringLine(line)) block.push(line);
    else {
      closeBlock();
      if (line.trim()) lastText = line.trim();
    }
  }
  closeBlock();

  if (systems.length === 0) throw new ScoreLoadError("No tablature was found in this text.");
  if (ignored > 0) {
    warnings.add("Some lines that looked like tab were not 4 to 8 lines long and were left out.");
  }

  // One track per tuning: the string names tell tracks apart ("E A D G B E", "E A D G").
  const groups = new Map<string, (System & { heading: string })[]>();
  for (const system of systems) {
    const key = system.labels.map((l) => (l === null ? "?" : l)).join(",");
    groups.set(key, [...(groups.get(key) ?? []), system]);
  }

  if (systems.every((system) => system.hits.length === 0)) {
    throw new ScoreLoadError("No notes were found in the tablature.");
  }

  const tracks = [...groups.values()].slice(0, 16).map((group, index) => {
    const strings = group[0]!.labels.length;
    // Written from the lowest string up (E A D G B E)? Then the highest string goes on top.
    const flipped = isAscending(group[0]!.labels);
    const tuning = tuningFor(flipped ? [...group[0]!.labels].reverse() : group[0]!.labels);
    const heading = group[0]!.heading
      .replace(/\s*\(.*$/, "")
      .replace(/["\\]/g, "")
      .slice(0, 40);
    const name =
      heading && heading.length >= 2 && !/^[=\-_*#\s]+$/.test(heading)
        ? heading
        : strings === 4
          ? "Bass"
          : `Guitar${index > 0 ? ` ${index + 1}` : ""}`;
    return {
      name,
      strings,
      tuning,
      bars: trackBars(group, flipped, strings, index === 0, warnings),
    };
  });
  if (groups.size > tracks.length) warnings.add("Only the first 16 tracks were taken over.");

  const longest = Math.max(...tracks.map((t) => t.bars.length));
  if (longest === 0) throw new ScoreLoadError("No notes were found in the tablature.");

  const title = lines
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !isStringLine(l) && !/^[=\-_*#\s]+$/.test(l) && l.length <= 80);
  const parts = tracks.map((track) => {
    // Shorter tracks are filled up with rests, so every track has all the bars.
    const bars = [...track.bars];
    while (bars.length < longest) bars.push(":1 r");
    return [
      `\\track "${track.name}"`,
      "\\staff {score tabs}",
      `\\tuning (${track.tuning.map(texPitch).join(" ")})`,
      bars.join(" |\n") + " |",
    ].join("\n");
  });
  const source = [
    title ? `\\title "${title.replace(/["\\]/g, "")}"` : "",
    "\\tempo 100",
    ...parts,
  ].join("\n");

  let score: Score;
  try {
    score = importer.ScoreLoader.loadAlphaTex(source, new Settings());
  } catch (error) {
    throw new ScoreLoadError("The tablature could not be turned into a score.", { cause: error });
  }
  warnings.add(
    "Text tab has no rhythm: note lengths were guessed from the spacing and the tempo is set to 100 BPM.",
  );
  return { score, warnings: [...warnings] };
}
