/** Smart Beat's native format: a Guitar Pro 7 file (`.gp`), open (ZIP + XML) and readable by GP7/8. */
import { exporter, Settings } from "@coderline/alphatab";

import { withWritableDrumKits } from "@/lib/score/drum-kit";
import type { Score } from "@/lib/score/model";

export function writeGp7(score: Score): Uint8Array {
  // Drum notes must refer to their track's own kit, or they open as other drums (#229).
  return withWritableDrumKits(score, () =>
    withUniqueIds(score, () => new exporter.Gp7Exporter().export(score, new Settings())),
  );
}

/**
 * Runs `fn` with every bar, voice, beat and note of the song numbered 0, 1, 2… and puts the
 * old numbers back afterwards. A Guitar Pro file points at them by these ids, but alphaTab
 * starts its counters again from 0 whenever it reads a file (another song, a sound check), so
 * notes made after that can share an id with a note already in the song: the file would then
 * open with the wrong note in their place, e.g. a hi-hat for a crash (#229).
 */
function withUniqueIds<T>(score: Score, fn: () => T): T {
  const items: { id: number }[] = [];
  for (const track of score.tracks)
    for (const staff of track.staves)
      for (const bar of staff.bars) {
        items.push(bar);
        for (const voice of bar.voices) {
          items.push(voice);
          for (const beat of voice.beats) {
            items.push(beat);
            items.push(...beat.notes);
          }
        }
      }
  const ids = items.map((item) => item.id);
  // Each kind is numbered on its own in the file, but one count over all of them is unique too.
  items.forEach((item, i) => (item.id = i));
  try {
    return fn();
  } finally {
    items.forEach((item, i) => (item.id = ids[i]!));
  }
}
