import { describe, expect, it } from "vitest";

import {
  DEFAULT_LANE_HEIGHT,
  MAX_LANE_HEIGHT,
  MIN_LANE_HEIGHT,
  laneHeight,
  normalizeLaneHeight,
  resizeScope,
  resizeTargets,
  setLaneHeights,
} from "@/lib/audio-lanes/lane-height";
import {
  EMPTY_AUDIO,
  newClip,
  newLane,
  normalizeAudio,
  normalizeLane,
} from "@/lib/audio-lanes/model";
import type { AudioLane, AudioLanesSettings } from "@/lib/tauri";

const SOURCE = { id: "a".repeat(64), name: "take.wav", ext: "wav", embedded: true };

function song(): AudioLanesSettings {
  return {
    ...EMPTY_AUDIO,
    sources: [SOURCE],
    lanes: [
      { ...newLane("Vocals", "lane-a"), clips: [newClip(SOURCE.id, "a", 0, 1000, "clip-a")] },
      { ...newLane("Drums", "lane-b"), clips: [newClip(SOURCE.id, "b", 0, 1000, "clip-b")] },
      newLane("Bass", "lane-c"),
      { ...newLane("Folder", "folder"), folder: true },
    ],
  };
}

describe("normalizeLaneHeight", () => {
  it("keeps a height in range in whole pixels", () => {
    expect(normalizeLaneHeight(120)).toBe(120);
    expect(normalizeLaneHeight(120.6)).toBe(121);
    expect(normalizeLaneHeight(10)).toBe(MIN_LANE_HEIGHT);
    expect(normalizeLaneHeight(900)).toBe(MAX_LANE_HEIGHT);
  });

  it("drops anything that is not a number", () => {
    expect(normalizeLaneHeight(undefined)).toBeUndefined();
    expect(normalizeLaneHeight(Number.NaN)).toBeUndefined();
    expect(normalizeLaneHeight("120")).toBeUndefined();
  });
});

describe("normalizeLane height", () => {
  const sources = new Set([SOURCE.id]);

  it("loads a lane saved before heights existed at the default height", () => {
    const old = newLane("Vocals", "lane-a");
    const lane = normalizeLane(old, sources);
    expect(lane.height).toBeUndefined();
    expect(laneHeight(lane)).toBe(DEFAULT_LANE_HEIGHT);
    expect(JSON.parse(JSON.stringify(lane))).not.toHaveProperty("height");
  });

  it("clamps a saved height and drops a damaged one", () => {
    const lane = (height: unknown) =>
      normalizeLane({ ...newLane("Vocals"), height } as AudioLane, sources).height;
    expect(lane(150)).toBe(150);
    expect(lane(1000)).toBe(MAX_LANE_HEIGHT);
    expect(lane(0)).toBe(MIN_LANE_HEIGHT);
    expect(lane(null)).toBeUndefined();
  });

  it("keeps the heights of a whole song through normalizeAudio", () => {
    const audio = setLaneHeights(song(), ["lane-a"], 200);
    expect(normalizeAudio(audio).lanes.map((l) => l.height)).toEqual([
      200,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("resizeScope and resizeTargets", () => {
  it("reads Alt as the selected lanes and Shift as every lane", () => {
    expect(resizeScope({ altKey: false, shiftKey: false })).toBe("lane");
    expect(resizeScope({ altKey: true, shiftKey: false })).toBe("selected");
    expect(resizeScope({ altKey: true, shiftKey: true })).toBe("all");
  });

  it("finds the lanes a resize changes, never a folder", () => {
    const audio = song();
    expect(resizeTargets(audio, "lane-c", ["clip-b"], "lane")).toEqual(["lane-c"]);
    expect(resizeTargets(audio, "lane-c", ["clip-b"], "selected")).toEqual(["lane-b", "lane-c"]);
    expect(resizeTargets(audio, "lane-a", [], "all")).toEqual(["lane-a", "lane-b", "lane-c"]);
  });
});

describe("setLaneHeights", () => {
  it("sets the lanes' height in range, without changing the song it was given", () => {
    const before = song();
    const after = setLaneHeights(before, ["lane-a", "lane-b"], 300);
    expect(after.lanes.map((l) => l.height)).toEqual([
      MAX_LANE_HEIGHT,
      MAX_LANE_HEIGHT,
      undefined,
      undefined,
    ]);
    expect(before.lanes[0]!.height).toBeUndefined();
  });

  it("resets to the default, and returns the same song when nothing changes", () => {
    const tall = setLaneHeights(song(), ["lane-a"], 160);
    const reset = setLaneHeights(tall, ["lane-a"], undefined);
    expect(laneHeight(reset.lanes[0]!)).toBe(DEFAULT_LANE_HEIGHT);
    expect(setLaneHeights(tall, ["lane-a"], 160)).toBe(tall);
  });
});
