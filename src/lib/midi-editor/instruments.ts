import { GM_INSTRUMENTS } from "@/lib/score/music";
import type { LaneInstrument } from "@/lib/tauri";

/** An instrument in a few words. */
export function instrumentName(instrument: LaneInstrument | undefined): string {
  switch (instrument?.type) {
    case undefined:
      return GM_INSTRUMENTS[0]!;
    case "soundfont":
      return GM_INSTRUMENTS[instrument.program] ?? `Program ${instrument.program + 1}`;
    case "drums":
      return "Drum kit";
    case "kit":
      return "Imported kit";
    case "pads":
      return `Pad bank (${instrument.pads.length} pads)`;
    case "plugin":
      return instrument.name || "Plugin instrument";
  }
}
