import type { StemEngine } from "@/lib/tauri";

/** Every engine except Fast is a model the user downloads. */
export type NeuralEngine = Exclude<StemEngine, "fast">;

/** What the dialog says about one engine. Edit the wording here; the cards read only this. */
export interface EngineInfo {
  id: StemEngine;
  /** The name on the card, in the page header and in the song list. */
  label: string;
  /** What it is best at, in one line. */
  strength: string;
  /** What it costs in time and memory. Measured on the laptop the spike ran on. */
  speed: string;
  /** The one we point people to first. */
  recommended?: boolean;
}

const FAST: EngineInfo = {
  id: "fast",
  label: "Fast",
  strength: "Takes a few seconds, and leaves some of the other parts behind.",
  speed: "A few seconds for a song, no download.",
};

/** In the order the cards are listed: the built-in engine, then the recommended model first. */
export const ENGINES: readonly EngineInfo[] = [
  FAST,
  {
    id: "htdemucs",
    label: "HTDemucs",
    strength: "Best all-round choice: drums, bass, vocals and the rest.",
    speed: "Faster than real time on a laptop: about 0.6 s per second of music, 1.6 GB of memory.",
    recommended: true,
  },
  {
    id: "scnet-xl",
    label: "SCNet XL",
    strength: "Best for vocals, and the highest measured quality on the standard benchmark.",
    speed:
      "Slow: about 7 s per second of music and 3.5 GB of memory, so a 4-minute song takes about 27 minutes.",
  },
  {
    id: "scnet",
    label: "SCNet Small",
    strength: "The lightest of the new models, with good all-round quality.",
    speed: "Faster than real time: about 0.6 s per second of music, 1 GB of memory.",
  },
  {
    id: "neural",
    label: "UMX-HQ",
    strength:
      "Fastest and lightest, but older: the other models are clearly better on drums and bass.",
    speed: "Quick: a song takes a fraction of its length.",
  },
];

export const NEURAL_ENGINES: readonly NeuralEngine[] = ENGINES.filter(
  (engine): engine is EngineInfo & { id: NeuralEngine } => engine.id !== "fast",
).map((engine) => engine.id);

export function engineInfo(engine: StemEngine): EngineInfo {
  return ENGINES.find((item) => item.id === engine) ?? FAST;
}

/** `UMX-HQ` for the engine of a saved song (an unknown one reads as Fast). */
export const engineLabel = (engine: StemEngine): string => engineInfo(engine).label;
