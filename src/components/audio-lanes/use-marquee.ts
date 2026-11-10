import { useRef, useState, type PointerEvent } from "react";

import {
  boxBetween,
  clipsInBox,
  marqueeSelection,
  sameSelection,
  type Box,
  type ClipBox,
  type RowBox,
} from "@/lib/audio-lanes/selection";

/** Pixels a press on empty lane space must travel before it draws a selection rectangle. */
export const MARQUEE_PX = 4;

const LANE = "[data-lane-id]";
const CLIP = "[data-clip-id]";

export interface ModifierKeys {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

export interface MarqueeOptions {
  selection: readonly string[];
  select: (ids: readonly string[]) => void;
  /** A press that did not drag: the host's click on empty space (the edit cursor). */
  onTap: (event: PointerEvent<HTMLElement>) => void;
  /** Where the lane rows a rectangle can reach are (default: only the lane pressed). */
  scope?: (lane: HTMLElement) => ParentNode | null;
  /** Whether the keys held add to the selection (default: Shift, ⌘ or Ctrl). */
  additive?: (keys: ModifierKeys) => boolean;
}

interface Press {
  x: number;
  y: number;
  base: readonly string[];
  root: ParentNode;
  dragging: boolean;
  additive: boolean;
  last: readonly string[] | null;
}

const anyModifier = (keys: ModifierKeys) => keys.shiftKey || keys.metaKey || keys.ctrlKey;

/** The lane rows under `root` (and `root` itself when it is a lane) and their clips, on screen. */
function measureLanes(root: ParentNode): { rows: RowBox[]; clips: ClipBox[] } {
  const own = root instanceof HTMLElement && root.matches(LANE) ? [root] : [];
  const lanes = [...own, ...root.querySelectorAll<HTMLElement>(LANE)];
  const rows = lanes.map((el) => {
    const r = el.getBoundingClientRect();
    return { laneId: el.dataset.laneId ?? "", top: r.top, bottom: r.bottom };
  });
  const clips = lanes.flatMap((el) =>
    [...el.querySelectorAll<HTMLElement>(CLIP)].map((clip) => {
      const r = clip.getBoundingClientRect();
      return {
        id: clip.dataset.clipId ?? "",
        laneId: el.dataset.laneId ?? "",
        left: r.left,
        right: r.right,
      };
    }),
  );
  return { rows, clips };
}

/**
 * Framing clips with a rectangle: a drag on empty lane space (past a few pixels) selects every
 * clip it touches, across the lanes in `scope`; Shift or ⌘ held adds them to the selection. A
 * press without a drag is handed to `onTap`. Spread `handlers` on the lane's empty space and draw
 * `box` (screen pixels) while it is set.
 */
export function useMarquee({
  selection,
  select,
  onTap,
  scope,
  additive = anyModifier,
}: MarqueeOptions) {
  const [box, setBox] = useState<Box | null>(null);
  const press = useRef<Press | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    const lane = event.currentTarget;
    press.current = {
      x: event.clientX,
      y: event.clientY,
      base: selection,
      root: scope?.(lane) ?? lane,
      dragging: false,
      additive: additive(event),
      last: null,
    };
    lane.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p) return;
    if (!p.dragging && Math.hypot(event.clientX - p.x, event.clientY - p.y) < MARQUEE_PX) return;
    p.dragging = true;
    p.additive = p.additive || additive(event);
    const next = boxBetween(p, { x: event.clientX, y: event.clientY });
    setBox(next);
    const { rows, clips } = measureLanes(p.root);
    const ids = marqueeSelection(p.base, clipsInBox(next, rows, clips), p.additive);
    if (p.last && sameSelection(ids, p.last)) return;
    p.last = ids;
    select(ids);
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const p = press.current;
    press.current = null;
    setBox(null);
    if (p && !p.dragging) onTap(event);
  };

  const onPointerCancel = () => {
    press.current = null;
    setBox(null);
  };

  return {
    box,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}
