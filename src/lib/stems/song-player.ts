import { createStemPlayer, createWebAudioBackend, type StemPlayer } from "@/lib/stems/player";
import { readStem, renderStemMix, STEM_KINDS, type StemSong } from "@/lib/tauri";

/** The parts a song has, in the order the page lists them. */
export const songKinds = (song: StemSong) =>
  STEM_KINDS.filter((kind) => song.stems.some((stem) => stem.kind === kind));

/** Makes the player of a song: Web Audio with the Rust commands. Null where there is no Web Audio. */
export function createSongPlayer(song: StemSong): StemPlayer | null {
  const backend = createWebAudioBackend();
  if (!backend) return null;
  return createStemPlayer({
    kinds: songKinds(song),
    backend,
    durationSeconds: song.durationSeconds,
    source: {
      readStem: (kind) => readStem(song.id, kind),
      renderMix: (gains, speed) => renderStemMix(song.id, gains, speed),
    },
  });
}
