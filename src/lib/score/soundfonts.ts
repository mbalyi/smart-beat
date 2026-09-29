/**
 * Instrument sound sets. Sonivox ships with alphaTab (copied to /soundfont/
 * by its Vite plugin); FluidR3 is downloaded by scripts/fetch-soundfonts.mjs.
 */

export type SoundFontId = "sonivox" | "fluidr3";

export interface SoundFont {
  id: SoundFontId;
  label: string;
  description: string;
  url: string;
}

const base = import.meta.env.BASE_URL;

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

export function isSoundFontId(value: unknown): value is SoundFontId {
  return SOUNDFONTS.some((font) => font.id === value);
}

export function getSoundFont(id: SoundFontId): SoundFont {
  return SOUNDFONTS.find((font) => font.id === id) ?? SOUNDFONTS[0]!;
}

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
