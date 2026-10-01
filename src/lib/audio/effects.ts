/**
 * Effect chains as data: what a track's (or the master's) chain holds, the
 * parameters each block has (ranges, units, labels for the knobs), and
 * helpers to edit chains immutably. Mirrors `EffectSlot` / `EffectConfig` in
 * `src-tauri/src/audio/chain.rs` and the parameter structs in `audio/dsp`.
 */

/** Mirrors `MAX_TRACK_EFFECTS` / `MAX_MASTER_EFFECTS` in `chain.rs`. */
export const MAX_TRACK_EFFECTS = 6;
export const MAX_MASTER_EFFECTS = 3;

export type FilterKind = "lowShelf" | "peak" | "highShelf" | "highPass" | "lowPass";

export interface EqBand {
  kind: FilterKind;
  freq: number;
  q: number;
  gainDb: number;
}

export interface GateParams {
  thresholdDb: number;
  rangeDb: number;
  attackMs: number;
  holdMs: number;
  releaseMs: number;
}

export interface CompressorParams {
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
  kneeDb: number;
  mix: number;
}

export type DriveMode = "boost" | "overdrive" | "distortion" | "fuzz";

export interface DriveParams {
  mode: DriveMode;
  drive: number;
  tone: number;
  levelDb: number;
  tightHz: number;
}

export type EffectConfig =
  | ({ type: "gate" } & GateParams)
  | ({ type: "compressor" } & CompressorParams)
  | { type: "eq"; bands: EqBand[] }
  | ({ type: "drive" } & DriveParams)
  | { type: "amp"; model: string; inputDb: number; outputDb: number }
  | { type: "cab"; ir: string };

export type EffectType = EffectConfig["type"];

export type EffectSlot = EffectConfig & { enabled: boolean };

/** A numeric parameter as a knob shows it. */
export interface ParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}

export const EFFECT_LABELS: Record<EffectType, string> = {
  gate: "Noise gate",
  compressor: "Compressor",
  eq: "Equalizer",
  drive: "Drive",
  amp: "Amp (capture)",
  cab: "Cabinet",
};

export const EFFECT_DESCRIPTIONS: Record<EffectType, string> = {
  gate: "Silences hiss and ringing between notes.",
  compressor: "Evens out the level; tightens drums and chugs.",
  eq: "Shapes the tone band by band.",
  drive: "Boost, overdrive, distortion or fuzz.",
  amp: "A Neural Amp Modeler capture from your library.",
  cab: "A speaker cabinet (impulse response).",
};

export const PARAMS: Partial<Record<EffectType, ParamSpec[]>> = {
  gate: [
    { key: "thresholdDb", label: "Threshold", min: -90, max: 0, step: 1, unit: "dB" },
    { key: "rangeDb", label: "Range", min: -90, max: 0, step: 1, unit: "dB" },
    { key: "attackMs", label: "Attack", min: 0, max: 50, step: 0.1, unit: "ms" },
    { key: "holdMs", label: "Hold", min: 0, max: 500, step: 1, unit: "ms" },
    { key: "releaseMs", label: "Release", min: 1, max: 2000, step: 1, unit: "ms" },
  ],
  compressor: [
    { key: "thresholdDb", label: "Threshold", min: -60, max: 0, step: 0.5, unit: "dB" },
    { key: "ratio", label: "Ratio", min: 1, max: 20, step: 0.1, unit: ":1" },
    { key: "attackMs", label: "Attack", min: 0, max: 200, step: 0.1, unit: "ms" },
    { key: "releaseMs", label: "Release", min: 1, max: 2000, step: 1, unit: "ms" },
    { key: "makeupDb", label: "Makeup", min: 0, max: 24, step: 0.5, unit: "dB" },
    { key: "kneeDb", label: "Knee", min: 0, max: 24, step: 0.5, unit: "dB" },
    { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01, unit: "" },
  ],
  drive: [
    { key: "drive", label: "Drive", min: 0, max: 1, step: 0.01, unit: "" },
    { key: "tone", label: "Tone", min: 0, max: 1, step: 0.01, unit: "" },
    { key: "levelDb", label: "Level", min: -40, max: 24, step: 0.5, unit: "dB" },
    { key: "tightHz", label: "Tight", min: 20, max: 1000, step: 5, unit: "Hz" },
  ],
  amp: [
    { key: "inputDb", label: "Input", min: -24, max: 24, step: 0.5, unit: "dB" },
    { key: "outputDb", label: "Output", min: -24, max: 24, step: 0.5, unit: "dB" },
  ],
};

export const GRAPHIC_EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

/** Mirrors `graphic_bands` in `eq.rs`. */
export const graphicBands = (gains: readonly number[] = []): EqBand[] =>
  GRAPHIC_EQ_FREQS.map((freq, i) => ({ kind: "peak", freq, q: 1.41, gainDb: gains[i] ?? 0 }));

/** A new block with the same defaults as the Rust side. */
export function defaultEffect(type: EffectType): EffectSlot {
  switch (type) {
    case "gate":
      return {
        type,
        enabled: true,
        thresholdDb: -50,
        rangeDb: -80,
        attackMs: 0.5,
        holdMs: 20,
        releaseMs: 60,
      };
    case "compressor":
      return {
        type,
        enabled: true,
        thresholdDb: -18,
        ratio: 4,
        attackMs: 10,
        releaseMs: 120,
        makeupDb: 0,
        kneeDb: 6,
        mix: 1,
      };
    case "eq":
      return { type, enabled: true, bands: graphicBands() };
    case "drive":
      return {
        type,
        enabled: true,
        mode: "overdrive",
        drive: 0.3,
        tone: 0.5,
        levelDb: 0,
        tightHz: 120,
      };
    case "amp":
      return { type, enabled: true, model: "", inputDb: 0, outputDb: 0 };
    case "cab":
      return { type, enabled: true, ir: "builtin:4x12-modern" };
  }
}

/** "4.0 dB", "1:1", "60%"... */
export function formatParam(spec: ParamSpec, value: number): string {
  if (spec.unit === ":1") return `${value.toFixed(1)}:1`;
  if (spec.unit === "") return `${Math.round(value * 100)}%`;
  const digits = spec.step < 1 ? 1 : 0;
  return `${value.toFixed(digits)} ${spec.unit}`;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Sets a numeric parameter, clamped to its range. */
export function withParam(slot: EffectSlot, key: string, value: number): EffectSlot {
  const spec = PARAMS[slot.type]?.find((p) => p.key === key);
  if (!spec || !Number.isFinite(value)) return slot;
  return { ...slot, [key]: clamp(value, spec.min, spec.max) } as EffectSlot;
}

export function withBandGain(slot: EffectSlot, band: number, gainDb: number): EffectSlot {
  if (slot.type !== "eq" || !slot.bands[band] || !Number.isFinite(gainDb)) return slot;
  const bands = slot.bands.map((b, i) =>
    i === band ? { ...b, gainDb: clamp(gainDb, -24, 24) } : b,
  );
  return { ...slot, bands };
}

export function addEffect(
  chain: readonly EffectSlot[],
  type: EffectType,
  limit: number,
): EffectSlot[] {
  if (chain.length >= limit) return [...chain];
  return [...chain, defaultEffect(type)];
}

export function removeEffect(chain: readonly EffectSlot[], index: number): EffectSlot[] {
  return chain.filter((_, i) => i !== index);
}

/** Moves a block from `from` to `to` (both indexes in the chain). */
export function moveEffect(chain: readonly EffectSlot[], from: number, to: number): EffectSlot[] {
  if (from === to || !chain[from] || to < 0 || to >= chain.length) return [...chain];
  const next = [...chain];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

export function replaceEffect(
  chain: readonly EffectSlot[],
  index: number,
  slot: EffectSlot,
): EffectSlot[] {
  return chain.map((s, i) => (i === index ? slot : s));
}

/** "Gate → Compressor → Drive" (enabled blocks only), or "No effects". */
export function describeChain(chain: readonly EffectSlot[]): string {
  const on = chain.filter((slot) => slot.enabled);
  return on.length === 0 ? "No effects" : on.map((slot) => EFFECT_LABELS[slot.type]).join(" → ");
}

/** The effect categories of the "Add effect" menu (GP8 pedalboard style). */
export const EFFECT_CATEGORIES: { label: string; types: EffectType[] }[] = [
  { label: "Dynamics", types: ["gate", "compressor"] },
  { label: "Drive and amp", types: ["drive", "amp"] },
  { label: "Cabinet", types: ["cab"] },
  { label: "Equalizer", types: ["eq"] },
];

/**
 * The chain with a block of `type` (added at the end if there is none and
 * there is room), and that block's index (-1 if the chain is full).
 */
export function withFocusBlock(
  chain: readonly EffectSlot[],
  type: EffectType,
  limit: number,
): { chain: EffectSlot[]; index: number } {
  const index = chain.findIndex((slot) => slot.type === type);
  if (index >= 0) return { chain: [...chain], index };
  if (chain.length >= limit) return { chain: [...chain], index: -1 };
  return { chain: addEffect(chain, type, limit), index: chain.length };
}
