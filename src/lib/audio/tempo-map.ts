/**
 * Ticks to milliseconds along a tempo map: the same maths as `TempoMap` in
 * `src-tauri/src/audio/song.rs`, so a position of the notes player (in ticks) is the same
 * moment in the engine that plays the audio lanes (in song time).
 */
export interface TempoMap {
  /** `[tick, ms at that tick, ms per tick from there on]`, by tick. */
  segments: readonly (readonly [number, number, number])[];
}

const perTick = (bpm: number, division: number) => {
  const tempo = Number.isFinite(bpm) && bpm > 0 ? Math.min(2000, Math.max(1, bpm)) : 120;
  return 60_000 / tempo / division;
};

/** The tempo map of a song: `division` ticks per quarter note and `[tick, bpm]` changes. */
export function tempoMap(
  division: number,
  tempos: readonly (readonly [number, number])[],
): TempoMap {
  const sorted = [...tempos].sort((a, b) => a[0] - b[0]);
  const segments: [number, number, number][] = [[0, 0, perTick(120, division)]];
  for (const [tick, bpm] of sorted) {
    const last = segments[segments.length - 1]!;
    if (tick === last[0]) {
      last[2] = perTick(bpm, division);
    } else {
      segments.push([tick, last[1] + (tick - last[0]) * last[2], perTick(bpm, division)]);
    }
  }
  return { segments };
}

/** Milliseconds from the start of the song to `tick`, at normal speed. */
export function tickToMs(map: TempoMap, tick: number): number {
  const t = Math.max(0, tick);
  let low = 0;
  let high = map.segments.length;
  // The last segment that starts at or before the tick.
  while (low < high) {
    const mid = (low + high) >> 1;
    if (map.segments[mid]![0] <= t) low = mid + 1;
    else high = mid;
  }
  const [start, ms, rate] = map.segments[Math.max(0, low - 1)]!;
  return ms + (t - start) * rate;
}
