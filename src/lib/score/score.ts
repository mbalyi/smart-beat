/**
 * Parsing Guitar Pro files into alphaTab's score model, plus the plain-data
 * summary the UI renders (so components never touch alphaTab types).
 */
import { AlphaTabError, importer, Settings, type model } from "@coderline/alphatab";

import { ScoreLoadError } from "@/lib/score/errors";
import { adoptLyrics } from "@/lib/score/lyrics";
import type { TrackKind } from "@/lib/score/music";
import type { TrackMix } from "@/lib/tauri";
import { mirrorOf, setDrumTab } from "@/lib/score/drum-tab";

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
  /** Tab can be shown: stringed tracks, and drums (as a drum tab with drum numbers). */
  canShowTab: boolean;
  kind: TrackKind;
  /** General MIDI program (0–127). */
  program: number;
  /** MIDI pitches of the strings, highest first (empty without strings). */
  tuning: number[];
  capo: number;
  /** The view saved in the file. */
  defaultView: TrackView;
  /** Mixer values saved in the file (or a new track's defaults). */
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

/** Guitar Pro stores volume and balance as 0–16 (balance 8 = centre). */
const GP_MAX = 16;
const GP_CENTER = 8;

export const volumeFromGp = (volume: number) => clamp(volume / GP_MAX, 0, 1);
export const panFromGp = (balance: number) => clamp((balance - GP_CENTER) / GP_CENTER, -1, 1);
export const gpFromPan = (pan: number) => Math.round(GP_CENTER + clamp(pan, -1, 1) * GP_CENTER);

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Mixer values each track started with (from the file, or a new track's defaults). */
const START_MIX = new WeakMap<model.Track, TrackMix>();

const mixFromPlayback = (info: model.PlaybackInformation): TrackMix => ({
  volume: volumeFromGp(info.volume),
  pan: panFromGp(info.balance),
  mute: info.isMute,
  solo: info.isSolo,
});

/**
 * Takes a track under the mixer's control: remembers its volume, pan, mute and
 * solo as its starting mix, then sets it to full volume in the model, so the
 * mixer can range from silent to full whatever the file says.
 */
export function adoptTrack(track: model.Track): void {
  if (!START_MIX.has(track)) START_MIX.set(track, mixFromPlayback(track.playbackInfo));
  track.playbackInfo.volume = GP_MAX;
}

export function rememberMix(track: model.Track, mix: TrackMix): void {
  START_MIX.set(track, { ...mix });
}

/** The mix a track started with. */
export const trackMix = (track: model.Track): TrackMix =>
  START_MIX.get(track) ?? mixFromPlayback(track.playbackInfo);

function trackKindOf(track: model.Track, hasTablature: boolean): TrackKind {
  if (track.isPercussion || track.staves[0]?.isPercussion) return "drums";
  return hasTablature ? "stringed" : "pitched";
}

function summarizeTrack(track: model.Track): TrackSummary {
  const staff = track.staves[0];
  const hasTablature = !track.isPercussion && (staff?.tuning.length ?? 0) > 0;
  const showsTab = hasTablature && (staff?.showTablature ?? false);
  const showsScore = !hasTablature || (staff?.showStandardNotation ?? true);
  return {
    index: track.index,
    name: track.name.trim() || `Track ${track.index + 1}`,
    isPercussion: track.isPercussion,
    hasTablature,
    canShowTab: hasTablature || trackKindOf(track, hasTablature) === "drums",
    kind: trackKindOf(track, hasTablature),
    program: track.playbackInfo.program,
    tuning: hasTablature ? [...staff!.tuning] : [],
    capo: staff?.capo ?? 0,
    defaultView: {
      notation: showsTab && showsScore ? "score-tab" : showsTab ? "tab" : "score",
      rhythm: false,
    },
    mix: { ...trackMix(track) },
  };
}

/** The plain-data summary of a (possibly edited) score. */
export function summarizeScore(score: Score): ScoreSummary {
  return {
    title: score.title.trim(),
    artist: score.artist.trim(),
    tracks: score.tracks.map(summarizeTrack),
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

  for (const track of score.tracks) {
    adoptTrack(track);
    adoptLyrics(track);
  }
  return { score, summary: summarizeScore(score) };
}

/**
 * Applies a {@link TrackView} to the track's staves (before rendering). A
 * drum track shows its tab through a mirror staff (see drum-tab.ts), which is
 * built or removed here; the drum staff itself is hidden for "tab".
 */
export function applyTrackView(track: model.Track, view: TrackView) {
  const drums = track.staves[0]?.isPercussion ?? false;
  if (drums) {
    setDrumTab(track.score, track, view.notation !== "score");
    track.staves[0]!.showStandardNotation = view.notation !== "tab";
    return;
  }
  if (track.score.tracks.some((t) => mirrorOf(t))) setDrumTab(track.score, track, false);
  for (const staff of track.staves) {
    const stringed = !track.isPercussion && staff.tuning.length > 0;
    staff.showTablature = stringed && view.notation !== "score";
    staff.showStandardNotation = !stringed || view.notation !== "tab";
  }
}
