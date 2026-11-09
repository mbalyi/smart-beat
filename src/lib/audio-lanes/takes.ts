import { songMsAt, timelineMsAt, type SongGrid } from "@/lib/audio-lanes/sync";
import type { AudioLanesSettings } from "@/lib/tauri";

/** How a take is recorded: from a bar, punched into the selected bars, or looped over them (one take per pass). */
export type RecordMode = "playhead" | "punch" | "loop";

export interface TakePlacement {
  /** Where the clip starts on the audio timeline. */
  startMs: number;
  /** Where each pass starts in the recorded file (one for a plain take). */
  passes: number[];
  /** How much of the file each pass plays. */
  lengthMs: number;
}

/**
 * Where a recorded take goes. `downbeat` is the second of the file at which the bar playback
 * started from was heard (count-in and latency already counted, see `downbeatInTake`).
 * Playback starts `preRollBars` before the punch bar; the pre-roll is recorded but left out of
 * the clip (trim the clip to hear it). `speed` is the practice speed (1 = as written).
 */
export function placeTake(options: {
  audio: AudioLanesSettings;
  grid: SongGrid;
  mode: RecordMode;
  /** The bar recording starts at (playhead mode), or the selected bars (punch and loop). */
  startBar: number;
  range: { start: number; end: number } | null;
  preRollBars: number;
  downbeat: number;
  takeMs: number;
  speed: number;
}): TakePlacement | null {
  const { audio, grid, mode, range, downbeat, takeMs, speed } = options;
  const punchBar = mode === "playhead" || !range ? options.startBar : range.start;
  const playBar = Math.max(0, punchBar - options.preRollBars);
  const preRollMs = (songMsAt(grid, punchBar) - songMsAt(grid, playBar)) / speed;
  const first = downbeat * 1000 + preRollMs;
  if (first >= takeMs) return null;
  const startMs = timelineMsAt(audio, grid, punchBar);
  if (mode === "playhead" || !range)
    return { startMs, passes: [Math.max(0, first)], lengthMs: takeMs - Math.max(0, first) };
  const passMs = (songMsAt(grid, range.end + 1) - songMsAt(grid, range.start)) / speed;
  if (passMs <= 0) return null;
  if (mode === "punch")
    return { startMs, passes: [Math.max(0, first)], lengthMs: Math.min(passMs, takeMs - first) };
  const count = Math.max(1, Math.floor((takeMs - first) / passMs));
  return {
    startMs,
    passes: Array.from({ length: count }, (_, k) => Math.max(0, first + k * passMs)),
    lengthMs: passMs,
  };
}

/** A mono take as a 16-bit WAV file (what the lanes store for a recording). */
export function monoWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) =>
    [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) =>
    view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, s)) * 32767), true),
  );
  return bytes;
}
