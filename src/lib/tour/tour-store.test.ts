import {
  emptyTourState,
  initTourState,
  isExistingUser,
  LEGACY_BASELINE_VERSION,
  readTourState,
  TOUR_STORAGE_KEY,
  writeTourState,
  type TourState,
} from "@/lib/tour/tour-store";
import type { LayoutPrefs } from "@/lib/score/layout";

const layout = (mixer: boolean, inspector: boolean) => ({ mixer, inspector }) as LayoutPrefs;

beforeEach(() => localStorage.clear());

describe("readTourState / writeTourState", () => {
  it("returns null when nothing is saved", () => {
    expect(readTourState()).toBeNull();
  });

  it("round-trips a state", () => {
    const state: TourState = {
      tours: { main: "done", editing: "skipped", effects: { step: 2 } },
      hints: { pan: true },
      lastSeenVersion: "1.1.0",
    };
    writeTourState(state);
    expect(readTourState()).toEqual(state);
  });

  it("returns null for corrupt JSON and non-object values", () => {
    for (const raw of ["{not json", "null", "42", '"text"']) {
      localStorage.setItem(TOUR_STORAGE_KEY, raw);
      expect(readTourState()).toBeNull();
    }
  });

  it("sanitises wrong shapes", () => {
    localStorage.setItem(
      TOUR_STORAGE_KEY,
      JSON.stringify({
        tours: { a: "done", b: "other", c: { step: 3 }, d: { step: "x" }, e: null, f: 5 },
        hints: { x: true, y: false, z: "yes" },
        lastSeenVersion: 3,
      }),
    );
    expect(readTourState()).toEqual({
      tours: { a: "done", c: { step: 3 } },
      hints: { x: true },
      lastSeenVersion: null,
    });
  });

  it("falls back to empty records when fields are missing", () => {
    localStorage.setItem(TOUR_STORAGE_KEY, "{}");
    expect(readTourState()).toEqual(emptyTourState());
  });
});

describe("isExistingUser", () => {
  it("is true with saved panels", () => {
    expect(isExistingUser(layout(false, false), layout(false, false))).toBe(true);
  });
  it("is true when both panels are open now", () => {
    expect(isExistingUser(null, layout(true, true))).toBe(true);
  });
  it("is false otherwise", () => {
    expect(isExistingUser(null, layout(true, false))).toBe(false);
    expect(isExistingUser(null, layout(false, true))).toBe(false);
    expect(isExistingUser(null, layout(false, false))).toBe(false);
  });
});

describe("initTourState", () => {
  it("offers the tour to a fresh user and records the version", () => {
    const state = initTourState(false, "1.2.0");
    expect(state).toEqual({ tours: {}, hints: {}, lastSeenVersion: "1.2.0" });
    expect(readTourState()).toEqual(state);
  });

  it("skips the main tour for an existing user and uses the legacy baseline", () => {
    const state = initTourState(true, "1.2.0");
    expect(state).toEqual({
      tours: { main: "skipped" },
      hints: {},
      lastSeenVersion: LEGACY_BASELINE_VERSION,
    });
    expect(readTourState()).toEqual(state);
  });

  it("returns a saved state untouched", () => {
    const saved: TourState = { tours: { main: "done" }, hints: {}, lastSeenVersion: "1.0.5" };
    writeTourState(saved);
    expect(initTourState(true, "9.9.9")).toEqual(saved);
    expect(initTourState(false, "9.9.9")).toEqual(saved);
    expect(readTourState()).toEqual(saved);
  });
});
