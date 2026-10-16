/** A tour in progress: which tour, which step, and the direction it last moved (for skipped steps). */
export interface TourRun {
  tour: string;
  index: number;
  direction: 1 | -1;
}

export type TourEvent = "next" | "back" | "missing" | "close" | "skip";
export type TourEnd = "done" | "skipped" | "interrupted";

export interface TourTransition {
  run: TourRun | null;
  /** Set when the tour ended with this event. */
  ended?: TourEnd;
}

export function startRun(tour: string, index = 0): TourRun {
  return { tour, index, direction: 1 };
}

/** The pure state machine behind every tour; the provider only renders it. */
export function transition(run: TourRun, event: TourEvent, size: number): TourTransition {
  switch (event) {
    case "skip":
      return { run: null, ended: "skipped" };
    case "close":
      return { run: null, ended: "interrupted" };
    case "back":
      return { run: { ...run, index: Math.max(0, run.index - 1), direction: -1 } };
    case "next":
      return advance(run, 1, size);
    case "missing":
      // A step whose control is not there is passed over in the direction we were going.
      return run.direction === 1 ? advance(run, 1, size) : retreat(run, size);
  }
}

function advance(run: TourRun, by: 1, size: number): TourTransition {
  const index = run.index + by;
  if (index >= size) return { run: null, ended: "done" };
  return { run: { ...run, index, direction: 1 } };
}

function retreat(run: TourRun, size: number): TourTransition {
  const index = run.index - 1;
  // Nothing before it can be shown: go forward from the start instead.
  if (index < 0) return advance({ ...run, index: 0 }, 1, size);
  return { run: { ...run, index, direction: -1 } };
}
