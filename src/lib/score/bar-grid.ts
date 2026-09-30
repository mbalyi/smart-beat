import type { Track } from "@/lib/score/model";

/** Which bars of a track have music in them (rests and empty bars are dimmed in the bar grid). */
export function filledBars(track: Track, barCount: number): boolean[] {
  const bars = track.staves.flatMap((staff) => staff.bars);
  const filled = Array.from({ length: barCount }, () => false);
  for (const bar of bars) {
    if (bar.index < barCount && !bar.isEmpty && !bar.isRestOnly) filled[bar.index] = true;
  }
  return filled;
}
