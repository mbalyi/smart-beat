/** Mixer state: master volume plus volume, pan, mute and solo per track. */
import type { ScoreSummary } from "@/lib/score/score";
import { MIXER_SETTINGS_VERSION, type MixerSettings, type TrackMix } from "@/lib/tauri";

export type MixerAction =
  | { type: "master"; value: number }
  | { type: "volume"; track: number; value: number }
  | { type: "pan"; track: number; value: number }
  | { type: "mute"; track: number; value: boolean }
  | { type: "solo"; track: number; value: boolean }
  | { type: "reset"; mix: MixerSettings };

/** The mix saved in the song file. */
export function mixFromScore(summary: ScoreSummary): MixerSettings {
  return {
    version: MIXER_SETTINGS_VERSION,
    master: 1,
    tracks: summary.tracks.map((track) => ({ ...track.mix })),
  };
}

/**
 * The mix to start with: the user's saved mix if it fits this song, otherwise
 * the one from the file.
 */
export function initialMix(summary: ScoreSummary, saved: MixerSettings | null): MixerSettings {
  const fromFile = mixFromScore(summary);
  if (saved?.version !== MIXER_SETTINGS_VERSION || saved.tracks.length !== fromFile.tracks.length) {
    return fromFile;
  }
  return saved;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function updateTrack(mix: MixerSettings, index: number, change: Partial<TrackMix>): MixerSettings {
  if (!mix.tracks[index]) return mix;
  return {
    ...mix,
    tracks: mix.tracks.map((track, i) => (i === index ? { ...track, ...change } : track)),
  };
}

export function mixerReducer(mix: MixerSettings, action: MixerAction): MixerSettings {
  switch (action.type) {
    case "master":
      return { ...mix, master: clamp(action.value, 0, 1) };
    case "volume":
      return updateTrack(mix, action.track, { volume: clamp(action.value, 0, 1) });
    case "pan":
      return updateTrack(mix, action.track, { pan: clamp(action.value, -1, 1) });
    case "mute":
      return updateTrack(mix, action.track, { mute: action.value });
    case "solo":
      return updateTrack(mix, action.track, { solo: action.value });
    case "reset":
      return action.mix;
  }
}

/** Whether a track is heard: not muted, and soloed if any track is. */
export function isAudible(mix: MixerSettings, index: number): boolean {
  const track = mix.tracks[index];
  if (!track || track.mute) return false;
  return track.solo || !mix.tracks.some((t) => t.solo);
}

/** Spoken/visible pan value, e.g. "Centre", "40% left". */
export function describePan(pan: number): string {
  const percent = Math.round(Math.abs(pan) * 100);
  if (percent === 0) return "Centre";
  return `${percent}% ${pan < 0 ? "left" : "right"}`;
}

export const describeVolume = (volume: number) => `${Math.round(volume * 100)}%`;
