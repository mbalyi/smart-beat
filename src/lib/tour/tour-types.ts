import type { TourId } from "@/lib/tour/feature-registry";
import type { TourPanelRequest } from "@/lib/tour/tour-bus";

/**
 * The place a step points at: the value of a `data-tour` attribute on a real control, so a step
 * follows the control wherever it moves (no coordinates), and a missing one is skipped.
 * `tours.test.ts` checks that every target appears in the source.
 */
export type TourTarget = string;

export interface TourStep {
  id: string;
  target: TourTarget;
  title: string;
  body: string;
  /** The step needs an open song: the tour opens the demo song first when there is none. */
  needsSong?: boolean;
  /** Panels to show (or Edit mode) before the step; put back when the tour ends. */
  show?: TourPanelRequest;
  /**
   * The target is inside a dialog this step opens (`show.dialog`): the coach card is drawn at the
   * bottom of that dialog instead of floating over the page.
   */
  inDialog?: boolean;
  /** The last step of the main tour: lists the other tours to pick the next one from. */
  offerTours?: boolean;
  /** Where the coach mark sits relative to the target. */
  placement?: "top" | "bottom" | "left" | "right" | "center";
}

export interface TourDefinition {
  id: TourId;
  title: string;
  /** Shown in Help › Tours. */
  description: string;
  /** If this element is on screen when the tour starts, begin at the step with this id (a tour about a dialog the user already opened). */
  startAt?: { selector: string; step: string };
  steps: readonly TourStep[];
}
