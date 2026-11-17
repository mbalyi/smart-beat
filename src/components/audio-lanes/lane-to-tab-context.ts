import { createContext, useContext } from "react";

import type { LaneToTabRequest } from "@/lib/audio-lanes/lane-transcribe-request";

/** Opens the "Sheet from an audio lane" dialog. Only provided inside a workspace in the desktop app. */
export interface LaneToTabHost {
  open: (request: LaneToTabRequest) => void;
}

const LaneToTabContext = createContext<LaneToTabHost | null>(null);

export const LaneToTabProvider = LaneToTabContext.Provider;

/** The dialog opener, or `undefined` where the feature is not available (browser build, no workspace). */
export function useLaneToTab(): LaneToTabHost | undefined {
  return useContext(LaneToTabContext) ?? undefined;
}
