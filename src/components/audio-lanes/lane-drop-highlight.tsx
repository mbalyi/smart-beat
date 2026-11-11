import { useSyncExternalStore } from "react";

import { dropLabel, laneDropTarget, type LaneDropTarget } from "@/lib/audio-lanes/drop-target";
import type { FileDragStore } from "@/lib/file-drag-store";

/** The part of a lane's box that is on screen: its scrolling ancestors cut the rest off. */
function visibleBox(target: LaneDropTarget) {
  let { left, top } = target.rect;
  let right = left + target.rect.width;
  let bottom = top + target.rect.height;
  const element = target.element as unknown as HTMLElement;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(parent);
    if (overflowX === "visible" && overflowY === "visible") continue;
    const box = parent.getBoundingClientRect();
    left = Math.max(left, box.left);
    top = Math.max(top, box.top);
    right = Math.min(right, box.right);
    bottom = Math.min(bottom, box.bottom);
  }
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Room the chip keeps from the window edge, in px (about half its width). */
const CHIP_EDGE = 120;
/** A lane this close to the window's top gets its chip inside, as there is no room above. */
const CHIP_ROOM = 28;

interface LaneDropHighlightProps {
  /** Where the dragged files are (missing: nothing is dragged, or not audio). */
  store?: FileDragStore;
  /** How many files are dragged. */
  count: number;
  /** Maps a (fractional) song bar to the audio timeline in ms. */
  msAtBar: (bar: number) => number;
  /** The landing time a drop at `ms` would use (the grid snap). */
  snapTo: (ms: number) => number;
  laneName: (laneId: string) => string;
}

/**
 * Marks where a dragged audio file would land: a quiet outline around the lane under the pointer,
 * a drop line at the snapped pointer position and a chip with the lane and the time above it.
 * The whole look lives here. It follows the pointer through the store, so only this component
 * re-renders while the pointer moves.
 */
export function LaneDropHighlight({
  store,
  count,
  msAtBar,
  snapTo,
  laneName,
}: LaneDropHighlightProps) {
  const point = useSyncExternalStore(
    store?.subscribe ?? NO_SUBSCRIPTION,
    () => store?.position ?? null,
  );
  if (!store || !point) return null;
  const target = laneDropTarget(point, msAtBar);
  if (!target) return null;
  const box = visibleBox(target);
  const lineX = Math.min(Math.max(point.x - box.left, 0), box.width);
  const chipX = Math.min(
    Math.max(point.x, CHIP_EDGE),
    Math.max(CHIP_EDGE, window.innerWidth - CHIP_EDGE),
  );
  const chipAbove = box.top >= CHIP_ROOM;
  return (
    <div
      aria-hidden="true"
      data-testid="lane-drop-highlight"
      data-drop-target={target.laneId}
      className="pointer-events-none fixed z-[60] rounded-sm outline-2 outline-offset-1 outline-primary"
      style={box}
    >
      <span
        data-testid="lane-drop-line"
        className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-primary"
        style={{ left: lineX }}
      />
      <span
        data-testid="lane-drop-label"
        className={
          "absolute -translate-x-1/2 rounded-md bg-primary px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-primary-foreground shadow-sm " +
          (chipAbove ? "bottom-full mb-1.5" : "top-1")
        }
        style={{ left: chipX - box.left }}
      >
        {dropLabel(laneName(target.laneId), snapTo(target.atMs), count)}
      </span>
    </div>
  );
}

const NO_SUBSCRIPTION = () => () => {};
