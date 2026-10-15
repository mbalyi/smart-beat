import { createContext, useContext } from "react";

import type { TourId } from "@/lib/tour/feature-registry";
import type { TourState } from "@/lib/tour/tour-store";

export interface TourHost {
  /** Whether a song is open (some steps need one). */
  hasSong: () => boolean;
  /** Opens the bundled demo song. */
  openDemo: () => void;
}

export interface TourApi {
  /** Null until the first launch has been decided. */
  state: TourState | null;
  /** The tour that is running, if any. */
  active: TourId | null;
  /** A fresh install that was not yet offered the tour. */
  offerMainTour: boolean;
  /** Decides first launch vs. existing user; call once at start. */
  init: (existingUser: boolean) => TourState | null;
  /** The app tells the tours how to see whether a song is open and how to open the demo song. */
  bindHost: (host: TourHost) => void;
  start: (id: TourId, fromStep?: number) => void;
  /** "Skip for now" on the welcome card: never offered again. */
  dismissMainTour: () => void;
  /** Where an interrupted tour stopped (null: not interrupted). */
  resumeStep: (id: TourId) => number | null;
  /** Records that the "What's new" list was seen up to the running version. */
  markVersionSeen: () => void;
  /** Shows a one-time tip with a "Show me" button; only the first call per id does anything. */
  hint: (id: string, tour: TourId, message: string) => void;
  /** Forgets which tips were shown ("Reset Tips"). */
  resetHints: () => void;
}

/** Without a provider (a test, a story) the tours simply do nothing. */
const NO_TOURS: TourApi = {
  state: null,
  active: null,
  offerMainTour: false,
  init: () => null,
  bindHost: () => undefined,
  start: () => undefined,
  dismissMainTour: () => undefined,
  resumeStep: () => null,
  markVersionSeen: () => undefined,
  hint: () => undefined,
  resetHints: () => undefined,
};

export const TourContext = createContext<TourApi>(NO_TOURS);

export function useTour(): TourApi {
  return useContext(TourContext);
}
