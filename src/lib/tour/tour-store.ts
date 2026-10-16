import type { LayoutPrefs } from "@/lib/score/layout";

/** What the tours remember (#84): which tours are done, which hints were shown, the last version seen. */
export const TOUR_STORAGE_KEY = "smart-beat:tour";

/** Someone who used Smart Beat before the tours existed has seen everything up to this release. */
export const LEGACY_BASELINE_VERSION = "1.0.0";

/** `done`, `skipped` (never offer again), or the step an interrupted tour stopped at. */
export type TourProgress = "done" | "skipped" | { step: number };

export interface TourState {
  tours: Record<string, TourProgress>;
  hints: Record<string, true>;
  lastSeenVersion: string | null;
}

export const emptyTourState = (): TourState => ({ tours: {}, hints: {}, lastSeenVersion: null });

function isProgress(value: unknown): value is TourProgress {
  if (value === "done" || value === "skipped") return true;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { step?: unknown }).step === "number"
  );
}

/** The saved state, or null when nothing (valid) is saved. */
export function readTourState(): TourState | null {
  try {
    const raw = localStorage.getItem(TOUR_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<TourState> | null;
    if (!value || typeof value !== "object") return null;
    const tours: Record<string, TourProgress> = {};
    for (const [id, progress] of Object.entries(value.tours ?? {})) {
      if (isProgress(progress)) tours[id] = progress;
    }
    const hints: Record<string, true> = {};
    for (const [id, shown] of Object.entries(value.hints ?? {})) {
      if (shown === true) hints[id] = true;
    }
    return {
      tours,
      hints,
      lastSeenVersion: typeof value.lastSeenVersion === "string" ? value.lastSeenVersion : null,
    };
  } catch {
    return null;
  }
}

export function writeTourState(state: TourState): void {
  try {
    localStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Not remembered: the tour may be offered again at the next start.
  }
}

/**
 * Whether this profile is someone who used Smart Beat before the tours: it had saved panels, or
 * the layout decision found earlier use (both panels open is the classic layout).
 */
export function isExistingUser(layoutBefore: LayoutPrefs | null, layoutNow: LayoutPrefs): boolean {
  return layoutBefore !== null || (layoutNow.mixer && layoutNow.inspector);
}

/**
 * The state to start with. A fresh install has nothing and is offered the tour; an existing
 * user is never offered it (their layout does not change either) and sees "What's new" for
 * what came after the baseline. A saved state is returned as it is.
 */
export function initTourState(existingUser: boolean, version: string): TourState {
  const saved = readTourState();
  if (saved) return saved;
  const state: TourState = existingUser
    ? { tours: { main: "skipped" }, hints: {}, lastSeenVersion: LEGACY_BASELINE_VERSION }
    : { tours: {}, hints: {}, lastSeenVersion: version };
  writeTourState(state);
  return state;
}
