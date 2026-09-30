/**
 * Smart Beat takes each track's volume out of the score model (the mixer
 * applies it on top, see `adoptTrack`). Files must carry the mix, so exporters
 * put it back into the model for the duration of the export.
 */
import type { Score } from "@/lib/score/model";
import { gpFromPan } from "@/lib/score/score";
import type { MixerSettings } from "@/lib/tauri";

const GP_MAX_VOLUME = 16;

/** Runs `write` with the mixer's volume, pan, mute and solo in the model, then restores it. */
export function withMix<T>(score: Score, mix: MixerSettings | null, write: () => T): T {
  const saved = score.tracks.map((track) => ({ ...track.playbackInfo }));
  try {
    if (mix) {
      score.tracks.forEach((track, index) => {
        const tm = mix.tracks[index];
        if (!tm) return;
        const info = track.playbackInfo;
        info.volume = Math.round(tm.volume * GP_MAX_VOLUME);
        info.balance = gpFromPan(tm.pan);
        info.isMute = tm.mute;
        info.isSolo = tm.solo;
      });
    }
    return write();
  } finally {
    score.tracks.forEach((track, index) => Object.assign(track.playbackInfo, saved[index]));
  }
}
