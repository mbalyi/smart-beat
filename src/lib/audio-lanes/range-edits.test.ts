import { describe, expect, it } from "vitest";

import { EMPTY_AUDIO, clipEndMs, newClip, newLane } from "@/lib/audio-lanes/model";
import {
  clipLaneIds,
  describeRange,
  formatRangeMs,
  insertSpaceAtRange,
  normalizeRange,
  removeRangeClosingGap,
  splitAtRangeEdges,
  trimToRange,
} from "@/lib/audio-lanes/range-edits";
import type { AudioClip, AudioLanesSettings } from "@/lib/tauri";

const src = { id: "s", name: "a.wav", ext: "wav", embedded: true };
type Spec = [id: string, startMs: number, lengthMs: number, locked?: boolean];

const clipOf = ([id, start, length, locked]: Spec): AudioClip => ({
  ...newClip("s", id, start, length, id),
  locked: !!locked,
});

/** Lane "a" and lane "b" with the clips given, plus an empty folder. */
function song(a: Spec[], b: Spec[] = []): AudioLanesSettings {
  return {
    ...EMPTY_AUDIO,
    sources: [src],
    lanes: [
      { ...newLane("A", "a"), clips: a.map(clipOf) },
      { ...newLane("B", "b"), clips: b.map(clipOf) },
      { ...newLane("F", "f"), folder: true },
    ],
  };
}

/** Each clip of a lane as [start, end] on the timeline, rounded to 0.1 ms. */
const spans = (audio: AudioLanesSettings, laneId: string) =>
  audio.lanes
    .find((l) => l.id === laneId)!
    .clips.map((c) => [Math.round(c.startMs * 10) / 10, Math.round(clipEndMs(c) * 10) / 10]);

const range = { startMs: 1000, endMs: 3000 };

describe("normalizeRange", () => {
  it("orders the edges, keeps them on the timeline and drops a click", () => {
    expect(normalizeRange({ startMs: 3000, endMs: 1000 })).toEqual(range);
    expect(normalizeRange({ startMs: -500, endMs: 200 })).toEqual({ startMs: 0, endMs: 200 });
    expect(normalizeRange({ startMs: 1000, endMs: 1000.5 })).toBeNull();
    expect(normalizeRange(null)).toBeNull();
  });
});

describe("clipLaneIds", () => {
  it("lists the lanes that hold clips, not folders", () => {
    expect(clipLaneIds(song([]))).toEqual(["a", "b"]);
  });
});

describe("splitAtRangeEdges", () => {
  it("splits the clips crossing either edge on the lanes given", () => {
    const audio = song([["x", 0, 4000]], [["y", 2000, 4000]]);
    const next = splitAtRangeEdges(audio, ["a"], range);
    expect(spans(next, "a")).toEqual([
      [0, 1000],
      [1000, 3000],
      [3000, 4000],
    ]);
    expect(spans(next, "b")).toEqual([[2000, 6000]]);
  });

  it("leaves locked clips whole and returns the same object when nothing crosses", () => {
    const audio = song([["x", 0, 4000, true]], [["y", 4000, 1000]]);
    expect(splitAtRangeEdges(audio, ["a", "b"], range)).toBe(audio);
  });
});

describe("trimToRange", () => {
  it("keeps only the parts inside the selection on the lanes given", () => {
    const audio = song(
      [
        ["x", 0, 2000],
        ["z", 3500, 1000],
      ],
      [["y", 0, 5000]],
    );
    const next = trimToRange(audio, ["a"], range);
    expect(spans(next, "a")).toEqual([[1000, 2000]]);
    expect(spans(next, "b")).toEqual([[0, 5000]]);
  });

  it("works on every lane given and leaves locked clips alone", () => {
    const audio = song([["x", 0, 4000]], [["y", 4000, 1000, true]]);
    const next = trimToRange(audio, ["a", "b"], range);
    expect(spans(next, "a")).toEqual([[1000, 3000]]);
    expect(spans(next, "b")).toEqual([[4000, 5000]]);
  });

  it("changes nothing when every clip is already inside", () => {
    const audio = song([["x", 1500, 1000]]);
    expect(trimToRange(audio, ["a", "b"], range)).toBe(audio);
  });
});

describe("removeRangeClosingGap", () => {
  it("removes the selection on every lane and moves later clips left by its length", () => {
    const audio = song(
      [
        ["x", 0, 4000],
        ["z", 5000, 1000],
      ],
      [["y", 2000, 500]],
    );
    const next = removeRangeClosingGap(audio, range);
    expect(spans(next, "a")).toEqual([
      [0, 1000],
      [1000, 2000],
      [3000, 4000],
    ]);
    expect(spans(next, "b")).toEqual([]);
  });

  it("closes the gap once even when several lanes lose a part", () => {
    const audio = song([["x", 1000, 2000]], [["y", 1000, 2000]]);
    const withLater = {
      ...audio,
      lanes: audio.lanes.map((l) =>
        l.id === "b" ? { ...l, clips: [...l.clips, clipOf(["w", 4000, 1000])] } : l,
      ),
    };
    const next = removeRangeClosingGap(withLater, range);
    expect(spans(next, "a")).toEqual([]);
    expect(spans(next, "b")).toEqual([[2000, 3000]]);
  });

  it("keeps locked clips where they are, inside the range or after it", () => {
    const audio = song([["x", 1500, 500, true]], [["y", 4000, 1000, true]]);
    expect(removeRangeClosingGap(audio, range)).toBe(audio);
  });
});

describe("insertSpaceAtRange", () => {
  it("cuts at the start and moves everything from there right by the length", () => {
    const audio = song(
      [["x", 0, 2000]],
      [
        ["y", 1000, 500],
        ["w", 500, 200],
      ],
    );
    const next = insertSpaceAtRange(audio, range);
    expect(spans(next, "a")).toEqual([
      [0, 1000],
      [3000, 4000],
    ]);
    expect(spans(next, "b")).toEqual([
      [500, 700],
      [3000, 3500],
    ]);
  });

  it("leaves locked clips in place", () => {
    const audio = song([["x", 0, 2000, true]], [["y", 1200, 500, true]]);
    expect(insertSpaceAtRange(audio, range)).toBe(audio);
  });
});

describe("describeRange", () => {
  it("shows the start, the end and the length", () => {
    expect(formatRangeMs(61_500)).toBe("1:01.50");
    expect(describeRange(range)).toBe("0:01.00 – 0:03.00 (2.00 s)");
  });
});
