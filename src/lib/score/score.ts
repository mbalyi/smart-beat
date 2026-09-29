/**
 * Parsing Guitar Pro files into alphaTab's score model, plus the plain-data
 * summary the UI renders (so components never touch alphaTab types).
 */
import { AlphaTabError, importer, Settings, type model } from "@coderline/alphatab";

import type { TrackMix } from "@/lib/tauri";

export type Score = model.Score;

/** Which staves a track shows. `score` = standard notation. */
export type NotationView = "score-tab" | "score" | "tab";

export interface TrackView {
  notation: NotationView;
  /** Show rhythm (stems and beams) under the tablature. */
  rhythm: boolean;
}

export interface TrackSummary {
  index: number;
  name: string;
  isPercussion: boolean;
  /** Stringed tracks can show tablature; others only standard notation. */
  hasTablature: boolean;
  /** The view saved in the file. */
  defaultView: TrackView;
  /** Mixer values saved in the file. */
  mix: TrackMix;
}

export interface ScoreSummary {
  title: string;
  artist: string;
  tracks: TrackSummary[];
}

export interface LoadedScore {
  score: Score;
  summary: ScoreSummary;
}

/** Why a file could not be turned into a score. */
export class ScoreLoadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ScoreLoadError";
  }
}

/** Guitar Pro stores volume and balance as 0–16 (balance 8 = centre). */
const GP_MAX = 16;
const GP_CENTER = 8;

export const volumeFromGp = (volume: number) => clamp(volume / GP_MAX, 0, 1);
export const panFromGp = (balance: number) => clamp((balance - GP_CENTER) / GP_CENTER, -1, 1);
export const gpFromPan = (pan: number) => Math.round(GP_CENTER + clamp(pan, -1, 1) * GP_CENTER);

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function summarizeTrack(track: model.Track): TrackSummary {
  const staff = track.staves[0];
  const hasTablature = !track.isPercussion && (staff?.tuning.length ?? 0) > 0;
  const showsTab = hasTablature && (staff?.showTablature ?? false);
  const showsScore = !hasTablature || (staff?.showStandardNotation ?? true);
  const info = track.playbackInfo;
  return {
    index: track.index,
    name: track.name.trim() || `Track ${track.index + 1}`,
    isPercussion: track.isPercussion,
    hasTablature,
    defaultView: {
      notation: showsTab && showsScore ? "score-tab" : showsTab ? "tab" : "score",
      rhythm: false,
    },
    mix: {
      volume: volumeFromGp(info.volume),
      pan: panFromGp(info.balance),
      mute: info.isMute,
      solo: info.isSolo,
    },
  };
}

/**
 * Parses a Guitar Pro file (GP3–GP7). Throws {@link ScoreLoadError} for files
 * alphaTab cannot read.
 *
 * Each track's file volume becomes its starting mixer value, and the track is
 * then set to full volume in the model: the mixer applies the level on top, so
 * it can range from silent to full whatever the file says.
 */
export function parseScore(bytes: Uint8Array): LoadedScore {
  let score: Score;
  try {
    score = importer.ScoreLoader.loadScoreFromBytes(bytes, new Settings());
  } catch (error) {
    const reason =
      error instanceof AlphaTabError ? "it is damaged or in an unsupported format" : String(error);
    throw new ScoreLoadError(`The file could not be read: ${reason}.`, { cause: error });
  }
  if (score.tracks.length === 0) {
    throw new ScoreLoadError("The file does not contain any tracks.");
  }

  const summary: ScoreSummary = {
    title: score.title.trim(),
    artist: score.artist.trim(),
    tracks: score.tracks.map(summarizeTrack),
  };
  for (const track of score.tracks) track.playbackInfo.volume = GP_MAX;
  return { score, summary };
}

/** Applies a {@link TrackView} to the track's staves (before rendering). */
export function applyTrackView(track: model.Track, view: TrackView) {
  for (const staff of track.staves) {
    const stringed = !track.isPercussion && staff.tuning.length > 0;
    staff.showTablature = stringed && view.notation !== "score";
    staff.showStandardNotation = !stringed || view.notation !== "tab";
  }
}
