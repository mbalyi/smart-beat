/** Smart Beat's native format: a Guitar Pro 7 file (`.gp`), open (ZIP + XML) and readable by GP7/8. */
import { exporter, Settings } from "@coderline/alphatab";

import type { Score } from "@/lib/score/model";

export function writeGp7(score: Score): Uint8Array {
  return new exporter.Gp7Exporter().export(score, new Settings());
}
