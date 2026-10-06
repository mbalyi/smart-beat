/** alphaTex export: alphaTab's text format, readable with any text editor and by alphaTab. */
import { exporter, Settings } from "@coderline/alphatab";

import type { Score } from "@/lib/score/model";

export function writeAlphaTex(score: Score): string {
  return new exporter.AlphaTexExporter().exportToString(score, new Settings());
}
