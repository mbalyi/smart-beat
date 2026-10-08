/** How many colours tracks cycle through (`--track-1` … `--track-8` in index.css). */
export const TRACK_COLOR_COUNT = 8;

/** Colours a person can pick for a track, as `#rrggbb` (the picker's swatches). */
export const TRACK_PALETTE: readonly { name: string; hex: string }[] = [
  { name: "Red", hex: "#e5484d" },
  { name: "Orange", hex: "#f76b15" },
  { name: "Amber", hex: "#e2a336" },
  { name: "Lime", hex: "#8db654" },
  { name: "Green", hex: "#30a46c" },
  { name: "Teal", hex: "#12a594" },
  { name: "Cyan", hex: "#00a2c7" },
  { name: "Blue", hex: "#3e63dd" },
  { name: "Indigo", hex: "#6e6adb" },
  { name: "Violet", hex: "#a35ed6" },
  { name: "Pink", hex: "#d6409f" },
  { name: "Grey", hex: "#8d8d8d" },
];

const HEX = /^#[0-9a-f]{6}$/i;
export const isTrackColor = (value: unknown): value is string =>
  typeof value === "string" && HEX.test(value);

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
/** OKLCH (L 0…1, C, H in degrees) of a `#rrggbb` colour. */
export function hexToOklch(hex: string): { l: number; c: number; h: number } {
  const [r, g, b] = [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255)) as [
    number,
    number,
    number,
  ];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lab = {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
  const c = Math.hypot(lab.a, lab.b);
  const h = c < 1e-4 ? 0 : ((Math.atan2(lab.b, lab.a) * 180) / Math.PI + 360) % 360;
  return { l: lab.l, c, h };
}

/**
 * The colour of a track (by position, unless the user chose one) as a CSS colour. A chosen
 * colour keeps its hue and chroma, but its lightness is held between `--track-l-min` and
 * `--track-l-max` (index.css, one range per theme): never black on the dark theme or white on
 * the light one.
 */
export function trackColor(index: number, custom?: string | null): string {
  if (!isTrackColor(custom)) return `var(--track-${(index % TRACK_COLOR_COUNT) + 1})`;
  const { l, c, h } = hexToOklch(custom);
  return `oklch(clamp(var(--track-l-min), ${l.toFixed(3)}, var(--track-l-max)) ${c.toFixed(3)} ${h.toFixed(1)})`;
}
