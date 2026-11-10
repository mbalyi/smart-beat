import { describe, expect, it } from "vitest";

import { EMPTY_AUDIO, newClip, newLane } from "@/lib/audio-lanes/model";
import {
  boxBetween,
  clickMode,
  clickSelection,
  clipsInBox,
  laneClipIds,
  marqueeSelection,
  rangeSelection,
  sameSelection,
  selectableLanes,
  selectionLabel,
} from "@/lib/audio-lanes/selection";
import type { AudioLane, AudioLanesSettings } from "@/lib/tauri";

const SOURCE = "a".repeat(64);
const clip = (id: string, startMs: number) => newClip(SOURCE, id, startMs, 1000, id);
const lane = (id: string, clips: ReturnType<typeof clip>[], extra: Partial<AudioLane> = {}) => ({
  ...newLane(id, id),
  clips,
  ...extra,
});

/** Three lanes: a1 a2 a3 at 0, 2, 4 s; b1 b2 at 1, 5 s; c1 at 3 s. */
const lanes: AudioLane[] = [
  lane("a", [clip("a1", 0), clip("a2", 2000), clip("a3", 4000)]),
  lane("b", [clip("b1", 1000), clip("b2", 5000)]),
  lane("c", [clip("c1", 3000)]),
];

describe("clickMode", () => {
  it("selects a range with Shift, toggles with ⌘ or Ctrl, else selects one", () => {
    const keys = { shiftKey: false, metaKey: false, ctrlKey: false };
    expect(clickMode(keys)).toBe("single");
    expect(clickMode({ ...keys, metaKey: true })).toBe("toggle");
    expect(clickMode({ ...keys, ctrlKey: true })).toBe("toggle");
    expect(clickMode({ ...keys, shiftKey: true, metaKey: true })).toBe("range");
  });
});

describe("clickSelection", () => {
  it("selects only the clicked clip on a plain click", () => {
    expect(clickSelection(["a1", "b1"], "c1", "single", lanes)).toEqual(["c1"]);
  });

  it("toggles a clip in and out without touching the rest", () => {
    const current = ["a1"];
    expect(clickSelection(current, "b1", "toggle", lanes)).toEqual(["a1", "b1"]);
    expect(clickSelection(["a1", "b1"], "a1", "toggle", lanes)).toEqual(["b1"]);
    expect(current).toEqual(["a1"]);
  });

  it("selects the range from the last clicked clip, keeping it as the anchor", () => {
    expect(clickSelection(["c1", "a1"], "a3", "range", lanes)).toEqual(["a2", "a3", "a1"]);
  });
});

describe("rangeSelection", () => {
  it("takes the clips between the two starts on the lanes in between", () => {
    // From a1 (lane a, 0 s) to c1 (lane c, 3 s): a1 a2 b1 c1, by start time, anchor last.
    expect(rangeSelection(lanes, "a1", "c1")).toEqual(["b1", "a2", "c1", "a1"]);
  });

  it("works upwards and backwards in time", () => {
    expect(rangeSelection(lanes, "b2", "a2")).toEqual(["a2", "a3", "b2"]);
  });

  it("stays on the lanes it is given", () => {
    expect(rangeSelection([lanes[0]!], "a1", "a3")).toEqual(["a2", "a3", "a1"]);
  });

  it("selects only the target without an anchor on these lanes", () => {
    expect(rangeSelection(lanes, undefined, "b1")).toEqual(["b1"]);
    expect(rangeSelection([lanes[0]!], "b1", "a2")).toEqual(["a2"]);
    expect(rangeSelection(lanes, "a2", "a2")).toEqual(["a2"]);
  });
});

describe("selectableLanes and laneClipIds", () => {
  const audio: AudioLanesSettings = {
    ...EMPTY_AUDIO,
    lanes: [
      lane("f", [], { folder: true, collapsed: true }),
      lane("in-folder", [clip("x", 0)], { parent: "f" }),
      lane("open", [], { folder: true }),
      lane("in-open", [clip("y", 0)], { parent: "open" }),
      lane("top", [clip("z", 0), clip("w", 2000)]),
    ],
  };

  it("leaves out folders and the lanes of a closed folder", () => {
    expect(selectableLanes(audio).map((l) => l.id)).toEqual(["in-open", "top"]);
  });

  it("lists every clip of a lane, and none for an unknown lane", () => {
    expect(laneClipIds(audio, "top")).toEqual(["z", "w"]);
    expect(laneClipIds(audio, "nope")).toEqual([]);
  });
});

describe("rectangle hit-testing", () => {
  const rows = [
    { laneId: "a", top: 0, bottom: 50 },
    { laneId: "b", top: 50, bottom: 100 },
    { laneId: "c", top: 100, bottom: 150 },
  ];
  const clips = [
    { id: "a1", laneId: "a", left: 0, right: 40 },
    { id: "a2", laneId: "a", left: 80, right: 120 },
    { id: "b1", laneId: "b", left: 40, right: 60 },
    { id: "c1", laneId: "c", left: 100, right: 200 },
  ];

  it("builds the box whichever way the drag went", () => {
    expect(boxBetween({ x: 30, y: 90 }, { x: 10, y: 20 })).toEqual({
      left: 10,
      top: 20,
      right: 30,
      bottom: 90,
    });
  });

  it("selects every clip the box touches, across the rows it spans", () => {
    const box = boxBetween({ x: 30, y: 10 }, { x: 110, y: 120 });
    expect(clipsInBox(box, rows, clips)).toEqual(["a1", "a2", "b1", "c1"]);
  });

  it("leaves out clips beside the box and rows above or below it", () => {
    expect(clipsInBox(boxBetween({ x: 45, y: 10 }, { x: 70, y: 80 }), rows, clips)).toEqual(["b1"]);
    expect(clipsInBox(boxBetween({ x: 0, y: 160 }, { x: 300, y: 200 }), rows, clips)).toEqual([]);
  });
});

describe("marqueeSelection", () => {
  it("replaces the selection, or adds to it", () => {
    expect(marqueeSelection(["x"], ["a", "b"], false)).toEqual(["a", "b"]);
    expect(marqueeSelection(["x", "a"], ["a", "b"], true)).toEqual(["x", "a", "b"]);
  });

  it("compares selections in order", () => {
    expect(sameSelection(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameSelection(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameSelection(["a"], ["a", "b"])).toBe(false);
  });
});

describe("selectionLabel", () => {
  it("counts the selected clips", () => {
    expect(selectionLabel(0)).toBe("No clips selected");
    expect(selectionLabel(1)).toBe("1 clip selected");
    expect(selectionLabel(3)).toBe("3 clips selected");
  });
});
