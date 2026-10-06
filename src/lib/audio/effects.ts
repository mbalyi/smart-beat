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

/** Mirrors `LimiterParams` in `dsp/limiter.rs` (#39). */
export interface LimiterParams {
  ceilingDb: number;
  releaseMs: number;
  lookaheadMs: number;
  inputDb: number;
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

export type Voicing = "clean" | "crunch" | "lead";

/** Mirrors `AmpSimParams` in `src-tauri/src/audio/dsp/amp_sim.rs`. */
export interface AmpSimParams {
  voicing: Voicing;
  gain: number;
  bassDb: number;
  midDb: number;
  trebleDb: number;
  presence: number;
  masterDb: number;
}

/** Mirrors `ChorusParams` in `src-tauri/src/audio/dsp/modulation.rs`. */
export interface ChorusParams {
  rateHz: number;
  depth: number;
  delayMs: number;
  mix: number;
}

export interface PhaserParams {
  rateHz: number;
  depth: number;
  feedback: number;
  mix: number;
}

export interface TremoloParams {
  rateHz: number;
  depth: number;
  shape: number;
  stereo: boolean;
}

/** Mirrors `DelayParams` in `src-tauri/src/audio/dsp/delay.rs`. */
export interface DelayParams {
  timeMs: number;
  feedback: number;
  mix: number;
  highCutHz: number;
  pingPong: boolean;
}

/** Mirrors `ReverbParams` in `src-tauri/src/audio/dsp/reverb.rs`. */
export interface ReverbParams {
  size: number;
  damping: number;
  mix: number;
  preDelayMs: number;
  width: number;
}

export type EffectConfig =
  | ({ type: "gate" } & GateParams)
  | ({ type: "compressor" } & CompressorParams)
  | { type: "eq"; bands: EqBand[] }
  | ({ type: "drive" } & DriveParams)
  | ({ type: "ampSim" } & AmpSimParams)
  | ({ type: "chorus" } & ChorusParams)
  | ({ type: "phaser" } & PhaserParams)
  | ({ type: "tremolo" } & TremoloParams)
  | ({ type: "delay" } & DelayParams)
  | ({ type: "reverb" } & ReverbParams)
  | ({ type: "limiter" } & LimiterParams)
  | { type: "amp"; model: string; inputDb: number; outputDb: number; matchLoudness: boolean }
  | { type: "cab"; ir: string };

export type EffectType = EffectConfig["type"];

export type EffectSlot = EffectConfig & { enabled: boolean };
type AmpBlock = Extract<EffectSlot, { type: "amp" }>;
type CabBlock = Extract<EffectSlot, { type: "cab" }>;

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
  ampSim: "Amp",
  chorus: "Chorus",
  phaser: "Phaser",
  tremolo: "Tremolo",
  delay: "Delay",
  reverb: "Reverb",
  limiter: "Limiter",
  amp: "Amp (capture)",
  cab: "Cabinet",
};

export const EFFECT_DESCRIPTIONS: Record<EffectType, string> = {
  gate: "Silences hiss and ringing between notes.",
  compressor: "Evens out the level; tightens drums and chugs.",
  eq: "Shapes the tone band by band.",
  drive: "Boost, overdrive, distortion or fuzz.",
  ampSim: "A built-in amp: clean, crunch or lead, with a tone stack.",
  chorus: "Doubles the sound with a slightly moving copy.",
  phaser: "A sweeping, swirling notch filter.",
  tremolo: "Pulses the volume, or pans side to side.",
  delay: "Echoes, with darker repeats and an optional ping-pong.",
  reverb: "Room ambience, from a small room to a hall.",
  limiter: "Makes the mix loud and keeps its peaks under a ceiling (mastering).",
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
  ampSim: [
    { key: "gain", label: "Gain", min: 0, max: 1, step: 0.01, unit: "" },
    { key: "bassDb", label: "Bass", min: -12, max: 12, step: 0.5, unit: "dB" },
    { key: "midDb", label: "Mid", min: -12, max: 12, step: 0.5, unit: "dB" },
    { key: "trebleDb", label: "Treble", min: -12, max: 12, step: 0.5, unit: "dB" },
    { key: "presence", label: "Presence", min: 0, max: 1, step: 0.01, unit: "" },
    { key: "masterDb", label: "Master", min: -40, max: 12, step: 0.5, unit: "dB" },
  ],
  chorus: [
    { key: "rateHz", label: "Rate", min: 0.05, max: 10, step: 0.05, unit: "Hz" },
    { key: "depth", label: "Depth", min: 0, max: 1, step: 0.01, unit: "" },
    { key: "delayMs", label: "Delay", min: 5, max: 30, step: 0.5, unit: "ms" },
    { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01, unit: "" },
  ],
  phaser: [
    { key: "rateHz", label: "Rate", min: 0.05, max: 10, step: 0.05, unit: "Hz" },
    { key: "depth", label: "Depth", min: 0, max: 1, step: 0.01, unit: "" },
    { key: "feedback", label: "Feedback", min: 0, max: 0.9, step: 0.01, unit: "" },
    { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01, unit: "" },
  ],
  tremolo: [
    { key: "rateHz", label: "Rate", min: 0.1, max: 20, step: 0.1, unit: "Hz" },
    { key: "depth", label: "Depth", min: 0, max: 1, step: 0.01, unit: "" },
    { key: "shape", label: "Shape", min: 0, max: 1, step: 0.01, unit: "" },
  ],
  delay: [
    { key: "timeMs", label: "Time", min: 1, max: 2000, step: 1, unit: "ms" },
    { key: "feedback", label: "Feedback", min: 0, max: 0.95, step: 0.01, unit: "" },
    { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01, unit: "" },
    { key: "highCutHz", label: "High cut", min: 500, max: 20000, step: 100, unit: "Hz" },
  ],
  reverb: [
    { key: "size", label: "Size", min: 0, max: 1, step: 0.01, unit: "" },
    { key: "damping", label: "Damping", min: 0, max: 1, step: 0.01, unit: "" },
    { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01, unit: "" },
    { key: "preDelayMs", label: "Pre-delay", min: 0, max: 200, step: 1, unit: "ms" },
    { key: "width", label: "Width", min: 0, max: 1, step: 0.01, unit: "" },
  ],
  limiter: [
    { key: "inputDb", label: "Input", min: 0, max: 24, step: 0.5, unit: "dB" },
    { key: "ceilingDb", label: "Ceiling", min: -24, max: 0, step: 0.1, unit: "dB" },
    { key: "releaseMs", label: "Release", min: 1, max: 2000, step: 1, unit: "ms" },
    { key: "lookaheadMs", label: "Lookahead", min: 0.1, max: 5, step: 0.1, unit: "ms" },
  ],
  amp: [
    { key: "inputDb", label: "Input", min: -24, max: 24, step: 0.5, unit: "dB" },
    { key: "outputDb", label: "Output", min: -24, max: 24, step: 0.5, unit: "dB" },
  ],
};

/** A parameter picked from a list (a switch on the pedal). */
export interface ChoiceSpec {
  key: string;
  label: string;
  options: { value: string; label: string }[];
}

export const CHOICES: Partial<Record<EffectType, ChoiceSpec[]>> = {
  drive: [
    {
      key: "mode",
      label: "Type",
      options: [
        { value: "boost", label: "Clean boost" },
        { value: "overdrive", label: "Overdrive (tube screamer)" },
        { value: "distortion", label: "Distortion" },
        { value: "fuzz", label: "Fuzz" },
      ],
    },
  ],
  ampSim: [
    {
      key: "voicing",
      label: "Channel",
      options: [
        { value: "clean", label: "Clean" },
        { value: "crunch", label: "Crunch" },
        { value: "lead", label: "Lead" },
      ],
    },
  ],
};

/** An on/off parameter. */
export interface ToggleSpec {
  key: string;
  label: string;
}

export const TOGGLES: Partial<Record<EffectType, ToggleSpec[]>> = {
  tremolo: [{ key: "stereo", label: "Stereo (auto-pan)" }],
  delay: [{ key: "pingPong", label: "Ping-pong" }],
  amp: [{ key: "matchLoudness", label: "Match loudness" }],
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
    case "ampSim":
      return {
        type,
        enabled: true,
        voicing: "crunch",
        gain: 0.5,
        bassDb: 0,
        midDb: 0,
        trebleDb: 0,
        presence: 0.5,
        masterDb: 0,
      };
    case "chorus":
      return { type, enabled: true, rateHz: 0.8, depth: 0.5, delayMs: 12, mix: 0.5 };
    case "phaser":
      return { type, enabled: true, rateHz: 0.4, depth: 0.7, feedback: 0.4, mix: 0.5 };
    case "tremolo":
      return { type, enabled: true, rateHz: 5, depth: 0.5, shape: 0, stereo: false };
    case "delay":
      return {
        type,
        enabled: true,
        timeMs: 375,
        feedback: 0.35,
        mix: 0.3,
        highCutHz: 6000,
        pingPong: false,
      };
    case "reverb":
      return { type, enabled: true, size: 0.5, damping: 0.5, mix: 0.25, preDelayMs: 10, width: 1 };
    case "limiter":
      return { type, enabled: true, ceilingDb: -1, releaseMs: 80, lookaheadMs: 1.5, inputDb: 0 };
    case "amp":
      return { type, enabled: true, model: "", inputDb: 0, outputDb: 0, matchLoudness: false };
    case "cab":
      return { type, enabled: true, ir: "builtin:4x12-modern" };
  }
}

/** "4.0 dB", "1:1", "60%", "2.5 kHz"... */
export function formatParam(spec: ParamSpec, value: number): string {
  if (spec.unit === ":1") return `${value.toFixed(1)}:1`;
  if (spec.unit === "") return `${Math.round(value * 100)}%`;
  if (spec.unit === "Hz" && value >= 1000) return `${(value / 1000).toFixed(1)} kHz`;
  const digits = spec.step < 0.1 ? 2 : spec.step < 1 ? 1 : 0;
  return `${value.toFixed(digits)} ${spec.unit}`;
}

/** Sets a choice or on/off parameter (ignored if the block has no such parameter). */
export function withOption(slot: EffectSlot, key: string, value: string | boolean): EffectSlot {
  const choice = CHOICES[slot.type]?.find((c) => c.key === key);
  const toggle = TOGGLES[slot.type]?.find((t) => t.key === key);
  if (choice && typeof value === "string" && choice.options.some((o) => o.value === value)) {
    return { ...slot, [key]: value } as EffectSlot;
  }
  if (toggle && typeof value === "boolean") return { ...slot, [key]: value } as EffectSlot;
  return slot;
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

/** The effect categories of the pedalboard library (GP8 pedalboard style). */
export const EFFECT_CATEGORIES: { label: string; types: EffectType[] }[] = [
  { label: "Dynamics", types: ["gate", "compressor", "limiter"] },
  { label: "Drive and amp", types: ["drive", "ampSim", "amp"] },
  { label: "Cabinet", types: ["cab"] },
  { label: "Equalizer", types: ["eq"] },
  { label: "Modulation", types: ["chorus", "phaser", "tremolo"] },
  { label: "Time", types: ["delay", "reverb"] },
];

/** Inserts a new block of `type` at `index` (when there is room). */
export function insertEffect(
  chain: readonly EffectSlot[],
  type: EffectType,
  index: number,
  limit: number,
): EffectSlot[] {
  if (chain.length >= limit) return [...chain];
  const next = [...chain];
  next.splice(Math.max(0, Math.min(index, chain.length)), 0, defaultEffect(type));
  return next;
}

/**
 * Inserts a block that uses a file from the user's sound library: an amp
 * capture (`kind` "amp") or a cabinet (`kind` "cab").
 */
export function insertAsset(
  chain: readonly EffectSlot[],
  asset: { kind: "amp" | "cab"; id: string },
  index: number,
  limit: number,
): EffectSlot[] {
  if (chain.length >= limit) return [...chain];
  const block: EffectSlot =
    asset.kind === "amp"
      ? { ...(defaultEffect("amp") as AmpBlock), model: asset.id }
      : { ...(defaultEffect("cab") as CabBlock), ir: asset.id };
  const next = [...chain];
  next.splice(Math.max(0, Math.min(index, chain.length)), 0, block);
  return next;
}

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
