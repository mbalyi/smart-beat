/**
 * The MIDI editor's geometry (pure): which pitch each row shows, where a note sits on screen, what
 * is under the pointer, and the note edits a drag makes. Times are timeline ms; notes keep ms
 * from their clip start.
 */
import { noteName } from "@/lib/audio-lanes/midi-edit";
import { noteEnd, sortNotes, MIN_NOTE_MS } from "@/lib/audio-lanes/midi";
import { DRUM_MIDI_MAP, MAIN_KIT } from "@/lib/score/drum-map";
import type { MidiNote } from "@/lib/tauri";

/** Rows of the editor, top to bottom, as pitches. */
export type Rows = readonly number[];

/** Every key from the top (127) to the bottom (0). */
export const PIANO_ROWS: Rows = Array.from({ length: 128 }, (_, i) => 127 - i);

/** A key is a black key of the piano. */
export const isBlackKey = (pitch: number): boolean => [1, 3, 6, 8, 10].includes(pitch % 12);

/**
 * The drum grid's rows: the main kit first in the drum picker's order, then the other drums,
 * then any other pitch the notes use. `hideUnused` keeps only the pitches the notes play (and
 * named pads). `names` overrides the row names (a pad bank's pads).
 */
export function drumRows(
  used: ReadonlySet<number>,
  hideUnused: boolean,
  names: Readonly<Record<number, string>> = {},
  order: readonly number[] = [],
): number[] {
  const base = [
    ...order,
    ...Object.keys(names).map(Number),
    ...MAIN_KIT,
    ...Object.keys(DRUM_MIDI_MAP).map(Number),
    ...[...used].sort((a, b) => b - a),
  ];
  const seen = new Set<number>();
  const rows = base.filter((p) => {
    if (seen.has(p) || p < 0 || p > 127) return false;
    seen.add(p);
    return true;
  });
  return hideUnused ? rows.filter((p) => used.has(p) || names[p] !== undefined) : rows;
}

/** A row's name: the pad or drum name on a drum grid, the note name on the piano. */
export function rowName(
  pitch: number,
  drums: boolean,
  names: Readonly<Record<number, string>> = {},
): string {
  if (names[pitch]) return names[pitch]!;
  return drums ? (DRUM_MIDI_MAP[pitch] ?? `Note ${pitch}`) : noteName(pitch);
}

/** Where the editor is scrolled and how far it is zoomed. */
export interface View {
  /** Timeline ms at x = 0. */
  originMs: number;
  pxPerMs: number;
  rowHeight: number;
  rows: Rows;
}

export const xOf = (view: View, ms: number): number => (ms - view.originMs) * view.pxPerMs;
export const msAt = (view: View, x: number): number => view.originMs + x / view.pxPerMs;

/** The row index of a pitch (-1: not shown). */
export const rowOf = (view: View, pitch: number): number => view.rows.indexOf(pitch);

/** The pitch of the row at `y` (null: below the last row). */
export function pitchAt(view: View, y: number): number | null {
  const index = Math.floor(y / view.rowHeight);
  return index >= 0 && index < view.rows.length ? view.rows[index]! : null;
}

/** A note's box on screen (null when its row is not shown). */
export function noteBox(
  view: View,
  clipStartMs: number,
  note: MidiNote,
): { x: number; y: number; w: number; h: number } | null {
  const row = rowOf(view, note.pitch);
  if (row < 0) return null;
  const x = xOf(view, clipStartMs + note.startMs);
  return {
    x,
    y: row * view.rowHeight,
    w: Math.max(4, note.lenMs * view.pxPerMs),
    h: view.rowHeight,
  };
}

/** What part of a note the pointer is on. */
export type NotePart = "body" | "end" | "top";

/** Pixels of a note's right edge that resize it, and of its top that change its velocity. */
const EDGE_PX = 5;
const TOP_PX = 3;

/** The note under a point, topmost (last drawn) first, and which part of it. */
export function hitNote(
  view: View,
  clipStartMs: number,
  notes: readonly MidiNote[],
  x: number,
  y: number,
): { id: string; part: NotePart } | null {
  for (let i = notes.length - 1; i >= 0; i--) {
    const note = notes[i]!;
    const box = noteBox(view, clipStartMs, note);
    if (!box || x < box.x || x > box.x + box.w || y < box.y || y > box.y + box.h) continue;
    const part: NotePart =
      x > box.x + box.w - EDGE_PX && box.w > EDGE_PX * 2
        ? "end"
        : y < box.y + TOP_PX
          ? "top"
          : "body";
    return { id: note.id, part };
  }
  return null;
}

/** Notes whose box meets a rectangle (marquee selection). */
export function notesInRect(
  view: View,
  clipStartMs: number,
  notes: readonly MidiNote[],
  rect: { x0: number; y0: number; x1: number; y1: number },
): string[] {
  const [left, right] = [Math.min(rect.x0, rect.x1), Math.max(rect.x0, rect.x1)];
  const [top, bottom] = [Math.min(rect.y0, rect.y1), Math.max(rect.y0, rect.y1)];
  return notes
    .filter((n) => {
      const box = noteBox(view, clipStartMs, n);
      return box && box.x < right && box.x + box.w > left && box.y < bottom && box.y + box.h > top;
    })
    .map((n) => n.id);
}

/** A drag in the editor, worked out as a change of the notes. */
export type NoteDrag =
  | { kind: "move"; ids: readonly string[]; deltaMs: number; deltaRows: number }
  | { kind: "resize"; ids: readonly string[]; deltaMs: number }
  | { kind: "velocity"; ids: readonly string[]; delta: number };

/**
 * The notes after a drag. Moving goes by rows (so a drum grid moves to the next drum row, not
 * the next pitch) and keeps notes inside the clip; a note pushed off the rows stays on its row.
 */
export function dragNotes(
  notes: readonly MidiNote[],
  drag: NoteDrag,
  rows: Rows,
  clipMs: number,
): MidiNote[] {
  const ids = new Set(drag.ids);
  return sortNotes(
    notes.map((n) => {
      if (!ids.has(n.id)) return n;
      switch (drag.kind) {
        case "move": {
          const row = rows.indexOf(n.pitch);
          const target = rows[row + drag.deltaRows];
          const startMs = Math.min(Math.max(0, n.startMs + drag.deltaMs), clipMs - MIN_NOTE_MS);
          // A moved note is placed by hand: its played timing no longer applies.
          const rest = { ...n };
          delete rest.rawStartMs;
          delete rest.rawLenMs;
          return { ...rest, startMs, pitch: row >= 0 && target !== undefined ? target : n.pitch };
        }
        case "resize": {
          const rest = { ...n };
          delete rest.rawLenMs;
          return {
            ...rest,
            lenMs: Math.min(Math.max(MIN_NOTE_MS, n.lenMs + drag.deltaMs), clipMs - n.startMs),
          };
        }
        case "velocity":
          return { ...n, vel: Math.min(127, Math.max(1, Math.round(n.vel + drag.delta))) };
      }
    }),
  );
}

/** The notes that sound at a clip time (for "split at cursor" and step input). */
export const notesAt = (notes: readonly MidiNote[], ms: number): MidiNote[] =>
  notes.filter((n) => n.startMs <= ms && noteEnd(n) > ms);

/** Notes split at a clip time: each note crossing it becomes two. */
export function splitNotesAt(
  notes: readonly MidiNote[],
  ms: number,
  ids: ReadonlySet<string> | null,
  freshId: () => string,
): MidiNote[] {
  return sortNotes(
    notes.flatMap((n) => {
      if ((ids && !ids.has(n.id)) || !(n.startMs < ms && noteEnd(n) > ms)) return [n];
      return [
        { ...n, lenMs: ms - n.startMs },
        { ...n, id: freshId(), startMs: ms, lenMs: noteEnd(n) - ms },
      ];
    }),
  );
}

/** Selected notes of one pitch that touch or overlap become one note (join). */
export function joinNotes(notes: readonly MidiNote[], ids: ReadonlySet<string>): MidiNote[] {
  const sorted = sortNotes(notes);
  const out: MidiNote[] = [];
  for (const n of sorted) {
    const last = [...out].reverse().find((m) => m.pitch === n.pitch && m.chan === n.chan);
    if (last && ids.has(n.id) && ids.has(last.id) && n.startMs <= noteEnd(last) + 1) {
      const merged = { ...last, lenMs: Math.max(noteEnd(last), noteEnd(n)) - last.startMs };
      out[out.indexOf(last)] = merged;
    } else out.push(n);
  }
  return out;
}
