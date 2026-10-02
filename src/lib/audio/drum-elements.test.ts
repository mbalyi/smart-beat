import {
  defaultDrumMixer,
  DRUM_ELEMENTS,
  elementKeys,
  elementMix,
  engineDrumMix,
  withElementMix,
} from "@/lib/audio/drum-elements";
import { DRUM_FALLBACK } from "@/lib/score/drum-map";

describe("drum elements", () => {
  it("lists Guitar Pro's kit pieces, each key in one element only", () => {
    expect(DRUM_ELEMENTS.map((e) => e.label)).toContain("Tom 5");
    expect(DRUM_ELEMENTS).toHaveLength(17);
    const keys = elementKeys().flat();
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("routes the SoundFont's substitutes to the element that owns the original", () => {
    const owner = new Map(DRUM_ELEMENTS.flatMap((e, i) => e.keys.map((k) => [k, i] as const)));
    const routed = elementKeys();
    for (const [key, played] of Object.entries(DRUM_FALLBACK)) {
      const element = owner.get(Number(key));
      if (element === undefined || owner.has(played)) continue;
      expect(routed[element]).toContain(played);
    }
  });

  it("edits one element and builds the engine's drum mix", () => {
    let mixer = defaultDrumMixer();
    expect(elementMix(mixer, "snare").volume).toBe(1);
    mixer = withElementMix(mixer, { ...elementMix(mixer, "snare"), volume: 0.5, pan: 0.3 });
    mixer = withElementMix(mixer, { id: "new-piece", volume: 1, pan: 0, mute: false, solo: false });
    expect(mixer.elements.at(-1)!.id).toBe("new-piece");
    const engine = engineDrumMix({ ...mixer, stereo: false });
    expect(engine.stereo).toBe(false);
    expect(engine.elements[0]!.keys).toContain(38);
    expect(engine.elements[0]!.mix).toEqual({ volume: 0.5, pan: 0.3, mute: false, solo: false });
    expect(engine.elements).toHaveLength(DRUM_ELEMENTS.length);
    // A saved mixer without some piece plays it at full level.
    expect(engineDrumMix({ stereo: true, elements: [] }).elements[3]!.mix.volume).toBe(1);
  });
});
