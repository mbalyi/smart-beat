/**
 * Instrument sound sets. Sonivox ships with alphaTab (copied to /soundfont/
 * by its Vite plugin); FluidR3 is downloaded by scripts/fetch-soundfonts.mjs.
 * Any others are SoundFonts the user imported or downloaded (#81): they live in the app data
 * folder and are loaded by the native engine from there, so their "url" is `stored:<id>`.
 */

import type { StoredSoundFont } from "@/lib/tauri";

export type BundledSoundFontId = "sonivox" | "fluidr3";
/** A bundled id, or `stored:<id>` for a SoundFont the user added. */
export type SoundFontId = string;

export interface SoundFont {
  id: SoundFontId;
  label: string;
  description: string;
  url: string;
  /** The user added it (imported or downloaded) and can remove it. */
  stored?: boolean;
  /** The catalogue bank it is (none for bundled and imported ones). */
  catalogue?: string | null;
}

const base = import.meta.env.BASE_URL;

/** The sound sets that ship with the app. */
export const SOUNDFONTS: readonly SoundFont[] = [
  {
    id: "sonivox",
    label: "Standard",
    description: "Sonivox, small and quick to load (1 MB)",
    url: `${base}soundfont/sonivox.sf3`,
  },
  {
    id: "fluidr3",
    label: "High quality",
    description: "FluidR3 Mono, richer instruments (15 MB)",
    url: `${base}soundfont/FluidR3Mono_GM.sf3`,
  },
];

export const DEFAULT_SOUNDFONT: SoundFontId = "sonivox";

export const SOUNDFONT_STORAGE_KEY = "smart-beat:soundfont";

export const STORED_PREFIX = "stored:";

export const storedSoundFontId = (id: string): SoundFontId => `${STORED_PREFIX}${id}`;

/** A SoundFont the user added (its file is in the app data folder). */
export const isStoredSoundFontId = (id: string) => id.startsWith(STORED_PREFIX);

/** The id inside the app data folder (`stored:<id>` → `<id>`). */
export const storedKey = (id: SoundFontId) => id.slice(STORED_PREFIX.length);

export function isSoundFontId(value: unknown): value is SoundFontId {
  return (
    typeof value === "string" &&
    (SOUNDFONTS.some((font) => font.id === value) ||
      (isStoredSoundFontId(value) && value.length > STORED_PREFIX.length))
  );
}

const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;

/** The picker entry of a SoundFont the user added. */
export function soundFontFromStored(info: StoredSoundFont): SoundFont {
  const id = storedSoundFontId(info.id);
  return {
    id,
    label: info.name,
    description: `${info.catalogue ? "Downloaded" : "Imported"}, ${megabytes(info.bytes)}`,
    url: id,
    stored: true,
    catalogue: info.catalogue,
  };
}

/** The bundled sound sets, then the ones the user added. */
export const allSoundFonts = (stored: readonly SoundFont[] = []): readonly SoundFont[] => [
  ...SOUNDFONTS,
  ...stored,
];

export function getSoundFont(id: SoundFontId, stored: readonly SoundFont[] = []): SoundFont {
  return allSoundFonts(stored).find((font) => font.id === id) ?? SOUNDFONTS[0]!;
}

/** What the player loads for a sound set: a bundled file's URL, or `stored:<id>` as it is. */
export const soundFontUrl = (id: SoundFontId): string =>
  isStoredSoundFontId(id) ? id : getSoundFont(id).url;

export function readSoundFontPreference(): SoundFontId {
  try {
    const stored = localStorage.getItem(SOUNDFONT_STORAGE_KEY);
    return isSoundFontId(stored) ? stored : DEFAULT_SOUNDFONT;
  } catch {
    return DEFAULT_SOUNDFONT; // storage can be unavailable (privacy settings)
  }
}

export function storeSoundFontPreference(id: SoundFontId) {
  try {
    localStorage.setItem(SOUNDFONT_STORAGE_KEY, id);
  } catch {
    // Not remembered, but still used for this session.
  }
}
