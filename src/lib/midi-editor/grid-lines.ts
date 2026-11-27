import { barLines, type MidiGrid } from "@/lib/audio-lanes/midi-edit";
import { barAtTimelineMs, timelineMsAt, type SongGrid } from "@/lib/audio-lanes/sync";
import type { AudioLanesSettings } from "@/lib/tauri";

/** How strong a grid line is drawn. */
export type LineKind = "bar" | "beat" | "grid";

export interface GridLine {
  ms: number;
  kind: LineKind;
  /** The bar (1-based) a bar line starts. */
  bar?: number;
}

/** The most lines drawn at once (a wide zoom shows bars only). */
const MAX_LINES = 3_000;

/**
 * The editor's grid lines between two timeline points: bar lines, beat lines and the lines of
 * the chosen grid. Past the song's end the last bar's length goes on.
 */
export function gridLines(
  audio: AudioLanesSettings,
  song: SongGrid,
  grid: MidiGrid,
  fromMs: number,
  toMs: number,
): GridLine[] {
  if (song.barTimes.length === 0 || toMs <= fromMs) return [];
  const first = Math.max(0, Math.floor(barAtTimelineMs(audio, song, fromMs)));
  const last = Math.ceil(barAtTimelineMs(audio, song, toMs)) + 1;
  const lines: GridLine[] = [];
  for (let bar = first; bar <= last && lines.length < MAX_LINES; bar++) {
    const beats = song.beats[bar] ?? song.beats[song.beats.length - 1] ?? 4;
    const inBar = grid.value >= 1 ? [0] : barLines(grid, beats).slice(0, -1);
    for (const pos of inBar) {
      const ms = timelineMsAt(audio, song, bar, pos);
      if (ms < fromMs || ms > toMs) continue;
      const kind: LineKind =
        pos === 0 ? "bar" : Math.abs(pos - Math.round(pos)) < 1e-9 ? "beat" : "grid";
      lines.push(kind === "bar" ? { ms, kind, bar: bar + 1 } : { ms, kind });
    }
  }
  return lines;
}
