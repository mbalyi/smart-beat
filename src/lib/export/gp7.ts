/** Smart Beat's native format: a Guitar Pro 7 file (`.gp`), open (ZIP + XML) and readable by GP7/8. */
import { exporter, Settings } from "@coderline/alphatab";

import { withWritableDrumKits } from "@/lib/score/drum-kit";
import type { Score } from "@/lib/score/model";

export function writeGp7(score: Score): Uint8Array {
  // Drum notes must refer to their track's own kit, or they open as other drums (#229).
  return withWritableDrumKits(score, () =>
    new exporter.Gp7Exporter().export(score, new Settings()),
  );
}
