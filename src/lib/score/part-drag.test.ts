import { describe, expect, it } from "vitest";

import { dragReducer, dropSpot, IDLE, isPlacing, type DragState } from "@/lib/score/part-drag";

const spot = { track: 1, bar: 4 };
const run = (actions: Parameters<typeof dragReducer>[1][], from: DragState = IDLE) =>
  actions.reduce(dragReducer, from);

describe("part drag", () => {
  it("a press that does not move is a click, not a drag", () => {
    const state = run([
      { type: "press", x: 10, y: 10, touch: false },
      { type: "move", x: 12, y: 11, hover: null },
    ]);
    expect(state.kind).toBe("armed");
    expect(run([{ type: "release" }], state)).toEqual({ kind: "idle", cancelled: null });
  });

  it("starts after the slop, more for a finger", () => {
    const mouse = run([
      { type: "press", x: 0, y: 0, touch: false },
      { type: "move", x: 5, y: 0, hover: null },
    ]);
    expect(mouse.kind).toBe("dragging");
    const finger = run([
      { type: "press", x: 0, y: 0, touch: true },
      { type: "move", x: 5, y: 0, hover: null },
    ]);
    expect(finger.kind).toBe("armed");
    expect(run([{ type: "move", x: 9, y: 0, hover: null }], finger).kind).toBe("dragging");
  });

  it("is placing while dragging or carried by the keyboard", () => {
    const dragging = run([
      { type: "press", x: 0, y: 0, touch: false },
      { type: "move", x: 20, y: 0, hover: { spot, accepted: true } },
    ]);
    expect(isPlacing(dragging)).toBe(true);
    expect(dropSpot(dragging)).toEqual(spot);
    const keyboard = run([{ type: "pickup", hover: { spot, accepted: false } }]);
    expect(isPlacing(keyboard)).toBe(true);
    expect(dropSpot(keyboard)).toBeNull();
    expect(isPlacing(IDLE)).toBe(false);
  });

  it("names every way out", () => {
    for (const reason of [
      "escape",
      "pointercancel",
      "lostcapture",
      "blur",
      "hidden",
      "outside",
      "invalid",
      "tab-changed",
    ] as const) {
      const dragging = run([
        { type: "press", x: 0, y: 0, touch: false },
        { type: "move", x: 20, y: 0, hover: null },
      ]);
      expect(run([{ type: "cancel", reason }], dragging)).toEqual({
        kind: "idle",
        cancelled: reason,
      });
    }
    expect(run([{ type: "cancel", reason: "escape" }])).toBe(IDLE);
  });

  it("follows the hover while dragging and while carried", () => {
    const state = run([
      { type: "pickup", hover: null },
      { type: "hover", hover: { spot, accepted: true } },
    ]);
    expect(dropSpot(state)).toEqual(spot);
  });
});
