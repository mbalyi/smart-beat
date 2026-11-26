import { describe, expect, it } from "vitest";

import {
  clipsToRequest,
  laneForRange,
  laneToRequest,
  rangeToRequest,
} from "@/lib/audio-lanes/clip-request";
import { EMPTY_AUDIO, newClip, newLane } from "@/lib/audio-lanes/model";
import type { AudioLanesSettings } from "@/lib/tauri";

const SRC = "a".repeat(64);

function audio(): AudioLanesSettings {
  const slow = { ...newClip(SRC, "slow.wav", 6000, 2000, "slow"), playrate: 0.5 };
  return {
    ...EMPTY_AUDIO,
    lanes: [
      {
        ...newLane("Lead", "lane-a"),
        clips: [
          newClip(SRC, "one.wav", 1000, 2000, "one"),
          newClip(SRC, "two.wav", 4000, 1000, "two"),
          slow,
        ],
      },
      { ...newLane("Bass", "lane-b"), clips: [newClip(SRC, "bass.wav", 500, 9000, "bass")] },
      { ...newLane("Folder", "folder"), folder: true },
    ],
  };
}

describe("clipsToRequest", () => {
  it("asks for one clip as placed, with its own span", () => {
    expect(clipsToRequest(audio(), "one", ["one"])).toEqual({
      laneId: "lane-a",
      clipIds: ["one"],
      range: { startMs: 1000, endMs: 3000 },
      origin: "clip",
    });
  });

  it("works without a selection", () => {
    expect(clipsToRequest(audio(), "two")?.range).toEqual({ startMs: 4000, endMs: 5000 });
  });

  it("uses the placed end of a slowed clip (playrate 0.5 doubles its length)", () => {
    expect(clipsToRequest(audio(), "slow")?.range).toEqual({ startMs: 6000, endMs: 10_000 });
  });

  it("covers the union of several selected clips on one lane, in lane order", () => {
    expect(clipsToRequest(audio(), "slow", ["slow", "one"])).toEqual({
      laneId: "lane-a",
      clipIds: ["one", "slow"],
      range: { startMs: 1000, endMs: 10_000 },
      origin: "clip",
    });
  });

  it("keeps the clicked clip's lane when the selection spans lanes", () => {
    const request = clipsToRequest(audio(), "one", ["bass", "one", "two"]);
    expect(request?.laneId).toBe("lane-a");
    expect(request?.clipIds).toEqual(["one", "two"]);
    expect(request?.range).toEqual({ startMs: 1000, endMs: 5000 });
    const other = clipsToRequest(audio(), "bass", ["bass", "one"]);
    expect(other?.laneId).toBe("lane-b");
    expect(other?.clipIds).toEqual(["bass"]);
  });

  it("ignores a selection the clicked clip is not part of", () => {
    expect(clipsToRequest(audio(), "two", ["one"])?.clipIds).toEqual(["two"]);
  });

  it("is null for a clip that is gone", () => {
    expect(clipsToRequest(audio(), "missing", ["missing"])).toBeNull();
  });
});

describe("rangeToRequest", () => {
  it("clamps to the timeline and puts the edges in order", () => {
    expect(rangeToRequest("lane-a", { startMs: 3000, endMs: -50 }, "selection")).toEqual({
      laneId: "lane-a",
      clipIds: [],
      range: { startMs: 0, endMs: 3000 },
      origin: "selection",
    });
  });

  it("is null for an empty range", () => {
    expect(rangeToRequest("lane-a", { startMs: 500, endMs: 500 }, "studio")).toBeNull();
    expect(rangeToRequest("lane-a", { startMs: -5, endMs: -1 }, "studio")).toBeNull();
  });
});

describe("laneToRequest", () => {
  it("asks for the whole lane", () => {
    expect(laneToRequest("lane-a")).toEqual({
      laneId: "lane-a",
      clipIds: [],
      range: null,
      origin: "lane",
    });
  });
});

describe("laneForRange", () => {
  const range = { startMs: 4500, endMs: 5500 };
  it("picks the first lane with a clip in the range", () => {
    expect(laneForRange(audio(), ["lane-b", "lane-a"], range)).toBe("lane-b");
    expect(laneForRange(audio(), ["lane-a", "lane-b"], { startMs: 3500, endMs: 4500 })).toBe(
      "lane-a",
    );
  });

  it("falls back to the first lane, never a folder or an unknown id", () => {
    expect(
      laneForRange(audio(), ["folder", "nope", "lane-b"], { startMs: 20_000, endMs: 21_000 }),
    ).toBe("lane-b");
    expect(laneForRange(audio(), ["folder"], range)).toBeNull();
  });
});
