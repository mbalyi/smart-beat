import type { StemEngine, StemKindId } from "@/lib/tauri";

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
  /**
   * The parts it makes besides "other". Left out for the fast engine, where the user picks, and
   * for the four-part models (drums, bass, vocals).
   */
  parts?: readonly StemKindId[];
  /** A sentence under the list of parts about what is weaker. */
  partsNote?: string;
  /**
   * Not on the list until the app reports its model as available (published, with its size and
   * SHA-256 pinned). Used by the 6-part engine, whose file is not hosted yet.
   */
  hiddenUntilAvailable?: boolean;
}

/** The parts the four-part models make besides "other". */
export const FOUR_PARTS: readonly StemKindId[] = ["drums", "bass", "vocals"];

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
    id: "htdemucs-6s",
    label: "HTDemucs 6-part",
    strength:
      "Six parts: drums, bass, vocals, guitar, piano and the rest. Guitar and piano are weaker than the other parts.",
    speed:
      "The same network as HTDemucs, so expect similar time and memory (not measured for this model).",
    parts: ["drums", "bass", "vocals", "guitar", "piano"],
    partsNote:
      "Guitar is the weaker of the main parts, and piano is the weakest: distorted guitar can leak into Other, and some piano can end up in Guitar or Other.",
    hiddenUntilAvailable: true,
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

/**
 * The cards to show: an engine whose model is not available yet (the 6-part one) stays off the
 * list until the app reports its model as available.
 */
export function offeredEngines(
  states: Partial<Record<NeuralEngine, { available: boolean }>>,
): readonly EngineInfo[] {
  return ENGINES.filter(
    (info) => !info.hiddenUntilAvailable || states[info.id as NeuralEngine]?.available === true,
  );
}

/** The parts a neural engine makes, besides "other" (always made). */
export function neuralParts(engine: StemEngine): readonly StemKindId[] {
  return engineInfo(engine).parts ?? FOUR_PARTS;
}

export function engineInfo(engine: StemEngine): EngineInfo {
  return ENGINES.find((item) => item.id === engine) ?? FAST;
}

/** `UMX-HQ` for the engine of a saved song (an unknown one reads as Fast). */
export const engineLabel = (engine: StemEngine): string => engineInfo(engine).label;
