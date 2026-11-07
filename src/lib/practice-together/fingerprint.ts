import { writeAlphaTex } from "@/lib/export/alphatex";
import type { ScoreFingerprint } from "@/lib/practice-together/protocol";
import { fileKey } from "@/lib/score/format";
import type { Score } from "@/lib/score/model";

/**
 * What each player sets for themselves and what is not the music: a track's volume, balance,
 * mute and solo, and which notation a staff shows. alphaTex writes all of them, so a mute or a
 * switch to "Tablature only" would otherwise make the two apps think they have different tabs.
 */
function withoutPersonalSettings<T>(score: Score, run: () => T): T {
  const saved: (() => void)[] = [];
  for (const track of score.tracks) {
    const info = track.playbackInfo;
    const { volume, balance, isMute, isSolo } = info;
    saved.push(() => Object.assign(info, { volume, balance, isMute, isSolo }));
    Object.assign(info, { volume: 8, balance: 8, isMute: false, isSolo: false });
    for (const staff of track.staves) {
      const { showTablature, showStandardNotation, showSlash, showNumbered } = staff;
      saved.push(() =>
        Object.assign(staff, { showTablature, showStandardNotation, showSlash, showNumbered }),
      );
      Object.assign(staff, {
        showTablature: true,
        showStandardNotation: true,
        showSlash: false,
        showNumbered: false,
      });
    }
  }
  try {
    return run();
  } finally {
    for (const restore of saved) restore();
  }
}

/**
 * Identifies the score as it is open now, edits included: the SHA-256 of its alphaTex text. Two
 * apps with the same file open (and no different edits) get the same key, whatever the file
 * format, and whatever each has muted, soloed, turned up or switched in the view.
 */
export async function scoreFingerprint(score: Score): Promise<ScoreFingerprint> {
  const text = withoutPersonalSettings(score, () => writeAlphaTex(score));
  return { key: await fileKey(new TextEncoder().encode(text)), bars: score.masterBars.length };
}
