/**
 * Record to tab, drums: tidies the hits the drum finder returns before they are written.
 * A hit is a `RecordedNote` whose pitch is a General MIDI drum number.
 */
import type { RecordedNote } from "@/lib/import/recording";
import { DRUM_MIDI_MAP } from "@/lib/score/drum-map";

/** Hits of one drum closer than this are one hit that was found twice (seconds). */
export const DOUBLE_HIT = 0.03;
/** The drums the finder claims to hear; toms and crash are experimental. */
export const SUPPORTED_DRUMS = [36, 38, 42, 46] as const;
export const EXPERIMENTAL_DRUMS = [41, 47, 48, 49] as const;

/**
 * Keeps the hits of known drum numbers, merges doubles of one drum (the louder one stays) and
 * returns them in time order.
 */
export function cleanDrumHits(hits: readonly RecordedNote[]): RecordedNote[] {
  const known = hits
    .filter((h) => Number.isFinite(h.start) && Object.hasOwn(DRUM_MIDI_MAP, h.pitch))
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const out: RecordedNote[] = [];
  const last = new Map<number, number>();
  for (const hit of known) {
    const index = last.get(hit.pitch);
    const previous = index === undefined ? undefined : out[index];
    if (previous && hit.start - previous.start < DOUBLE_HIT) {
      if (hit.velocity > previous.velocity) out[index!] = { ...hit, start: previous.start };
      continue;
    }
    last.set(hit.pitch, out.length);
    out.push(hit);
  }
  return out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}
