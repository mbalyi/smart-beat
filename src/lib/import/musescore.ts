/**
 * MuseScore import (`.mscx`, and `.mscz` which is a ZIP holding one). Read
 * from the file format only: an XML document with the parts, their staves and
 * measures. Taken over: up to four voices (notes, chords, rests, durations,
 * dots), tuplets, ties, dynamics, the first verse of lyrics, repeats, time and
 * key signatures and tempo (MuseScore 3 and 4 files). Left out and listed in
 * the warnings: grace notes, volta endings, slurs, text and layout.
 * Guitar-like parts are written as tablature, the rest as a score. The notes
 * are written as alphaTex and read by alphaTab.
 */
import { importer, Settings, type model } from "@coderline/alphatab";

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

/** Voices a MuseScore staff can have (alphaTab draws up to four too). */
const MAX_VOICES = 4;

const DYNAMICS = new Set(["ppp", "pp", "p", "mp", "mf", "f", "ff", "fff"]);

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
    repeatStart: boolean;
    /** How often the bar's repeat is played (0: no repeat ends here). */
    repeatEnd: number;
  }
  const bars: BarInfo[] = [];
  let current: BarInfo = {
    numerator: 4,
    denominator: 4,
    key: 0,
    tempo: null,
    repeatStart: false,
    repeatEnd: 0,
  };
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
    const endRepeat = child(measure, "endRepeat");
    const times = Number(endRepeat?.textContent?.trim() || 2);
    bars.push({
      ...current,
      tempo: bpm && Number.isFinite(bpm) && bpm >= 10 && bpm <= 400 ? bpm : null,
      repeatStart: child(measure, "startRepeat") !== null,
      repeatEnd: endRepeat ? Math.min(Math.max(Number.isFinite(times) ? times : 2, 2), 32) : 0,
    });
    if (
      child(voice, "Volta") ||
      children(voice, "Spanner").some((sp) => sp.getAttribute("type") === "Volta")
    ) {
      warnings.add("Volta endings (1st and 2nd time bars) were left out.");
    }
  }
  if (firstMeasures.length >= MAX_BARS)
    warnings.add("The score is very long: the end was cut off.");

  // --- Notes ------------------------------------------------------------------
  const tracks: string[] = [];
  /** Per track: the lyric syllable of each beat of voice 1, bar by bar (null: none). */
  const lyricsByTrack: (string | null)[][][] = [];
  /** Per track and voice: the bars that voice has no music in (left empty). */
  const emptyByTrack: Set<number>[][] = [];

  staves.forEach((staff, staffIndex) => {
    const measures = children(byId.get(staff.id), "Measure");
    let tab = staff.tuning !== null;
    const voiceCount = Math.min(
      MAX_VOICES,
      Math.max(1, ...measures.slice(0, bars.length).map((m) => children(m, "voice").length)),
    );
    if (measures.some((m) => children(m, "voice").length > MAX_VOICES)) {
      warnings.add(`Only the first ${MAX_VOICES} voices of each staff were taken over.`);
    }
    const voicesOut: string[][] = Array.from({ length: voiceCount }, () => []);
    const lyrics: (string | null)[][] = [];
    const empty: Set<number>[] = Array.from({ length: voiceCount }, () => new Set());

    for (let v = 0; v < voiceCount; v++) {
      /** MuseScore 3 tuplets are defined once and referred to by id. */
      const tupletIds = new Map<string, number>();
      /** Pitches whose tie continues into the next chord. */
      let tied = new Set<number>();
      let dynamic: string | null = null;
      let lastDuration = "";

      bars.forEach((_bar, index) => {
        const content = children(measures[index], "voice")[v];
        const barTex: string[] = [];
        const barLyrics: (string | null)[] = [];
        let tuplet: number | null = null;
        let beats = 0;
        for (const item of Array.from(content?.children ?? [])) {
          if (item.tagName === "Tuplet") {
            const actual = Number(text(item, "actualNotes"));
            const id = item.getAttribute("id");
            if (Number.isFinite(actual) && actual > 1) {
              if (id !== null)
                tupletIds.set(id, actual); // MuseScore 3
              else tuplet = actual; // MuseScore 4: the chords up to <endTuplet/>
            }
            continue;
          }
          if (item.tagName === "endTuplet") {
            tuplet = null;
            continue;
          }
          if (item.tagName === "Dynamic") {
            const subtype = text(item, "subtype");
            if (subtype && DYNAMICS.has(subtype)) dynamic = subtype;
            else warnings.add("Some dynamics (sfz, fp…) were left out.");
            continue;
          }
          if (item.tagName !== "Chord" && item.tagName !== "Rest") {
            if (["Slur", "StaffText", "Fermata", "Harmony"].includes(item.tagName)) {
              warnings.add("Slurs, text, fermatas and chord symbols were left out.");
            }
            continue;
          }
          if (
            item.tagName === "Chord" &&
            (child(item, "acciaccatura") || child(item, "appoggiatura"))
          ) {
            warnings.add("Grace notes were left out.");
            continue;
          }
          const type = text(item, "durationType");
          const whole = type === "measure";
          const duration = whole ? null : DURATIONS[type ?? ""];
          if (!whole && duration === undefined) {
            warnings.add("Notes of an unknown length were left out.");
            continue;
          }
          const dots = Number(text(item, "dots") ?? 0);
          const effects: string[] = [];
          if (dots >= 2) effects.push("dd");
          else if (dots === 1) effects.push("d");
          const ownTuplet = text(item, "Tuplet");
          const tupletOf = ownTuplet !== null ? tupletIds.get(ownTuplet) : tuplet;
          if (tupletOf) effects.push(`tu ${tupletOf}`);
          if (dynamic) {
            effects.push(`dy ${dynamic}`);
            dynamic = null;
          }
          const mark = effects.length > 0 ? ` {${effects.join(" ")}}` : "";
          const head = whole ? ":1" : `:${duration}`;
          const prefix = head === lastDuration ? "" : `${head} `;
          lastDuration = head;
          if (item.tagName === "Rest") {
            barTex.push(`${prefix}r${mark}`);
            barLyrics.push(null);
            beats++;
            continue;
          }
          const noteNodes = children(item, "Note").filter((n) => {
            const pitch = Number(text(n, "pitch"));
            return Number.isFinite(pitch) && pitch >= 0 && pitch <= 127;
          });
          const pitches = noteNodes.map((n) => Number(text(n, "pitch")));
          if (pitches.length === 0) continue;

          // Ties: MuseScore 4 writes <Spanner type="Tie"> with <next>/<prev>,
          // MuseScore 3 <Tie> on the first note and <endSpanner> on the second.
          const tieStart = (n: Element) =>
            child(n, "Tie") !== null ||
            children(n, "Spanner").some(
              (sp) => sp.getAttribute("type") === "Tie" && child(sp, "next"),
            );
          const tieEnd = (n: Element, pitch: number) =>
            tied.has(pitch) ||
            children(n, "Spanner").some(
              (sp) => sp.getAttribute("type") === "Tie" && child(sp, "prev"),
            );
          const tiedHere = new Set(
            noteNodes.flatMap((n, i) => (tieEnd(n, pitches[i]!) ? [pitches[i]!] : [])),
          );
          tied = new Set(noteNodes.flatMap((n, i) => (tieStart(n) ? [pitches[i]!] : [])));
          const tie = (pitch: number) => (tiedHere.has(pitch) ? "{t}" : "");

          let notes: string[];
          const placed = tab ? placeOnStrings(staff.tuning!, pitches) : null;
          if (tab && !placed) {
            // A note that doesn't fit the instrument: this staff is written as a score.
            warnings.add(
              `“${staff.name}” has notes outside its strings and is written as a score.`,
            );
            tab = false;
          }
          if (tab && placed) {
            const sorted = [...pitches].sort((a, b) => b - a); // placeOnStrings works high to low
            notes = placed.map((p, i) => `${p.fret}.${p.string}${tie(sorted[i]!)}`);
          } else {
            notes = pitches.map((p) => `${texPitch(p)}${tie(p)}`);
          }
          const token = notes.length === 1 ? notes[0]! : `(${notes.join(" ")})`;
          barTex.push(`${prefix}${token}${mark}`);
          beats++;

          // The first verse of lyrics (voice 1 only, as alphaTab shows them).
          const lyric = children(item, "Lyrics").find((l) => (Number(text(l, "no")) || 0) === 0);
          const syllable = text(lyric, "text");
          const syllabic = text(lyric, "syllabic");
          barLyrics.push(
            syllable
              ? syllabic === "begin" || syllabic === "middle"
                ? `${syllable}-`
                : syllable
              : null,
          );
          if (children(item, "Lyrics").length > 1)
            warnings.add("Only the first verse of lyrics was taken over.");
        }
        if (beats === 0) {
          barTex.push(`${lastDuration === ":1" ? "" : ":1 "}r`); // nothing in this bar
          lastDuration = ":1";
          barLyrics.push(null);
          if (v > 0) empty[v]!.add(index);
        }
        voicesOut[v]!.push(barTex.join(" "));
        if (v === 0) lyrics.push(barLyrics);
      });
    }

    const head: string[] = [];
    if (staffIndex === 0) {
      // The first track sets the song's meter, key, tempo and repeats.
      head.push(`\\tempo ${bars[0]!.tempo ?? 120}`);
    }
    const voiceTex = voicesOut.map(
      (voiceBars, v) =>
        voiceBars
          .map((barTex, index) => {
            if (staffIndex !== 0 || v !== 0) return barTex;
            const bar = bars[index]!;
            const previous = bars[index - 1];
            const marks: string[] = [];
            if (bar.repeatStart) marks.push("\\ro");
            if (bar.repeatEnd > 0) marks.push(`\\rc ${bar.repeatEnd}`);
            if (
              !previous ||
              previous.numerator !== bar.numerator ||
              previous.denominator !== bar.denominator
            ) {
              marks.push(`\\ts ${bar.numerator} ${bar.denominator}`);
            }
            if (!previous || previous.key !== bar.key) marks.push(`\\ks ${KEYS[bar.key] ?? "C"}`);
            if (previous && bar.tempo && bar.tempo !== previous.tempo) {
              marks.push(`\\tempo ${bar.tempo}`);
            }
            return [...marks, barTex].join(" ");
          })
          .join(" |\n") + " |",
    );
    const tuningLine = tab ? `\\tuning (${staff.tuning!.map(texPitch).join(" ")})` : "";
    tracks.push(
      [
        ...head,
        `\\track "${staff.name.replace(/["\\]/g, "")}"`,
        tab ? "\\staff {score tabs}" : "\\staff {score}",
        tuningLine,
        voiceTex.join("\n\\voice\n"),
      ]
        .filter(Boolean)
        .join("\n"),
    );
    lyricsByTrack.push(lyrics);
    emptyByTrack.push(empty);
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
  placeLyricsAndEmptyBars(result, lyricsByTrack, emptyByTrack);
  return { score: result, warnings: [...warnings] };
}

/**
 * Puts the lyrics on their beats (alphaTex would hand them out to every
 * note, also the ones without a syllable) and empties the bars a voice has
 * no music in (alphaTex needs a rest there).
 */
function placeLyricsAndEmptyBars(
  score: Score,
  lyricsByTrack: (string | null)[][][],
  emptyByTrack: Set<number>[][],
) {
  score.tracks.forEach((track, t) => {
    const staff = track.staves[0];
    if (!staff) return;
    staff.bars.forEach((bar, b) => {
      const syllables = lyricsByTrack[t]?.[b] ?? [];
      bar.voices[0]?.beats.forEach((beat: model.Beat, i) => {
        const syllable = syllables[i];
        if (syllable) beat.lyrics = [syllable];
      });
      bar.voices.forEach((voice, v) => {
        if (!emptyByTrack[t]?.[v]?.has(b)) return;
        for (const beat of voice.beats) beat.isEmpty = true;
      });
    });
  });
}

/** Reads a `.mscx` or `.mscz` file. */
export async function importMuseScore(bytes: Uint8Array): Promise<MuseScoreImport> {
  return importMuseScoreXml(await museScoreXml(bytes));
}
