/** How many colours tracks cycle through (`--track-1` … `--track-8` in index.css). */
export const TRACK_COLOR_COUNT = 8;

/** The colour of a track (by position): a CSS variable, so it follows the theme. */
export function trackColor(index: number): string {
  return `var(--track-${(index % TRACK_COLOR_COUNT) + 1})`;
}
