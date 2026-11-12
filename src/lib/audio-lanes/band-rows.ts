import type { AudioLane, AudioLanesSettings } from "@/lib/tauri";

/** A row of the band under the tabs: a lane and its place among all the song's lanes. */
export interface BandRow {
  lane: AudioLane;
  index: number;
}

/**
 * The rows the band under the tabs draws, in lane order. Only a lane shown in the score has a
 * row (turning a folder on shows the lanes inside), a closed folder hides its lanes, and a folder
 * has a header row only while at least one of its lanes is shown.
 */
export function bandRows(audio: Pick<AudioLanesSettings, "lanes">): BandRow[] {
  const byId = new Map(audio.lanes.map((lane) => [lane.id, lane]));
  const rows = audio.lanes.flatMap((lane, index) =>
    !lane.folder && lane.shownInScore === true ? [{ lane, index }] : [],
  );
  const folders = audio.lanes.flatMap((folder, index) =>
    folder.folder && rows.some(({ lane }) => lane.parent === folder.id)
      ? [{ lane: folder, index }]
      : [],
  );
  return [...rows, ...folders]
    .sort((a, b) => a.index - b.index)
    .filter(({ lane }) => {
      const folder = lane.parent ? byId.get(lane.parent) : undefined;
      return !folder?.collapsed;
    });
}

/** Whether the band under the tabs has anything to draw (otherwise it is not mounted at all). */
export function hasBandRows(audio: Pick<AudioLanesSettings, "lanes">): boolean {
  return bandRows(audio).length > 0;
}
