/**
 * Settings presets for one compressor or limiter pedal (#39), for drums (tight
 * kick and snare, parallel bus, metal) and mastering. Data in
 * `dynamics-presets.json`; the Rust tests build every one of them.
 */
import data from "@/lib/audio/dynamics-presets.json";
import type { CompressorParams, EffectSlot, LimiterParams } from "@/lib/audio/effects";

export type DynamicsPreset =
  | { id: string; type: "compressor"; name: string; description: string; params: CompressorParams }
  | { id: string; type: "limiter"; name: string; description: string; params: LimiterParams };

export const DYNAMICS_PRESETS = data.presets as DynamicsPreset[];

export const dynamicsPresetsFor = (type: EffectSlot["type"]) =>
  DYNAMICS_PRESETS.filter((p) => p.type === type);

/** The block with a preset's settings (keeps whether it is on). */
export function applyDynamicsPreset(slot: EffectSlot, preset: DynamicsPreset): EffectSlot {
  if (slot.type !== preset.type) return slot;
  return { ...slot, ...preset.params } as EffectSlot;
}

/** The preset whose settings the block has, if any. */
export function matchingDynamicsPreset(slot: EffectSlot): DynamicsPreset | undefined {
  return dynamicsPresetsFor(slot.type).find((preset) =>
    Object.entries(preset.params).every(
      ([key, value]) => (slot as unknown as Record<string, number>)[key] === value,
    ),
  );
}
