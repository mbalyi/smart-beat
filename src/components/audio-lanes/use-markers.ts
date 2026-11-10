import { useCallback, useMemo, useState, type KeyboardEvent } from "react";

import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import {
  addMarker,
  addRegion,
  clipsExtent,
  markerNumber,
  nextMarker,
  previousMarker,
} from "@/lib/audio-lanes/markers";

/** A span of the timeline, in ms. */
export interface TimeSpan {
  startMs: number;
  endMs: number;
}

/** The marker or region whose name is being edited, and where (the ruler or the list). */
export type Renaming = {
  kind: "marker" | "region";
  id: string;
  place: "ruler" | "list";
} | null;

export interface MarkerOptions {
  /** The time selection, when the view has one (a region is made from it first). */
  timeSelection?: TimeSpan | null;
  /** Selects a span of the timeline (double-click on a region); the edit cursor moves anyway. */
  onSelectSpan?: (span: TimeSpan) => void;
}

/** The marker and region shortcuts, as a shortcut list shows them. */
export const MARKER_SHORTCUTS: readonly { keys: string; action: string }[] = [
  { keys: "M", action: "Add a marker at the position line" },
  { keys: "⇧M", action: "Add a marker and name it" },
  { keys: ", .", action: "Go to the previous or next marker" },
  { keys: "1 … 9", action: "Go to marker 1 to 9" },
];

/** Keys typed into these go to the field, never to the shortcuts. */
const TEXT_FIELD = "input, textarea, select, [contenteditable='true'], [role='textbox']";

const isTyping = (target: EventTarget) =>
  target instanceof Element && target.closest(TEXT_FIELD) !== null;
const onClip = (target: EventTarget) =>
  target instanceof Element && target.closest("[data-clip-id]") !== null;

/**
 * The user's markers and regions as a view works on them: adding (at the position line, or a
 * region from the time selection), going to them, the name being edited, and the keyboard
 * shortcuts for the studio and the lane editor.
 */
export function useMarkers(lanes: AudioLanesController, options: MarkerOptions = {}) {
  const { timeSelection = null, onSelectSpan } = options;
  const { apply, lineMs, setEditCursorMs, selection, audio } = lanes;
  const [renaming, setRenaming] = useState<Renaming>(null);

  /** Adds a marker at the position line; with `name`, opens its name field. */
  const addAtLine = useCallback(
    (name: boolean) => {
      const id = globalThis.crypto.randomUUID();
      apply((a) => addMarker(a, lineMs(), id));
      if (name) setRenaming({ kind: "marker", id, place: "ruler" });
    },
    [apply, lineMs],
  );

  // The studio's time selection when there is one; the lane editor has none, so a region spans
  // the selected clips there.
  const regionSpan = useMemo(
    () => timeSelection ?? clipsExtent(audio, selection),
    [audio, selection, timeSelection],
  );

  const addRegionFromSelection = useCallback(() => {
    if (!regionSpan) return;
    apply((a) => addRegion(a, regionSpan.startMs, regionSpan.endMs));
  }, [apply, regionSpan]);

  const selectSpan = useCallback(
    (span: TimeSpan) => {
      setEditCursorMs(span.startMs);
      onSelectSpan?.({ startMs: span.startMs, endMs: span.endMs });
    },
    [onSelectSpan, setEditCursorMs],
  );

  /** Jumps by marker: -1 the previous one, 1 the next one. */
  const step = useCallback(
    (direction: -1 | 1) => {
      const at = lineMs();
      const target = direction < 0 ? previousMarker(audio, at) : nextMarker(audio, at);
      if (target) setEditCursorMs(target.ms);
    },
    [audio, lineMs, setEditCursorMs],
  );

  /** Handles a marker shortcut; returns whether the key was used. */
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>): boolean => {
      if (event.defaultPrevented || isTyping(event.target)) return false;
      if (event.metaKey || event.ctrlKey || event.altKey) return false;
      let used = true;
      if (event.key.toLowerCase() === "m") addAtLine(event.shiftKey);
      else if (event.key === "," && !onClip(event.target)) step(-1);
      else if (event.key === "." && !onClip(event.target)) step(1);
      else if (/^[1-9]$/.test(event.key)) {
        const target = markerNumber(audio, Number(event.key));
        if (target) setEditCursorMs(target.ms);
      } else used = false;
      if (used) event.preventDefault();
      return used;
    },
    [addAtLine, audio, setEditCursorMs, step],
  );

  return {
    renaming,
    setRenaming,
    addAtLine,
    /** Where a new region would go (null: no time selection and no selected clips). */
    regionSpan,
    /** What a new region is made from, as a menu says it. */
    regionLabel: timeSelection
      ? "Region from the time selection"
      : "Region from the selected clips",
    addRegionFromSelection,
    goTo: setEditCursorMs,
    selectSpan,
    onKeyDown,
  };
}

export type MarkerControls = ReturnType<typeof useMarkers>;
