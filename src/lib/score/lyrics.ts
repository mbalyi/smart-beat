/**
 * Lyrics, as Guitar Pro 5 has them: up to five lines per track, each starting
 * at a bar, whose syllables flow onto the notes of voice 1 (rests are
 * skipped). Syntax: spaces and hyphens separate syllables ("Hel-lo world"),
 * `+` keeps words on one note ("of+the"), an extra space skips a note and
 * `[…]` is a comment.
 *
 * alphaTab only keeps the result (each beat's `lyrics`). Smart Beat keeps the
 * lines themselves on the track too, so the syllables flow again after notes
 * are added or removed: {@link reflowLyrics} runs after every change (see
 * `refinish`). The lines are an own property of the track, so undo snapshots
 * of the track include them.
 */
import { model } from "@coderline/alphatab";

import type { Beat, Track } from "@/lib/score/model";

export const MAX_LYRIC_LINES = 5;

export interface LyricLine {
  /** 0-based bar the line starts at. */
  startBar: number;
  text: string;
}

/** The track property holding the lines (not part of alphaTab's model). */
const LINES_KEY = "smartBeatLyrics";

type WithLines = { [LINES_KEY]?: readonly LyricLine[] | null };

/** The lines kept on the track, or null when its lyrics were never set in Smart Beat. */
export function storedLyrics(track: Track): readonly LyricLine[] | null {
  return (track as unknown as WithLines)[LINES_KEY] ?? null;
}

/** Beats syllables go on, from `startBar` on: voice 1, not rests. */
function* lyricBeats(track: Track, startBar = 0): Generator<Beat> {
  const staff = track.staves[0];
  for (const bar of staff?.bars.slice(startBar) ?? []) {
    for (const beat of bar.voices[0]?.beats ?? []) {
      if (!beat.isEmpty && !beat.isRest) yield beat;
    }
  }
}

/** A syllable as it is typed: "+" for spaces inside it. */
const typed = (chunk: string) => chunk.replaceAll(" ", "+");

/**
 * Rebuilds the lines from the syllables on the beats (for files, whose
 * lyrics alphaTab has already spread over the notes).
 */
export function lyricsFromBeats(track: Track): LyricLine[] {
  const beats = [...lyricBeats(track)];
  const lineCount = Math.max(0, ...beats.map((beat) => beat.lyrics?.length ?? 0));
  return Array.from({ length: lineCount }, (_, line) => {
    const chunks = beats.map((beat) => beat.lyrics?.[line] ?? "");
    const first = chunks.findIndex((chunk) => chunk !== "");
    if (first < 0) return { startBar: 0, text: "" };
    const startBar = beats[first]!.voice.bar.index;
    // Syllables start on the first note of the start bar.
    const start = beats.findIndex((beat) => beat.voice.bar.index === startBar);
    const last = chunks.findLastIndex((chunk) => chunk !== "");
    let text = "";
    chunks.slice(start, last + 1).forEach((chunk, i) => {
      const previous = i > 0 ? chunks[start + i - 1]! : null;
      if (previous !== null && !previous.endsWith("-")) text += " ";
      text += typed(chunk);
    });
    return { startBar, text };
  });
}

/** The track's lines: the ones set in Smart Beat, or those read from the file. */
export function lyricsOf(track: Track): LyricLine[] {
  return (storedLyrics(track) ?? lyricsFromBeats(track)).map((line) => ({ ...line }));
}

export const hasLyrics = (track: Track) => lyricsOf(track).some((line) => line.text.trim() !== "");

/** Syllables a line puts on notes (comments dropped, "+" joined). */
export function syllableCount(text: string): number {
  const lyrics = new model.Lyrics();
  lyrics.text = text;
  lyrics.finish();
  return lyrics.chunks.length;
}

/**
 * Sets the track's lyrics (at most {@link MAX_LYRIC_LINES} lines; empty lines
 * at the end are dropped). The syllables are placed by {@link reflowLyrics}.
 */
export function setLyrics(track: Track, lines: readonly LyricLine[]): void {
  const kept = lines.slice(0, MAX_LYRIC_LINES).map((line) => ({
    startBar: Math.max(0, Math.floor(line.startBar)),
    text: line.text,
  }));
  while (kept.length > 0 && kept.at(-1)!.text.trim() === "") kept.pop();
  (track as unknown as WithLines)[LINES_KEY] = kept;
}

/**
 * Takes over the lyrics of a file's (or a new) track, so they follow later
 * edits: placing them again gives the same result as the file. Tracks without
 * lyrics get an explicit "none", so undo can always restore the property.
 */
export function adoptLyrics(track: Track): void {
  const holder = track as unknown as WithLines;
  if (LINES_KEY in holder) return;
  const lines = lyricsFromBeats(track);
  holder[LINES_KEY] = lines.some((line) => line.text !== "") ? lines : null;
}

/**
 * Places the stored lines' syllables on the notes again (clearing what was
 * there; "no lyrics" clears them all). Tracks Smart Beat never took over are
 * left alone. Needs a finished model (beats linked to the next beat).
 */
export function reflowLyrics(track: Track): void {
  if (!(LINES_KEY in track)) return;
  const lines = storedLyrics(track) ?? [];
  const staff = track.staves[0];
  for (const bar of staff?.bars ?? []) {
    for (const beat of bar.voices[0]?.beats ?? []) beat.lyrics = null;
  }
  if (lines.length === 0) return;
  track.applyLyrics(
    lines.map((line) => {
      const lyrics = new model.Lyrics();
      lyrics.startBar = line.startBar;
      lyrics.text = line.text;
      return lyrics;
    }),
  );
}

/** One syllable of a lyric line as the lyrics strip shows it. */
export interface Syllable {
  text: string;
  /** The beat it is sung on. */
  beat: Beat;
  /** The next syllable belongs to the same word (this one ends with "-"). */
  joined: boolean;
}

/**
 * The syllables of each lyric line around a beat: those of its bar and the
 * next one, so the strip shows the current phrase. Empty lines are left out.
 */
export function syllablesAround(track: Track, beat: Beat): Syllable[][] {
  const barIndex = beat.voice.bar.index;
  const beats = [...lyricBeats(track, barIndex)].filter((b) => b.voice.bar.index <= barIndex + 1);
  const lineCount = Math.max(0, ...beats.map((b) => b.lyrics?.length ?? 0));
  const lines: Syllable[][] = [];
  for (let line = 0; line < lineCount; line++) {
    const syllables = beats
      .filter((b) => (b.lyrics?.[line] ?? "") !== "")
      .map((b) => {
        const text = b.lyrics![line]!;
        return { text: text.replace(/-$/, ""), beat: b, joined: text.endsWith("-") };
      });
    if (syllables.length > 0) lines.push(syllables);
  }
  return lines;
}
