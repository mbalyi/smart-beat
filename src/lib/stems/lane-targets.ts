import type { StemLaneItem } from "@/lib/stems/stem-lanes";
import type { StemSong } from "@/lib/tauri";

/**
 * The open tabs that can take stems as audio lanes (#223). Every open tab keeps its own lanes
 * (its undo history and its mix), so the stem page cannot edit them from outside: the tab
 * registers a handler here while it is open, and the page calls it by the tab's id.
 */
export type StemLaneHandler = (
  song: Pick<StemSong, "engine">,
  items: readonly StemLaneItem[],
) => void;

const targets = new Map<number, StemLaneHandler>();

/** Lets the tab `id` take stems. Returns what to call when the tab closes. */
export function registerStemLaneTarget(id: number, handler: StemLaneHandler): () => void {
  targets.set(id, handler);
  return () => {
    if (targets.get(id) === handler) targets.delete(id);
  };
}

/**
 * Adds the stems to the tab `id` as audio lanes, in one undo step. Throws a readable error when
 * the tab cannot take them (no room for that many lanes, or it is gone).
 */
export function addStemsToTab(
  id: number,
  song: Pick<StemSong, "engine">,
  items: readonly StemLaneItem[],
): void {
  const handler = targets.get(id);
  if (!handler) throw new Error("That tab is not open any more.");
  handler(song, items);
}
