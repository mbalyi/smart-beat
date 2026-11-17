/**
 * Where a transcribed part can be dropped (#235): the workspace that is on screen registers
 * itself while it is active, so a part dropped from the dialog reaches exactly one score, and
 * the dialog does not need to know the player, the editor or the overlay.
 */
import type { LanePart } from "@/lib/audio-lanes/lane-transcribe";
import type { BoxRect, PlacementRect, PlacementSpot } from "@/lib/score/part-placement";

/** The outline the score draws while a part is over it. */
export interface PartHighlight {
  boxes: BoxRect[];
  /** Where the part starts (the left edge of its first bar), in the score's pixels. */
  startX: number | null;
  /** The part does not fit here (the wrong kind of track). */
  invalid: boolean;
  text: string;
}

export interface PartDropTarget {
  /** The score on screen takes drops. */
  active: () => boolean;
  /** The bars as drawn now (null: nothing is drawn, or the lookup is not ready). */
  rects: () => PlacementRect[] | null;
  /** The spot under a point of the window, or null. */
  spotAt: (clientX: number, clientY: number) => PlacementSpot | null;
  /** The kind of a track (an index) of the song, for what it accepts. */
  kindOf: (track: number) => string | null;
  nameOf: (track: number) => string;
  barCount: () => number;
  /** Draws (or clears, with null) the outline of the target. */
  show: (highlight: PartHighlight | null) => void;
  /** Writes the part at a spot; true when it was written. */
  drop: (spot: PlacementSpot, part: LanePart) => boolean;
  /** The box the score scrolls in, in window pixels, and a way to scroll it. */
  viewport: () => DOMRect | null;
  scrollBy: (dx: number, dy: number) => void;
  /** Scrolls so that a spot is in view (for the keyboard). */
  reveal: (spot: PlacementSpot) => void;
}

let current: PartDropTarget | null = null;

/** Registers the target of the workspace on screen; returns what removes it again. */
export function registerPartDropTarget(target: PartDropTarget): () => void {
  current = target;
  return () => {
    if (current === target) current = null;
  };
}

/** The target that is on screen and takes drops, if any. */
export function activePartDropTarget(): PartDropTarget | null {
  return current && current.active() ? current : null;
}
