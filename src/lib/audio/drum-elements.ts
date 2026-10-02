/**
 * The drum mixer's elements (Guitar Pro 8's drum mixer rows): which General
 * MIDI drum numbers each kit piece plays. The native engine gives every
 * element its own synthesizer, fader, pan, mute, solo and meter.
 */
import { playableDrumKey } from "@/lib/score/drum-map";
import type { BusMix, DrumElementMix, DrumMixer, EngineDrumMix } from "@/lib/tauri";

export interface DrumElement {
  id: string;
  label: string;
  keys: readonly number[];
}

export const DRUM_ELEMENTS: readonly DrumElement[] = [
  { id: "snare", label: "Snare", keys: [31, 37, 38, 40, 91] },
  { id: "hihat", label: "Hi-Hat", keys: [42, 44, 46, 92] },
  { id: "acoustic-kick", label: "Acoustic Kick", keys: [35] },
  { id: "kick", label: "Kick", keys: [36, 114] },
  { id: "tom1", label: "Tom 1", keys: [50] },
  { id: "tom2", label: "Tom 2", keys: [48] },
  { id: "tom3", label: "Tom 3", keys: [47] },
  { id: "tom4", label: "Tom 4", keys: [45] },
  { id: "tom5", label: "Tom 5", keys: [41, 43] },
  { id: "ride", label: "Ride", keys: [29, 51, 53, 59, 93, 94, 126, 127] },
  { id: "splash", label: "Splash", keys: [55, 95] },
  { id: "china", label: "China", keys: [52, 96] },
  { id: "crash-high", label: "Crash High", keys: [49, 97] },
  { id: "crash-medium", label: "Crash Medium", keys: [57, 98] },
  { id: "cowbell-low", label: "Cowbell Low", keys: [99, 100] },
  { id: "cowbell-medium", label: "Cowbell Medium", keys: [56, 101] },
  { id: "cowbell-high", label: "Cowbell High", keys: [102, 103] },
];

export const defaultElementMix = (id: string): DrumElementMix => ({
  id,
  volume: 1,
  pan: 0,
  mute: false,
  solo: false,
});

/** A drum mixer with every element at full level, centred. */
export const defaultDrumMixer = (): DrumMixer => ({
  stereo: true,
  elements: DRUM_ELEMENTS.map((e) => defaultElementMix(e.id)),
});

/** The mix of one element (defaults when the saved mixer lacks it). */
export function elementMix(mixer: DrumMixer, id: string): DrumElementMix {
  return mixer.elements.find((e) => e.id === id) ?? defaultElementMix(id);
}

export function withElementMix(mixer: DrumMixer, mix: DrumElementMix): DrumMixer {
  const known = mixer.elements.some((e) => e.id === mix.id);
  return {
    ...mixer,
    elements: known
      ? mixer.elements.map((e) => (e.id === mix.id ? mix : e))
      : [...mixer.elements, mix],
  };
}

/**
 * The MIDI keys of every element as the engine hears them. Some drum numbers
 * are played as another one the SoundFont has (see `DRUM_FALLBACK`): those
 * substitutes go to the element too, unless another element owns them.
 */
export function elementKeys(): number[][] {
  const owned = new Set(DRUM_ELEMENTS.flatMap((e) => e.keys));
  return DRUM_ELEMENTS.map((element) => {
    const keys = new Set(element.keys);
    for (const key of element.keys) {
      const played = playableDrumKey(key);
      if (!owned.has(played)) keys.add(played);
    }
    return [...keys].sort((a, b) => a - b);
  });
}

const busOf = (mix: DrumElementMix): BusMix => ({
  volume: mix.volume,
  pan: mix.pan,
  mute: mix.mute,
  solo: mix.solo,
});

/** What the engine needs for a drum mixer. */
export function engineDrumMix(mixer: DrumMixer): EngineDrumMix {
  const keys = elementKeys();
  return {
    stereo: mixer.stereo,
    elements: DRUM_ELEMENTS.map((e, i) => ({
      keys: keys[i]!,
      mix: busOf(elementMix(mixer, e.id)),
    })),
    // Other percussion (tambourine, congas, …) plays at full level, centred,
    // and goes quiet when an element is soloed.
    other: { volume: 1, pan: 0, mute: false, solo: false },
  };
}
