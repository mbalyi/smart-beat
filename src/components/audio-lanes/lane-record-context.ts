import { createContext } from "react";

/** What the lanes' record icons need (#249): which lane is armed, and the press. */
export interface LaneRecordControls {
  /** The armed lane (one at a time), or null. */
  armedId: string | null;
  /** A take is being recorded. */
  recording: boolean;
  /** Arms the lane; on the armed lane it starts the take, and during the take it stops it. */
  toggle: (laneId: string) => void;
}

export const LaneRecordContext = createContext<LaneRecordControls | null>(null);
