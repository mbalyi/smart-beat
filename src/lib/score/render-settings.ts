/**
 * The alphaTab settings every rendering of a score shares: the music font, the note bounds and
 * the palette. The song's player and the read-only preview of "Sheet from an audio lane" both
 * start from these, so the preview looks like the song.
 */
import { LogLevel, model, Settings } from "@coderline/alphatab";

import { rgbOf, SCORE_PALETTES, type ScoreTheme } from "@/lib/score/score-theme";

/** Puts a palette's colours in alphaTab's settings. */
export function applyPalette(settings: Settings, theme: ScoreTheme) {
  const p = SCORE_PALETTES[theme];
  const color = (hex: string, alpha = 255) => new model.Color(...rgbOf(hex), alpha);
  const resources = settings.display.resources;
  resources.mainGlyphColor = color(p.main);
  resources.secondaryGlyphColor = color(p.secondary, p.secondaryAlpha);
  resources.staffLineColor = color(p.staffLine);
  resources.barSeparatorColor = color(p.barSeparator);
  resources.barNumberColor = color(p.barNumber);
  resources.scoreInfoColor = color(p.scoreInfo);
}

/** New settings with the font, the log level and the note bounds (for hit-testing) set. */
export function baseRenderSettings(): Settings {
  const settings = new Settings();
  settings.core.fontDirectory = `${import.meta.env.BASE_URL}font/`;
  settings.core.logLevel = LogLevel.Warning;
  // Note positions, for clicking notes and drawing the edit cursor.
  settings.core.includeNoteBounds = true;
  return settings;
}
