import { engineLabel } from "@/components/stems/stem-engines";
import { stemName } from "@/components/stems/stem-labels";
import { addClip, addLane, addSource } from "@/lib/audio-lanes/edits";
import { MAX_LANES, newClip, newLane } from "@/lib/audio-lanes/model";
import { STEM_COLOR_HEX } from "@/lib/stems/colors";
import type { AudioLanesSettings, SourceInfo, StemKindId, StemSong } from "@/lib/tauri";

/** A stem that was loaded as an audio file, ready to become a lane. */
export interface StemLaneItem {
  kind: StemKindId;
  info: SourceInfo;
}

/** What a stem lane is called: the stem and the model variant that made it ("Vocals · SCNet XL"). */
export function stemLaneName(kind: StemKindId, song: Pick<StemSong, "engine">): string {
  return `${stemName(kind, song.engine)} · ${engineLabel(song.engine)}`;
}

/** How many more lanes a song can take. */
export const freeLanes = (audio: Pick<AudioLanesSettings, "lanes">): number =>
  Math.max(0, MAX_LANES - audio.lanes.length);

/**
 * Adds each stem to the audio as a lane of its own with one clip that starts at the beginning of
 * the song and plays the whole stem. Nothing is added when they would not all fit. The edit
 * touches only the audio: the notes and the other lanes stay as they are.
 */
export function addStemLanes(
  audio: AudioLanesSettings,
  song: Pick<StemSong, "engine">,
  items: readonly StemLaneItem[],
): AudioLanesSettings {
  if (items.length === 0 || items.length > freeLanes(audio)) return audio;
  let next = audio;
  for (const { kind, info } of items) {
    const name = stemLaneName(kind, song);
    next = addSource(next, { id: info.id, name: info.name, ext: info.ext, embedded: true });
    const lane = { ...newLane(name), color: STEM_COLOR_HEX[kind] };
    next = addLane(next, lane);
    next = addClip(next, lane.id, newClip(info.id, name, 0, info.durationMs));
  }
  return next;
}
