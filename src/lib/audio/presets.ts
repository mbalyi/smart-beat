/**
 * Presets: the bundled ones (a data file, `presets.json`, with our own
 * settings: no third-party presets or recordings) and the user's own, kept in
 * this browser's storage. Two kinds (#42): an effect chain for a track or the
 * master, and a drum mix (kit piece levels and pans plus the drum bus chain).
 */
import type { TrackSummary } from "@/lib/score/score";
import type { DrumMixer } from "@/lib/tauri";

import { MAX_MASTER_EFFECTS, MAX_TRACK_EFFECTS, type EffectSlot } from "@/lib/audio/effects";
import data from "@/lib/audio/presets.json";

export type PresetTarget = "guitar" | "bass" | "drums" | "master";

export const GENRES = ["nu-metal", "metalcore", "hardcore", "deathcore", "djent"] as const;
export type Genre = (typeof GENRES)[number];

export const GENRE_LABELS: Record<Genre, string> = {
  "nu-metal": "Nu-metal",
  metalcore: "Metalcore",
  hardcore: "Hardcore",
  deathcore: "Deathcore",
  djent: "Djent",
};

export const TARGET_LABELS: Record<PresetTarget, string> = {
  guitar: "Guitar",
  bass: "Bass",
  drums: "Drums",
  master: "Master",
};

/** "chain": an effect chain; "drumMix": a drum mixer setting plus the drum bus chain. */
export type PresetKind = "chain" | "drumMix";

export interface Preset {
  id: string;
  kind: PresetKind;
  name: string;
  target: PresetTarget;
  genres: Genre[];
  description: string;
  chain: EffectSlot[];
  /** Drum mixes: the kit pieces' levels, pans and mono/stereo. */
  drums?: DrumMixer;
  /** Saved by the user (can be deleted). */
  user?: boolean;
}

export const BUILTIN_PRESETS: readonly Preset[] = data.presets as Preset[];

const USER_PRESETS_KEY = "smart-beat:effect-presets";

/** Which presets suit a track: drums, bass (GM programs 33–40) or guitar and the rest. */
export function presetTargetOf(track: Pick<TrackSummary, "kind" | "program">): PresetTarget {
  if (track.kind === "drums") return "drums";
  return track.program >= 32 && track.program <= 39 ? "bass" : "guitar";
}

export function readUserPresets(): Preset[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(USER_PRESETS_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? (parsed as Preset[])
          .filter((p) => typeof p?.id === "string" && Array.isArray(p.chain))
          // Presets saved before drum mixes existed are chains.
          .map((p) => ({ ...p, kind: p.kind ?? "chain", user: true }))
      : [];
  } catch {
    return [];
  }
}

function storeUserPresets(presets: Preset[]) {
  try {
    localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(presets));
  } catch {
    // Storage unavailable: the preset lasts for this session only.
  }
}

/** Saves a chain as a user preset (replacing one with the same name and target). */
export function saveUserPreset(name: string, target: PresetTarget, chain: EffectSlot[]): Preset {
  const limit = target === "master" ? MAX_MASTER_EFFECTS : MAX_TRACK_EFFECTS;
  const preset: Preset = {
    id: `user:${target}:${name.trim().toLowerCase()}`,
    kind: "chain",
    name: name.trim(),
    target,
    genres: [],
    description: "Your preset",
    chain: chain.slice(0, limit),
    user: true,
  };
  const others = readUserPresets().filter((p) => p.id !== preset.id);
  storeUserPresets([...others, preset]);
  return preset;
}

export function deleteUserPreset(id: string) {
  storeUserPresets(readUserPresets().filter((p) => p.id !== id));
}

/** Chain presets for a target, optionally of one genre (user presets always match). */
export function presetsFor(target: PresetTarget, genre: Genre | null = null): Preset[] {
  return allPresets().filter(
    (p) =>
      p.kind === "chain" &&
      p.target === target &&
      (genre === null || p.user || p.genres.includes(genre)),
  );
}

/** Every preset, bundled and the user's. */
export const allPresets = (): Preset[] => [...BUILTIN_PRESETS, ...readUserPresets()];

export interface PresetFilter {
  target?: PresetTarget | null;
  genre?: Genre | null;
  kind?: PresetKind | null;
  /** Matches the name or the description. */
  query?: string;
}

/** The preset browser's filter (#42). */
export function filterPresets(presets: readonly Preset[], filter: PresetFilter): Preset[] {
  const query = filter.query?.trim().toLowerCase() ?? "";
  return presets.filter(
    (p) =>
      (!filter.target || p.target === filter.target) &&
      (!filter.kind || p.kind === filter.kind) &&
      (!filter.genre || p.user || p.genres.includes(filter.genre)) &&
      (!query || `${p.name} ${p.description}`.toLowerCase().includes(query)),
  );
}

/** A deep copy of a drum mix preset's kit settings. */
export const drumsOf = (preset: Preset): DrumMixer | null =>
  preset.drums ? structuredClone(preset.drums) : null;

/** A deep copy of a preset's chain, ready to put on a track. */
export const chainOf = (preset: Preset): EffectSlot[] => structuredClone(preset.chain);
