/** The colours the score is drawn in, for light and dark mode (#83). */
export type ScoreTheme = "light" | "dark";

/** `#rrggbb` colours, plus an alpha (0…255) where alphaTab draws something lighter. */
export interface ScorePalette {
  /** The paper behind the score. */
  paper: string;
  /** Notes, rests, clefs, tab numbers. */
  main: string;
  /** Lighter glyphs (alphaTab draws them at alpha 100). */
  secondary: string;
  secondaryAlpha: number;
  staffLine: string;
  barSeparator: string;
  barNumber: string;
  /** Title, artist and other song information. */
  scoreInfo: string;
}

export const SCORE_PALETTES: Record<ScoreTheme, ScorePalette> = {
  // alphaTab's own colours, with lighter glyphs a little darker (3:1 on white).
  light: {
    paper: "#ffffff",
    main: "#000000",
    secondary: "#000000",
    secondaryAlpha: 120,
    staffLine: "#a5a5a5",
    barSeparator: "#222211",
    barNumber: "#c80000",
    scoreInfo: "#000000",
  },
  dark: {
    paper: "#18181b",
    main: "#ececee",
    secondary: "#ececee",
    secondaryAlpha: 150,
    staffLine: "#8a8a93",
    barSeparator: "#c8c8cc",
    barNumber: "#ff8a80",
    scoreInfo: "#ececee",
  },
};

/** The `[r, g, b]` of a `#rrggbb` colour (0…255). */
export const rgbOf = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** WCAG contrast ratio of two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = rgbOf(hex).map((c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `color` blended over `paper` at `alpha` (0…255): what the eye sees. */
export function blend(color: string, paper: string, alpha: number): string {
  const [c, p] = [rgbOf(color), rgbOf(paper)];
  const mixed = c.map((v, i) => Math.round((v * alpha + p[i]! * (255 - alpha)) / 255));
  return `#${mixed.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
