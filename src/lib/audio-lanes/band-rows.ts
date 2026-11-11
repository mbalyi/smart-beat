import type { AudioLane, AudioLanesSettings } from "@/lib/tauri";

/** A row of the band under the tabs: a lane and its place among all the song's lanes. */
export interface BandRow {
  lane: AudioLane;
  index: number;
}

/**
 * The rows the band under the tabs draws, in lane order. A lane hidden from the score has no row
 * (its folder's hiding covers the lanes inside), a closed folder hides its lanes, and a folder
 * has a header row only while at least one of its lanes is shown (a folder with no lanes at all
 * keeps its header, so an empty folder can still be opened).
 */
export function bandRows(audio: Pick<AudioLanesSettings, "lanes">): BandRow[] {
  const byId = new Map(audio.lanes.map((lane) => [lane.id, lane]));
  const hidden = (lane: AudioLane) =>
    lane.hiddenInScore === true || (!!lane.parent && byId.get(lane.parent)?.hiddenInScore === true);
  const rows = audio.lanes.flatMap((lane, index) => (hidden(lane) ? [] : [{ lane, index }]));
  const shownInside = (folderId: string) =>
    rows.some(({ lane }) => lane.parent === folderId && !lane.folder);
  const hasLanes = (folderId: string) => audio.lanes.some((l) => l.parent === folderId);
  return rows.filter(({ lane }) => {
    const folder = lane.parent ? byId.get(lane.parent) : undefined;
    if (folder?.collapsed) return false;
    return !lane.folder || shownInside(lane.id) || !hasLanes(lane.id);
  });
}

/** Whether the band under the tabs has anything to draw (otherwise it is not mounted at all). */
export function hasBandRows(audio: Pick<AudioLanesSettings, "lanes">): boolean {
  return bandRows(audio).length > 0;
}
