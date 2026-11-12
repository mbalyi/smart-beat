import type { StemKindId } from "@/lib/tauri";

/**
 * The colour of each separated part, as in the stem separation art: guitar violet, drums
 * magenta, bass cyan, vocals yellow, piano indigo. The CSS tokens (`--stem-*` in index.css)
 * hold a darker shade on the light theme so the waveform stays readable on white.
 */
export const STEM_COLOR_HEX: Readonly<Record<StemKindId, string>> = {
  guitar: "#a43bff",
  drums: "#ff2fa0",
  bass: "#19b6ff",
  vocals: "#ffd21a",
  piano: "#6b4bff",
  panned: "#ff8a1f",
  other: "#2dd4bf",
};

/** The order new audio lanes take their default colour in. */
export const STEM_COLOR_ORDER: readonly StemKindId[] = [
  "guitar",
  "drums",
  "bass",
  "vocals",
  "piano",
  "panned",
  "other",
];

/** The theme-aware CSS colour of a stem (`var(--stem-bass)`). */
export function stemColor(kind: StemKindId): string {
  return `var(--stem-${kind})`;
}
