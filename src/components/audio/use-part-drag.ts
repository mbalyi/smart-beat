import { useCallback, useEffect, useRef, useState } from "react";

import { INSTRUMENT_LABEL, type LanePart } from "@/lib/audio-lanes/lane-transcribe";
import { describeBars } from "@/lib/audio-lanes/lane-transcribe";
import {
  dragReducer,
  dropSpot,
  IDLE,
  isPlacing,
  type CancelReason,
  type DragAction,
  type DragState,
  type Hover,
} from "@/lib/score/part-drag";
import { activePartDropTarget, type PartHighlight } from "@/lib/score/part-drop-registry";
import {
  acceptsPart,
  autoScrollDelta,
  firstSpot,
  moveSpot,
  PLACEMENT_KEYS,
  placementBoxes,
  type PlacementKey,
  type PlacementSpot,
} from "@/lib/score/part-placement";

/** What the dialog shows while the part is carried: the chip beside the pointer and the hints. */
export interface PartDragView {
  placing: boolean;
  mode: "pointer" | "keyboard" | null;
  /** The pointer, for the chip (window pixels). */
  x: number;
  y: number;
  /** "Piano to Bass, bar 5, 8 bars", or why the part cannot go here. */
  chip: string;
  accepted: boolean;
}

export interface PartDragOptions {
  part: LanePart | null;
  /** How many bars the part covers when it starts at a bar (0-based). */
  barsAt: (bar: number) => number;
  /** The track and bar the dialog has chosen: where a part picked up by the keyboard starts. */
  want: { track: number | null; bar: number };
  /** The part was dropped on the score (the dialog closes). */
  onDropped: () => void;
}

/**
 * Carrying the part from the dialog's preview to the score (#235). Pointer events, not HTML5 drag
 * and drop (the modal dialog blocks drop targets, and the desktop app keeps its own file drop on):
 * the grip arms a drag, the dialog goes see-through, the score outlines the bars under the pointer
 * and a release on a bar that takes the part writes it. The same moves work from the keyboard.
 */
export function usePartDrag(options: PartDragOptions) {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  const stateRef = useRef<DragState>(IDLE);
  const [state, setState] = useState<DragState>(IDLE);
  const [announcement, setAnnouncement] = useState("");
  const [view, setView] = useState<PartDragView>({
    placing: false,
    mode: null,
    x: 0,
    y: 0,
    chip: "",
    accepted: true,
  });
  const pointer = useRef({ x: 0, y: 0 });
  const pointerId = useRef<number | null>(null);

  const send = useCallback((action: DragAction): DragState => {
    const next = dragReducer(stateRef.current, action);
    stateRef.current = next;
    setState(next);
    return next;
  }, []);

  /** The words for a spot: where the part would land and what it does there. */
  const describe = (spot: PlacementSpot, accepted: boolean) => {
    const target = activePartDropTarget();
    const { part, barsAt } = optionsRef.current;
    if (!target || !part) return { chip: "", text: "", bars: 0 };
    const name = target.nameOf(spot.track);
    const bars = barsAt(spot.bar);
    const label = INSTRUMENT_LABEL[part.instrument];
    return accepted
      ? {
          chip: `${label} to ${name}, ${describeBars(spot.bar, spot.bar + bars - 1)}`,
          text: `Replaces ${bars} ${bars === 1 ? "bar" : "bars"}`,
          bars,
        }
      : {
          chip: `${label} does not fit on ${name}`,
          text: `A ${label.toLowerCase()} part does not fit on ${name}`,
          bars,
        };
  };

  const hoverAt = (x: number, y: number): Hover | null => {
    const target = activePartDropTarget();
    const part = optionsRef.current.part;
    if (!target || !part) return null;
    const spot = target.spotAt(x, y);
    if (!spot) return null;
    const kind = target.kindOf(spot.track);
    return { spot, accepted: kind !== null && acceptsPart(part.instrument, kind) };
  };

  /** Draws the outline for a hover, and what the chip says. */
  const present = (hover: Hover | null, x: number, y: number, mode: "pointer" | "keyboard") => {
    const target = activePartDropTarget();
    let highlight: PartHighlight | null = null;
    let chip = "Move over a bar of the tab";
    if (target && hover) {
      const words = describe(hover.spot, hover.accepted);
      const boxes = placementBoxes(
        target.rects() ?? [],
        hover.spot.track,
        hover.spot.bar,
        hover.spot.bar + Math.max(words.bars, 1) - 1,
      );
      highlight = {
        boxes,
        startX: boxes[0]?.x ?? null,
        invalid: !hover.accepted,
        text: words.text,
      };
      chip = words.chip;
    }
    target?.show(highlight);
    setView({ placing: true, mode, x, y, chip, accepted: hover?.accepted ?? true });
    return chip;
  };

  const finish = useCallback(
    (reason: CancelReason | null, message = "") => {
      activePartDropTarget()?.show(null);
      pointerId.current = null;
      setView((v) => ({ ...v, placing: false, mode: null }));
      if (reason) send({ type: "cancel", reason });
      else send({ type: "release" });
      if (message) setAnnouncement(message);
    },
    [send],
  );

  const drop = (spot: PlacementSpot | null, reasonIfNone: CancelReason) => {
    const target = activePartDropTarget();
    const part = optionsRef.current.part;
    if (!spot || !target || !part) {
      finish(reasonIfNone, "Cancelled. The sheet was not added.");
      return;
    }
    const written = target.drop(spot, part);
    if (written) {
      finish(null, "Added to the score.");
      optionsRef.current.onDropped();
    } else {
      finish("invalid", "The sheet could not be added there.");
    }
  };

  // --- Pointer --------------------------------------------------------------------------------
  const onGripPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !optionsRef.current.part) return;
    pointer.current = { x: event.clientX, y: event.clientY };
    pointerId.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The window listeners carry the drag without it.
    }
    send({
      type: "press",
      x: event.clientX,
      y: event.clientY,
      touch: event.pointerType === "touch",
    });
  };

  // --- Keyboard pick-up -----------------------------------------------------------------------
  const onGripKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (stateRef.current.kind !== "idle") return;
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    void pickUp();
  };
  const pickUp = async () => {
    const { part, want } = optionsRef.current;
    // The score may be drawing again after an edit: its bars are known a moment later.
    let target = activePartDropTarget();
    for (let tries = 0; tries < 15 && target && !target.rects(); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      target = activePartDropTarget();
    }
    if (stateRef.current.kind !== "idle") return;
    const rects = target?.rects();
    const accepts = (track: number) => {
      const kind = target?.kindOf(track);
      return !!part && !!kind && acceptsPart(part.instrument, kind);
    };
    const spot = rects ? firstSpot(rects, accepts, want) : null;
    if (!target || !part || !spot) {
      setAnnouncement(
        "The tab shows no track that takes this part right now. Use the Add to score button.",
      );
      return;
    }
    const hover = { spot, accepted: true };
    send({ type: "pickup", hover });
    target.reveal(spot);
    const chip = present(hover, 0, 0, "keyboard");
    setAnnouncement(
      `Picked up the sheet. ${chip}. Arrow keys move it, Page Up and Page Down jump four bars, Enter drops it, Escape cancels.`,
    );
  };

  // --- While it is carried -----------------------------------------------------------------------
  const placing = isPlacing(state);
  const active = state.kind !== "idle";
  useEffect(() => {
    if (!active) return;
    const onMove = (event: PointerEvent) => {
      if (pointerId.current !== null && event.pointerId !== pointerId.current) return;
      pointer.current = { x: event.clientX, y: event.clientY };
      const current = stateRef.current;
      if (current.kind === "dragging" && event.buttons === 0 && event.pointerType === "mouse") {
        // The button went up where nothing heard it: take it as a release.
        drop(dropSpot(current), "outside");
        return;
      }
      if (current.kind !== "armed" && current.kind !== "dragging") return;
      const hover = hoverAt(event.clientX, event.clientY);
      const next = send({ type: "move", x: event.clientX, y: event.clientY, hover });
      if (next.kind === "dragging") {
        event.preventDefault();
        present(next.hover, event.clientX, event.clientY, "pointer");
      }
    };
    const onUp = (event: PointerEvent) => {
      if (pointerId.current !== null && event.pointerId !== pointerId.current) return;
      const current = stateRef.current;
      if (current.kind === "armed") {
        finish(null);
        return;
      }
      if (current.kind === "dragging") {
        const hover = hoverAt(event.clientX, event.clientY);
        drop(hover?.accepted ? hover.spot : null, hover ? "invalid" : "outside");
      }
    };
    const onCancel = (event: PointerEvent) => {
      if (pointerId.current !== null && event.pointerId !== pointerId.current) return;
      if (stateRef.current.kind === "dragging" || stateRef.current.kind === "armed") {
        finish("pointercancel", "Cancelled. The sheet was not added.");
      }
    };
    const onBlur = () => finish("blur", "Cancelled. The sheet was not added.");
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        finish("hidden", "Cancelled. The sheet was not added.");
      }
    };
    const onKey = (event: KeyboardEvent) => {
      const current = stateRef.current;
      if (current.kind === "idle") return;
      if (event.key === "Escape") {
        // Not the dialog's: a second Escape closes it.
        event.preventDefault();
        event.stopPropagation();
        finish("escape", "Cancelled. The sheet was not added.");
        return;
      }
      if (current.kind !== "keyboard") return;
      const target = activePartDropTarget();
      const part = optionsRef.current.part;
      if (!target || !part) {
        finish("tab-changed", "Cancelled. The tab changed.");
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        const hover = current.hover;
        if (hover && hover.accepted) drop(hover.spot, "invalid");
        else setAnnouncement("This track does not take the part. Move to another track.");
        return;
      }
      if (!PLACEMENT_KEYS.includes(event.key) || !current.hover) return;
      event.preventDefault();
      event.stopPropagation();
      const rects = target.rects() ?? [];
      const spot = moveSpot(current.hover.spot, event.key as PlacementKey, rects, (track) => {
        const kind = target.kindOf(track);
        return !!kind && acceptsPart(part.instrument, kind);
      });
      const kind = target.kindOf(spot.track);
      const hover = { spot, accepted: !!kind && acceptsPart(part.instrument, kind) };
      send({ type: "hover", hover });
      target.reveal(spot);
      const chip = present(hover, 0, 0, "keyboard");
      setAnnouncement(`${chip}. ${describe(spot, hover.accepted).text}.`);
    };
    window.addEventListener("pointermove", onMove, { capture: true });
    window.addEventListener("pointerup", onUp, { capture: true });
    window.addEventListener("pointercancel", onCancel, { capture: true });
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("pointermove", onMove, { capture: true });
      window.removeEventListener("pointerup", onUp, { capture: true });
      window.removeEventListener("pointercancel", onCancel, { capture: true });
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("keydown", onKey, { capture: true });
    };
    // The handlers read what changes through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // The song or the tab changed under the part: it cannot be dropped.
  useEffect(() => {
    if (!placing) return;
    const watch = setInterval(() => {
      if (!activePartDropTarget()) finish("tab-changed", "Cancelled. The tab changed.");
    }, 200);
    return () => clearInterval(watch);
  }, [placing, finish]);

  // Near the edge of the score the view scrolls, and the bar under the pointer is found again.
  const pointerMode = state.kind === "dragging";
  useEffect(() => {
    if (!pointerMode) return;
    let frame = 0;
    const tick = () => {
      const target = activePartDropTarget();
      const box = target?.viewport();
      if (target && box) {
        const { x, y } = pointer.current;
        const inside = x >= box.left && x <= box.right;
        const dx = inside ? autoScrollDelta(x, box.left, box.right) : 0;
        const dy =
          x >= box.left - 40 && x <= box.right + 40 ? autoScrollDelta(y, box.top, box.bottom) : 0;
        const current = stateRef.current;
        const lost = current.kind === "dragging" && current.hover === null;
        if (dx !== 0 || dy !== 0 || lost) {
          if (dx !== 0 || dy !== 0) target.scrollBy(dx, dy);
          // Also when the bars were not known a moment ago (the score was drawing again).
          const hover = hoverAt(x, y);
          if (dx !== 0 || dy !== 0 || hover) {
            send({ type: "hover", hover });
            present(hover, x, y, "pointer");
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointerMode]);

  // Closing the dialog while it is carried puts everything back.
  useEffect(
    () => () => {
      activePartDropTarget()?.show(null);
    },
    [],
  );

  return { placing, state, view, announcement, onGripPointerDown, onGripKeyDown };
}
