/**
 * The state of dragging a transcribed part from the dialog's preview to the score (#235), as a
 * reducer so the rules can be tested alone: a press arms a drag, which starts after a few
 * pixels (more for a finger), and every way out is named.
 */
import type { PlacementSpot } from "@/lib/score/part-placement";

/** How far the pointer must move before a press becomes a drag (px). */
export const DRAG_SLOP = 4;
export const DRAG_SLOP_TOUCH = 8;

/** Why a drag ended without a drop. */
export type CancelReason =
  | "escape"
  | "pointercancel"
  | "lostcapture"
  | "blur"
  | "hidden"
  | "outside"
  | "invalid"
  | "tab-changed"
  | "release";

/** What is under the part now: a spot, and whether the track takes it. */
export interface Hover {
  spot: PlacementSpot;
  accepted: boolean;
}

export type DragState =
  | { kind: "idle"; cancelled: CancelReason | null }
  | { kind: "armed"; x: number; y: number; touch: boolean }
  | { kind: "dragging"; x: number; y: number; hover: Hover | null }
  | { kind: "keyboard"; hover: Hover | null };

export type DragAction =
  | { type: "press"; x: number; y: number; touch: boolean }
  | { type: "move"; x: number; y: number; hover: Hover | null }
  | { type: "hover"; hover: Hover | null }
  | { type: "pickup"; hover: Hover | null }
  | { type: "release" }
  | { type: "cancel"; reason: CancelReason };

export const IDLE: DragState = { kind: "idle", cancelled: null };

/** Whether the part is being placed (the dialog is see-through). */
export const isPlacing = (state: DragState): boolean =>
  state.kind === "dragging" || state.kind === "keyboard";

/** What a release (or Enter) drops on: a spot that takes the part, or nothing. */
export function dropSpot(state: DragState): PlacementSpot | null {
  if (state.kind !== "dragging" && state.kind !== "keyboard") return null;
  return state.hover?.accepted ? state.hover.spot : null;
}

export function dragReducer(state: DragState, action: DragAction): DragState {
  switch (action.type) {
    case "press":
      return state.kind === "idle"
        ? { kind: "armed", x: action.x, y: action.y, touch: action.touch }
        : state;
    case "move": {
      if (state.kind === "armed") {
        const slop = state.touch ? DRAG_SLOP_TOUCH : DRAG_SLOP;
        if (Math.hypot(action.x - state.x, action.y - state.y) < slop) return state;
        return { kind: "dragging", x: action.x, y: action.y, hover: action.hover };
      }
      if (state.kind === "dragging") {
        return { kind: "dragging", x: action.x, y: action.y, hover: action.hover };
      }
      return state;
    }
    case "hover":
      return state.kind === "dragging"
        ? { ...state, hover: action.hover }
        : state.kind === "keyboard"
          ? { kind: "keyboard", hover: action.hover }
          : state;
    case "pickup":
      return state.kind === "idle" ? { kind: "keyboard", hover: action.hover } : state;
    case "release":
      // A press that never became a drag is a click: nothing was placed and nothing was cancelled.
      return state.kind === "armed" ? IDLE : { kind: "idle", cancelled: null };
    case "cancel":
      return state.kind === "idle" ? state : { kind: "idle", cancelled: action.reason };
  }
}
