import { useEffect, useLayoutEffect, useState, type KeyboardEvent } from "react";

import {
  ZOOM_STEP,
  clampZoom,
  fitSpan,
  wheelAction,
  zoomAroundLine,
  zoomAroundViewX,
  type TimeSpan,
  type ZoomLimits,
  type ZoomView,
} from "@/lib/audio-lanes/zoom";

export interface TimelineZoomOptions {
  /** The zoom the view opens at, pixels per second. */
  initial: number;
  limits: ZoomLimits;
  /** Where the timeline starts inside the scroller's content (the studio's lane headers), px. */
  offsetPx?: number;
  /** The whole song, for "Zoom to fit the song". */
  song: TimeSpan;
  /** The selected clips' extent or the time selection (null: nothing selected). */
  selection: TimeSpan | null;
  /** Where the position line is, ms: `=` and `-` zoom around it. */
  lineMs: () => number;
}

/** The keys of the zoom commands, as tooltips and `aria-keyshortcuts` name them. */
export const ZOOM_KEYS = {
  zoomIn: "=",
  zoomOut: "-",
  fit: "F",
  selection: "Z",
} as const;

/** A key typed into a field, a list or a slider belongs to it, not to the timeline. */
function isFieldKey(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return true;
  return /^(slider|spinbutton|combobox|textbox|menuitem)/.test(target.getAttribute("role") ?? "");
}

/** The zoom, and the scroll it brings with it once the new width is laid out (null: none). */
interface ZoomState {
  readonly pxPerSecond: number;
  readonly scrollLeft: number | null;
}

/**
 * The zoom of a timeline view (the lane editor, the studio): pixels per second, the zoom commands
 * (in and out around the position line, fit the song, fit the selection), ⌘/Ctrl-wheel zoom
 * around the pointer and a plain wheel scrolling sideways. The view puts `attachScroller` on its
 * scrolling element and `onKeyDown` on itself, so the keys work while it has focus.
 */
export function useTimelineZoom(options: TimelineZoomOptions) {
  const { initial, limits, offsetPx = 0, song, selection, lineMs } = options;
  const [state, setState] = useState<ZoomState>(() => ({
    pxPerSecond: clampZoom(initial, limits),
    scrollLeft: null,
  }));
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const { pxPerSecond } = state;

  // A new zoom changes the content's width: the scroll that goes with it is set once it is laid out.
  useLayoutEffect(() => {
    if (state.scrollLeft !== null) scroller?.scrollTo?.({ left: state.scrollLeft });
  }, [scroller, state]);

  const currentView = (): ZoomView => ({ pxPerSecond, scrollLeft: scroller?.scrollLeft ?? 0 });

  /** Shows a view: the zoom now and its scroll once laid out (at once when the zoom is the same). */
  const show = (view: ZoomView) => {
    if (view.pxPerSecond === pxPerSecond) scroller?.scrollTo?.({ left: view.scrollLeft });
    else setState({ pxPerSecond: view.pxPerSecond, scrollLeft: view.scrollLeft });
  };

  const setPxPerSecond = (next: number) =>
    setState({ pxPerSecond: clampZoom(next, limits), scrollLeft: null });

  const zoomBy = (factor: number) =>
    show(
      zoomAroundLine(currentView(), factor, lineMs(), scroller?.clientWidth ?? 0, limits, offsetPx),
    );
  const fitTo = (span: TimeSpan) =>
    show(fitSpan(span, scroller?.clientWidth ?? 0, limits, offsetPx));

  const zoomIn = () => zoomBy(ZOOM_STEP);
  const zoomOut = () => zoomBy(1 / ZOOM_STEP);
  const zoomToFit = () => fitTo(song);
  const zoomToSelection = () => {
    if (selection) fitTo(selection);
  };

  // A native listener: React's wheel listeners are passive, so they cannot stop the page zooming.
  // It is set again after every render, so it always sees the zoom of the moment.
  useEffect(() => {
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      const action = wheelAction(event);
      if (action.kind === "native") return;
      event.preventDefault();
      if (action.kind === "scroll") {
        scroller.scrollBy?.({ left: action.dx });
        return;
      }
      const viewX = event.clientX - scroller.getBoundingClientRect().left;
      show(zoomAroundViewX(currentView(), action.factor, viewX, limits, offsetPx));
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  });

  /** The zoom keys while the view has focus. Returns whether the key was used. */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): boolean => {
    if (event.metaKey || event.ctrlKey || event.altKey || isFieldKey(event.target)) return false;
    const commands: Readonly<Record<string, () => void>> = {
      "=": zoomIn,
      "+": zoomIn,
      "-": zoomOut,
      _: zoomOut,
      f: zoomToFit,
      ...(selection && { z: zoomToSelection }),
    };
    const command = commands[event.key.toLowerCase()];
    if (!command) return false;
    event.preventDefault();
    event.stopPropagation();
    command();
    return true;
  };

  return {
    pxPerSecond,
    setPxPerSecond,
    attachScroller: setScroller,
    zoomIn,
    zoomOut,
    zoomToFit,
    zoomToSelection,
    canZoomIn: pxPerSecond < limits.max,
    canZoomOut: pxPerSecond > limits.min,
    hasSelection: selection !== null,
    onKeyDown,
  };
}

export type TimelineZoom = ReturnType<typeof useTimelineZoom>;
