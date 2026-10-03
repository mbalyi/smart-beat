import {
  applyDynamicsPreset,
  DYNAMICS_PRESETS,
  dynamicsPresetsFor,
  matchingDynamicsPreset,
} from "@/lib/audio/dynamics-presets";
import { defaultEffect, PARAMS } from "@/lib/audio/effects";

describe("dynamics presets (#39)", () => {
  it("covers drums and mastering, every value inside its knob's range", () => {
    expect(dynamicsPresetsFor("compressor").map((p) => p.name)).toEqual(
      expect.arrayContaining(["Tight kick and snare", "Parallel drum bus", "Metal drums"]),
    );
    expect(dynamicsPresetsFor("limiter").length).toBeGreaterThan(0);
    expect(new Set(DYNAMICS_PRESETS.map((p) => p.id)).size).toBe(DYNAMICS_PRESETS.length);
    for (const preset of DYNAMICS_PRESETS) {
      const specs = PARAMS[preset.type]!;
      expect(Object.keys(preset.params).sort(), preset.id).toEqual(specs.map((s) => s.key).sort());
      for (const spec of specs) {
        const value = (preset.params as unknown as Record<string, number>)[spec.key]!;
        expect(value, `${preset.id}.${spec.key}`).toBeGreaterThanOrEqual(spec.min);
        expect(value, `${preset.id}.${spec.key}`).toBeLessThanOrEqual(spec.max);
      }
    }
  });

  it("applies a preset to its own kind of block and recognises it", () => {
    const tight = DYNAMICS_PRESETS.find((p) => p.id === "comp-tight-kick-snare")!;
    const slot = { ...defaultEffect("compressor"), enabled: false };
    const applied = applyDynamicsPreset(slot, tight);
    expect(applied).toMatchObject({ enabled: false, ratio: 6 });
    expect(matchingDynamicsPreset(applied)?.id).toBe(tight.id);
    expect(matchingDynamicsPreset(defaultEffect("compressor"))).toBeUndefined();
    // A limiter preset leaves a compressor alone.
    expect(applyDynamicsPreset(slot, dynamicsPresetsFor("limiter")[0]!)).toBe(slot);
  });
});
