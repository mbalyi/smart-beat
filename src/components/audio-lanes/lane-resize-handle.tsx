import type { KeyboardEvent, PointerEvent } from "react";

import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import {
  MAX_LANE_HEIGHT,
  MIN_LANE_HEIGHT,
  laneHeight,
  resizeScope,
  resizeTargets,
  setLaneHeights,
} from "@/lib/audio-lanes/lane-height";
import type { AudioLane } from "@/lib/tauri";

/** An arrow key changes the height by this much, px. */
const KEY_STEP = 10;
const ARROW_STEPS: Readonly<Record<string, number>> = { ArrowUp: -KEY_STEP, ArrowDown: KEY_STEP };

const clampHeight = (height: number) =>
  Math.min(MAX_LANE_HEIGHT, Math.max(MIN_LANE_HEIGHT, Math.round(height)));

/**
 * The lower edge of a studio lane row: drag it (or use the up and down arrows) to resize the lane;
 * ⌥/Alt resizes the selected lanes with it, Shift every lane; a double-click resets the height.
 * The height is saved with the song, and a drag is one undo step.
 */
export function LaneResizeHandle({
  lanes,
  lane,
}: {
  lanes: AudioLanesController;
  lane: AudioLane;
}) {
  const height = laneHeight(lane);
  const targets = (keys: { altKey: boolean; shiftKey: boolean }) =>
    resizeTargets(lanes.audio, lane.id, lanes.selection, resizeScope(keys));

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const ids = targets(event);
    // The undo step starts with the first move, so a click (or a double-click) leaves none.
    let started = false;
    const move = (e: globalThis.PointerEvent) => {
      if (!started) lanes.beginGesture();
      started = true;
      lanes.applyQuiet((a) => setLaneHeights(a, ids, clampHeight(height + e.clientY - startY)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    // The edge moves with the arrow: down makes the lane taller.
    const step = ARROW_STEPS[event.key];
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    const ids = targets(event);
    lanes.apply((a) => setLaneHeights(a, ids, clampHeight(height + step)));
  };

  return (
    <button
      type="button"
      aria-label={`Resize ${lane.name} (${height} px): drag, or use the up and down arrows; Alt also resizes the selected lanes, Shift every lane; double-click resets`}
      title="Drag to resize (⌥/Alt: the selected lanes, Shift: every lane); double-click resets"
      data-testid={`lane-resize-${lane.id}`}
      className="absolute inset-x-0 -bottom-1 z-20 h-2 cursor-ns-resize bg-transparent outline-none hover:bg-primary/30 focus-visible:bg-primary/50 motion-safe:transition-colors"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={(event) => {
        const ids = targets(event);
        lanes.apply((a) => setLaneHeights(a, ids, undefined));
      }}
    />
  );
}
