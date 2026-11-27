/**
 * Note edits for MIDI clips: the editor grid (straight, triplet, dotted and swing), quantize
 * with strength and ranges (keeping the played timing for un-quantize), humanize, legato and
 * velocity changes. Pure: every function returns new notes.
 */
import { barAtTimelineMs, timelineMsAt, type SongGrid } from "@/lib/audio-lanes/sync";
import { noteEnd, sortNotes, MIN_NOTE_MS } from "@/lib/audio-lanes/midi";
import type { AudioLanesSettings, MidiNote } from "@/lib/tauri";

/** How grid lines are spaced. */
export type GridType = "straight" | "triplet" | "dotted" | "swing";

/** The editor grid: a note value (a fraction of a whole note), its type and the swing amount. */
export interface MidiGrid {
  /** 1/128 … 4 (four bars of 4/4). */
  value: number;
  type: GridType;
  /** -1 … 1, used by the swing type. */
  swing: number;
}

export const DEFAULT_GRID: MidiGrid = { value: 1 / 16, type: "straight", swing: 0 };

/** The grid values the editor offers, as fractions of a whole note. */
export const GRID_VALUES: readonly number[] = [
  1 / 128,
  1 / 64,
  1 / 32,
  1 / 16,
  1 / 8,
  1 / 4,
  1 / 2,
  1,
  2,
  4,
];

/** A grid value as text: "1/16", "1", "2 bars". */
export function gridLabel(value: number): string {
  if (value >= 2) return `${value} bars`;
  if (value === 1) return "1 bar";
  return `1/${Math.round(1 / value)}`;
}

/** The grid step in beats (quarter notes) before the grid type applies. */
function stepBeats(grid: MidiGrid): number {
  const base = grid.value * 4;
  if (grid.type === "triplet") return (base * 2) / 3;
  if (grid.type === "dotted") return base * 1.5;
  return base;
}

/** Grid line positions inside a bar of `beats` beats, in beats from the bar start. */
export function barLines(grid: MidiGrid, beats: number): number[] {
  const step = stepBeats(grid);
  if (!(step > 0)) return [0, beats];
  if (step >= beats) return [0, beats];
  const lines: number[] = [];
  for (let k = 0; k * step < beats - 1e-9; k++) {
    const swung = grid.type === "swing" && k % 2 === 1 ? (grid.swing * step) / 2 : 0;
    lines.push(k * step + swung);
  }
  lines.push(beats);
  return lines;
}

/** The grid lines just before and after a timeline point (absolute ms). */
export function gridAround(
  audio: AudioLanesSettings,
  song: SongGrid,
  grid: MidiGrid,
  ms: number,
): { prev: number; next: number } {
  const at = barAtTimelineMs(audio, song, ms);
  if (song.barTimes.length === 0 || at < 0) return { prev: ms, next: ms };
  if (grid.value >= 1) {
    const bars = Math.round(grid.value);
    const first = Math.floor(Math.floor(at) / bars) * bars;
    return {
      prev: timelineMsAt(audio, song, first),
      next: timelineMsAt(audio, song, first + bars),
    };
  }
  const bar = Math.floor(at);
  const beats = song.beats[bar] ?? song.beats[song.beats.length - 1] ?? 4;
  const pos = (at - bar) * beats;
  const lines = barLines(grid, beats);
  let i = lines.findIndex((l) => l > pos + 1e-9);
  if (i <= 0) i = lines.length - 1;
  return {
    prev: timelineMsAt(audio, song, bar, lines[i - 1]!),
    next: timelineMsAt(audio, song, bar, lines[i]!),
  };
}

/** The nearest grid line to a timeline point. */
export function snapToGrid(
  audio: AudioLanesSettings,
  song: SongGrid,
  grid: MidiGrid,
  ms: number,
): number {
  const { prev, next } = gridAround(audio, song, grid, ms);
  return ms - prev <= next - ms ? prev : next;
}

/** The length of one grid step at a timeline point, in ms. */
export function gridStepMs(
  audio: AudioLanesSettings,
  song: SongGrid,
  grid: MidiGrid,
  ms: number,
): number {
  const { prev, next } = gridAround(audio, song, grid, ms);
  return Math.max(MIN_NOTE_MS, next - prev);
}

/** Which part of the notes quantize moves. */
export type QuantizeTarget = "start" | "startEnd" | "startLength" | "end" | "length";

export interface QuantizeOptions {
  target: QuantizeTarget;
  /** 0 … 1: how far notes move towards the grid. */
  strength: number;
  /** Notes may move earlier / later. */
  moveLeft: boolean;
  moveRight: boolean;
  /** Notes may get shorter / longer (when ends or lengths are quantized). */
  shrink: boolean;
  grow: boolean;
  /** Only notes whose distance to the grid is within this share of a step (0 … 1). */
  within: [number, number];
  /** Shorten notes that would overlap the next note of the same pitch. */
  fixOverlaps: boolean;
}

export const DEFAULT_QUANTIZE: QuantizeOptions = {
  target: "start",
  strength: 1,
  moveLeft: true,
  moveRight: true,
  shrink: true,
  grow: true,
  within: [0, 1],
  fixOverlaps: true,
};

/** Snaps a position (absolute ms) toward the grid by the options. */
type Snapper = (ms: number) => { prev: number; next: number };

function towards(
  ms: number,
  around: Snapper,
  opts: QuantizeOptions,
  allowed: (d: number) => boolean,
) {
  const { prev, next } = around(ms);
  const step = Math.max(1e-6, next - prev);
  const target = ms - prev <= next - ms ? prev : next;
  const distance = Math.abs(target - ms) / (step / 2);
  if (distance < opts.within[0] || distance > opts.within[1]) return ms;
  const delta = (target - ms) * opts.strength;
  return allowed(delta) ? ms + delta : ms;
}

/**
 * Quantized notes of a clip that starts at `clipStartMs`. Only notes in `ids` move (all when
 * null). The played timing stays in `rawStartMs` and `rawLenMs`, so un-quantize and a second
 * quantize always start from the performance.
 */
export function quantizeNotes(
  notes: readonly MidiNote[],
  clipStartMs: number,
  around: Snapper,
  opts: QuantizeOptions,
  ids: ReadonlySet<string> | null = null,
): MidiNote[] {
  const moved = notes.map((n) => {
    if (ids && !ids.has(n.id)) return n;
    const rawStart = n.rawStartMs ?? n.startMs;
    const rawLen = n.rawLenMs ?? n.lenMs;
    const start = clipStartMs + rawStart;
    const end = start + rawLen;
    const move = (d: number) => (d < 0 ? opts.moveLeft : d > 0 ? opts.moveRight : true);
    const size = (d: number) => (d < 0 ? opts.shrink : d > 0 ? opts.grow : true);
    let newStart = start;
    let newEnd: number;
    if (opts.target !== "end" && opts.target !== "length")
      newStart = towards(start, around, opts, move);
    if (opts.target === "startLength") newEnd = newStart + rawLen;
    else newEnd = end + (newStart - start);
    if (opts.target === "startEnd" || opts.target === "end")
      newEnd = towards(end, around, opts, (d) => size(d));
    if (opts.target === "length") {
      const { prev, next } = around(start);
      const step = Math.max(1e-6, next - prev);
      const len = Math.max(step, Math.round(rawLen / step) * step);
      const delta = (len - rawLen) * opts.strength;
      newEnd = size(delta) ? end + delta : end;
    }
    return {
      ...n,
      startMs: Math.max(0, newStart - clipStartMs),
      lenMs: Math.max(MIN_NOTE_MS, newEnd - newStart),
      rawStartMs: rawStart,
      rawLenMs: rawLen,
    };
  });
  return opts.fixOverlaps ? fixOverlaps(moved) : sortNotes(moved);
}

/** Notes back at their played timing (un-quantize); notes never quantized stay. */
export function unquantizeNotes(
  notes: readonly MidiNote[],
  ids: ReadonlySet<string> | null = null,
): MidiNote[] {
  return sortNotes(
    notes.map((n) => {
      if ((ids && !ids.has(n.id)) || (n.rawStartMs === undefined && n.rawLenMs === undefined))
        return n;
      const { rawStartMs, rawLenMs, ...rest } = n;
      return { ...rest, startMs: rawStartMs ?? n.startMs, lenMs: rawLenMs ?? n.lenMs };
    }),
  );
}

/** The quantized timing made permanent: the played timing is forgotten (freeze quantize). */
export function freezeQuantize(notes: readonly MidiNote[]): MidiNote[] {
  return notes.map(({ rawStartMs: _s, rawLenMs: _l, ...rest }) => rest);
}

/** Notes of one pitch and channel that run into the next one end where it starts. */
export function fixOverlaps(notes: readonly MidiNote[]): MidiNote[] {
  const sorted = sortNotes(notes);
  return sorted.map((n, i) => {
    const next = sorted
      .slice(i + 1)
      .find((m) => m.pitch === n.pitch && m.chan === n.chan && m.startMs > n.startMs);
    return next && noteEnd(n) > next.startMs
      ? { ...n, lenMs: Math.max(MIN_NOTE_MS, next.startMs - n.startMs) }
      : n;
  });
}

/** Random timing (± ms) and velocity (± steps) changes; `random` returns 0 … 1. */
export function humanizeNotes(
  notes: readonly MidiNote[],
  amount: { timingMs: number; velocity: number },
  random: () => number = Math.random,
  ids: ReadonlySet<string> | null = null,
): MidiNote[] {
  const jitter = (range: number) => (random() * 2 - 1) * range;
  return sortNotes(
    notes.map((n) =>
      ids && !ids.has(n.id)
        ? n
        : {
            ...n,
            startMs: Math.max(0, n.startMs + jitter(amount.timingMs)),
            vel: Math.min(127, Math.max(1, Math.round(n.vel + jitter(amount.velocity)))),
          },
    ),
  );
}

/** Each note lasts until the next note starts (legato); the last keeps its length. */
export function legatoNotes(
  notes: readonly MidiNote[],
  ids: ReadonlySet<string> | null = null,
): MidiNote[] {
  const sorted = sortNotes(notes);
  const starts = [...new Set(sorted.map((n) => n.startMs))].sort((a, b) => a - b);
  return sorted.map((n) => {
    if (ids && !ids.has(n.id)) return n;
    const next = starts.find((s) => s > n.startMs);
    return next === undefined ? n : { ...n, lenMs: next - n.startMs };
  });
}

/** Velocities set (`mode: "set"`) or changed by (`"add"`) a value, kept in 1 … 127. */
export function changeVelocity(
  notes: readonly MidiNote[],
  ids: ReadonlySet<string> | null,
  value: number,
  mode: "set" | "add",
): MidiNote[] {
  return notes.map((n) =>
    ids && !ids.has(n.id)
      ? n
      : {
          ...n,
          vel: Math.min(127, Math.max(1, Math.round(mode === "set" ? value : n.vel + value))),
        },
  );
}

/** Major and minor scale steps, for key snap and scale transposition. */
export const SCALES: Readonly<Record<string, readonly number[]>> = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  pentatonicMajor: [0, 2, 4, 7, 9],
  pentatonicMinor: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
};

/** The nearest pitch of a scale (`root` 0 … 11) to `pitch`. */
export function snapPitchToScale(pitch: number, root: number, scale: readonly number[]): number {
  for (let d = 0; d < 12; d++) {
    for (const candidate of [pitch - d, pitch + d]) {
      if (candidate < 0 || candidate > 127) continue;
      if (scale.includes((((candidate - root) % 12) + 12) % 12)) return candidate;
    }
  }
  return pitch;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** A MIDI key as a note name (60 is C4). */
export function noteName(pitch: number): string {
  return `${NOTE_NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;
}

/**
 * Reads a note name ("C4", "f#2", "Bb3") or a number; a value starting with + or - is relative
 * to `current` ("+1o2" is one octave and two semitones up). Null when it is neither.
 */
export function parsePitch(text: string, current: number): number | null {
  const value = text.trim();
  const relative = /^([+-])(?:(\d+)o)?(\d+)?$/i.exec(value);
  if (relative && (relative[2] || relative[3])) {
    const sign = relative[1] === "-" ? -1 : 1;
    const amount = Number(relative[2] ?? 0) * 12 + Number(relative[3] ?? 0);
    const next = current + sign * amount;
    return next >= 0 && next <= 127 ? next : null;
  }
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    return n <= 127 ? n : null;
  }
  const named = /^([a-g])([#b]?)(-?\d+)$/i.exec(value);
  if (!named) return null;
  const base = NOTE_NAMES.indexOf(named[1]!.toUpperCase());
  const accidental = named[2] === "#" ? 1 : named[2] === "b" ? -1 : 0;
  const pitch = (Number(named[3]) + 1) * 12 + base + accidental;
  return pitch >= 0 && pitch <= 127 ? pitch : null;
}
