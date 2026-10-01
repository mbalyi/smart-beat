/**
 * MuseScore import (`.mscx`, and `.mscz` which is a ZIP holding one). Read
 * from the file format only: an XML document with the parts, their staves and
 * measures. First voices are taken over (notes, chords, rests, durations,
 * dots, time and key signatures, tempo); everything else (tuplets, ties,
 * grace notes, repeats, dynamics, lyrics...) is left out and listed in the
 * warnings. Guitar-like parts are written as tablature, the rest as a score.
 * The notes are written as alphaTex and read by alphaTab.
 */
import { importer, Settings } from "@coderline/alphatab";

import { listZip, readZipEntry } from "@/lib/import/zip";
import { ScoreLoadError } from "@/lib/score/errors";
import type { Score } from "@/lib/score/model";
import { MAX_FRET } from "@/lib/score/music";

export interface MuseScoreImport {
  score: Score;
  warnings: string[];
}

const MAX_BARS = 2000;

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const texPitch = (midi: number) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

/** alphaTex key signature names, from the number of sharps (positive) or flats (negative). */
const KEYS: Record<number, string> = {
  [-7]: "Cb",
  [-6]: "Gb",
  [-5]: "Db",
  [-4]: "Ab",
  [-3]: "Eb",
  [-2]: "Bb",
  [-1]: "F",
  0: "C",
  1: "G",
  2: "D",
  3: "A",
  4: "E",
  5: "B",
  6: "F#",
  7: "C#",
};

const DURATIONS: Record<string, number> = {
  whole: 1,
  half: 2,
  quarter: 4,
  eighth: 8,
  "16th": 16,
  "32nd": 32,
  "64th": 64,
};

const child = (element: Element | null | undefined, name: string) =>
  element ? (Array.from(element.children).find((c) => c.tagName === name) ?? null) : null;
const children = (element: Element | null | undefined, name: string) =>
  element ? Array.from(element.children).filter((c) => c.tagName === name) : [];
const text = (element: Element | null | undefined, name: string) =>
  child(element, name)?.textContent?.trim() ?? null;

/** The XML of a MuseScore file: the `.mscx` itself, or the one inside an `.mscz` archive. */
export async function museScoreXml(bytes: Uint8Array): Promise<string> {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) return new TextDecoder().decode(bytes);
  const entries = listZip(bytes);
  const entry = entries.find((e) => e.name.toLowerCase().endsWith(".mscx"));
  if (!entry) throw new ScoreLoadError("The archive has no MuseScore score in it.");
  return new TextDecoder().decode(await readZipEntry(bytes, entry));
}

interface Staff {
  /** Staff number in the file (`<Staff id>`). */
  id: number;
  name: string;
  /** Guitar-like: its strings (highest first), or null. */
  tuning: number[] | null;
}

/** Where to play a pitch on a string instrument: the lowest fret that is free, else the nearest string. */
function placeOnStrings(
  tuning: readonly number[],
  pitches: number[],
): { string: number; fret: number }[] | null {
  const used = new Set<number>();
  const placed: { string: number; fret: number }[] = [];
  for (const pitch of [...pitches].sort((a, b) => b - a)) {
    let best = -1;
    let bestFret = Infinity;
    tuning.forEach((open, i) => {
      const fret = pitch - open;
      if (fret >= 0 && fret <= MAX_FRET && !used.has(i) && fret < bestFret) {
        best = i;
        bestFret = fret;
      }
    });
    if (best < 0) return null;
    used.add(best);
    placed.push({ string: best + 1, fret: bestFret });
  }
  return placed;
}

/** Builds a score from MuseScore XML. Throws {@link ScoreLoadError} when it can't be read. */
export function importMuseScoreXml(xml: string): MuseScoreImport {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror"))
    throw new ScoreLoadError("The MuseScore file is not valid XML.");
  const score = doc.querySelector("museScore > Score") ?? doc.querySelector("Score");
  if (!score) throw new ScoreLoadError("This is not a MuseScore score.");
  const warnings = new Set<string>();

  // --- Parts and their staves ---------------------------------------------------
  const staves: Staff[] = [];
  for (const part of children(score, "Part")) {
    const instrument = child(part, "Instrument");
    const partName =
      text(part, "trackName") ??
      text(instrument, "trackName") ??
      text(instrument, "longName") ??
      "";
    const strings = children(child(instrument, "StringData"), "string").map((s) =>
      Number(s.textContent),
    );
    // MuseScore lists the strings from the lowest; Smart Beat from the highest.
    const tuning =
      strings.length >= 4 && strings.every(Number.isFinite) ? [...strings].reverse() : null;
    const ids = children(part, "Staff").map((s) => Number(s.getAttribute("id")));
    ids.forEach((id, i) => {
      staves.push({
        id,
        name:
          ids.length > 1
            ? `${partName || "Part"} ${i + 1}`
            : partName || `Track ${staves.length + 1}`,
        tuning,
      });
    });
  }
  if (staves.length === 0) throw new ScoreLoadError("The MuseScore file has no parts.");

  // --- Measures: the first staff sets the time signatures, keys and tempos -----------
  const staffNodes = children(score, "Staff");
  const byId = new Map(staffNodes.map((node) => [Number(node.getAttribute("id")), node]));
  const firstMeasures = children(byId.get(staves[0]!.id) ?? staffNodes[0], "Measure").slice(
    0,
    MAX_BARS,
  );
  if (firstMeasures.length === 0) throw new ScoreLoadError("The MuseScore file has no measures.");

  interface BarInfo {
    numerator: number;
    denominator: number;
    key: number;
    tempo: number | null;
  }
  const bars: BarInfo[] = [];
  let current: BarInfo = { numerator: 4, denominator: 4, key: 0, tempo: null };
  for (const measure of firstMeasures) {
    const voice = child(measure, "voice");
    const sig = child(voice, "TimeSig");
    if (sig) {
      current = {
        ...current,
        numerator: Number(text(sig, "sigN")) || current.numerator,
        denominator: Number(text(sig, "sigD")) || current.denominator,
      };
    }
    const keySig = child(voice, "KeySig");
    const fifths = Number(text(keySig, "accidental") ?? text(keySig, "concertKey"));
    if (keySig && Number.isFinite(fifths) && KEYS[fifths] !== undefined) {
      current = { ...current, key: fifths };
    }
    const tempoNode = child(voice, "Tempo");
    // MuseScore stores the tempo in quarter notes per second.
    const bpm = tempoNode ? Math.round(Number(text(tempoNode, "tempo")) * 60) : null;
    bars.push({
      ...current,
      tempo: bpm && Number.isFinite(bpm) && bpm >= 10 && bpm <= 400 ? bpm : null,
    });
  }
  if (firstMeasures.length >= MAX_BARS)
    warnings.add("The score is very long: the end was cut off.");

  // --- Notes ------------------------------------------------------------------
  const tracks: string[] = [];
  staves.forEach((staff, staffIndex) => {
    const measures = children(byId.get(staff.id), "Measure");
    let tab = staff.tuning !== null;
    const notesOut: string[][] = [];

    bars.forEach((_bar, index) => {
      const measure = measures[index];
      const voices = children(measure, "voice");
      if (voices.length > 1) warnings.add("Only the first voice of each staff was taken over.");
      const content = voices[0];
      const barTex: string[] = [];
      let lastDuration = "";
      let beats = 0;
      for (const item of Array.from(content?.children ?? [])) {
        if (item.tagName !== "Chord" && item.tagName !== "Rest") {
          if (
            ["Tuplet", "Spanner", "Dynamic", "Slur", "Lyrics", "StaffText", "Fermata"].includes(
              item.tagName,
            )
          ) {
            warnings.add("Tuplets, slurs, dynamics, lyrics and text were left out.");
          }
          continue;
        }
        if (item.tagName === "Chord" && child(item, "acciaccatura")) {
          warnings.add("Grace notes were left out.");
          continue;
        }
        if (child(item, "Tuplet") || children(item, "Tuplet").length)
          warnings.add("Tuplets were written with their plain note values.");
        const type = text(item, "durationType");
        const whole = type === "measure";
        const duration = whole ? null : DURATIONS[type ?? ""];
        if (!whole && duration === undefined) {
          warnings.add("Notes of an unknown length were left out.");
          continue;
        }
        const dots = Number(text(item, "dots") ?? 0);
        const mark = dots >= 2 ? " {dd}" : dots === 1 ? " {d}" : "";
        const head = whole ? ":1" : `:${duration}`;
        const prefix = head === lastDuration ? "" : `${head} `;
        lastDuration = head;
        if (item.tagName === "Rest") {
          barTex.push(`${prefix}r${mark}`);
          beats++;
          continue;
        }
        const pitches = children(item, "Note")
          .map((n) => Number(text(n, "pitch")))
          .filter((p) => Number.isFinite(p) && p >= 0 && p <= 127);
        if (pitches.length === 0) continue;
        if (children(item, "Note").some((n) => child(n, "Tie") || child(n, "Spanner"))) {
          warnings.add("Ties were written as separate notes.");
        }
        let token: string;
        const placed = tab ? placeOnStrings(staff.tuning!, pitches) : null;
        if (tab && !placed) {
          // A note that doesn't fit the instrument: this staff is written as a score.
          warnings.add(`“${staff.name}” has notes outside its strings and is written as a score.`);
          tab = false;
          token =
            pitches.length === 1 ? texPitch(pitches[0]!) : `(${pitches.map(texPitch).join(" ")})`;
        } else if (placed) {
          const notes = placed.map((p) => `${p.fret}.${p.string}`);
          token = notes.length === 1 ? notes[0]! : `(${notes.join(" ")})`;
        } else {
          token =
            pitches.length === 1 ? texPitch(pitches[0]!) : `(${pitches.map(texPitch).join(" ")})`;
        }
        barTex.push(`${prefix}${token}${mark}`);
        beats++;
      }
      if (beats === 0) barTex.push(":1 r"); // an empty measure
      notesOut.push(barTex);
    });

    const head: string[] = [];
    if (staffIndex === 0) {
      // The first track sets the song's meter, key and tempo.
      head.push(`\\tempo ${bars[0]!.tempo ?? 120}`);
    }
    const barsTex = notesOut.map((barTex, index) => {
      const bar = bars[index]!;
      const previous = bars[index - 1];
      const marks: string[] = [];
      if (staffIndex === 0) {
        if (
          !previous ||
          previous.numerator !== bar.numerator ||
          previous.denominator !== bar.denominator
        ) {
          marks.push(`\\ts ${bar.numerator} ${bar.denominator}`);
        }
        if (!previous || previous.key !== bar.key) marks.push(`\\ks ${KEYS[bar.key] ?? "C"}`);
        if (previous && bar.tempo && bar.tempo !== previous.tempo)
          marks.push(`\\tempo ${bar.tempo}`);
      }
      return [...marks, ...barTex].join(" ");
    });
    const tuningLine = tab ? `\\tuning (${staff.tuning!.map(texPitch).join(" ")})` : "";
    tracks.push(
      [
        ...head,
        `\\track "${staff.name.replace(/["\\]/g, "")}"`,
        tab ? "\\staff {score tabs}" : "\\staff {score}",
        tuningLine,
        barsTex.join(" |\n") + " |",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  });

  const work = Array.from(score.querySelectorAll("metaTag")).find(
    (t) => t.getAttribute("name") === "workTitle",
  );
  const composer = Array.from(score.querySelectorAll("metaTag")).find(
    (t) => t.getAttribute("name") === "composer",
  );
  const source = [
    work?.textContent?.trim() ? `\\title "${work.textContent.trim().replace(/["\\]/g, "")}"` : "",
    composer?.textContent?.trim()
      ? `\\artist "${composer.textContent.trim().replace(/["\\]/g, "")}"`
      : "",
    ...tracks,
  ]
    .filter(Boolean)
    .join("\n");

  let result: Score;
  try {
    result = importer.ScoreLoader.loadAlphaTex(source, new Settings());
  } catch (error) {
    throw new ScoreLoadError("The MuseScore file could not be turned into a score.", {
      cause: error,
    });
  }
  warnings.add(
    "MuseScore files are read from their notes only: repeats, ties, tuplets, dynamics, lyrics and layout are not taken over.",
  );
  return { score: result, warnings: [...warnings] };
}

/** Reads a `.mscx` or `.mscz` file. */
export async function importMuseScore(bytes: Uint8Array): Promise<MuseScoreImport> {
  return importMuseScoreXml(await museScoreXml(bytes));
}
