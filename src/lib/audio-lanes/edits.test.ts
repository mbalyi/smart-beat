import { describe, expect, it } from "vitest";

import {
  addClip,
  addLane,
  addTake,
  chooseTake,
  deleteRange,
  duplicateClips,
  findClip,
  glueClips,
  makeFolder,
  moveClip,
  moveLane,
  moveRange,
  pasteClips,
  removeClips,
  removeLane,
  splitClip,
  trimClip,
  updateClip,
} from "@/lib/audio-lanes/edits";
import { CUT_FADE_MS, EMPTY_AUDIO, MAX_LANES, clipEndMs, newClip, newLane } from "@/lib/audio-lanes/model";
import type { AudioLanesSettings } from "@/lib/tauri";

const src = { id: "s", name: "a.wav", ext: "wav", embedded: true };

function song(...clips: [string, number, number][]): AudioLanesSettings {
  return {
    ...EMPTY_AUDIO,
    sources: [src, { ...src, id: "t" }],
    lanes: [
      { ...newLane("A", "a"), clips: clips.map(([id, start, len]) => newClip("s", id, start, len, id)) },
      newLane("B", "b"),
    ],
  };
}
const clip = (audio: AudioLanesSettings, id: string) => findClip(audio, id)!.clip;
const laneOf = (audio: AudioLanesSettings, id: string) => findClip(audio, id)!.lane.id;

describe("lanes", () => {
  it("adds lanes up to the limit", () => {
    let audio = EMPTY_AUDIO;
    for (let i = 0; i < MAX_LANES + 2; i++) audio = addLane(audio);
    expect(audio.lanes).toHaveLength(MAX_LANES);
  });

  it("reorders and removes lanes; a removed folder frees its children", () => {
    const withFolder = makeFolder(song(), "Group", ["a"], "f");
    expect(withFolder.lanes.find((l) => l.id === "a")!.parent).toBe("f");
    expect(removeLane(withFolder, "f").lanes.find((l) => l.id === "a")!.parent).toBeUndefined();
    expect(moveLane(song(), "b", 0).lanes.map((l) => l.id)).toEqual(["b", "a"]);
  });
});

describe("split and glue", () => {
  it("splits a clip into two gapless pieces with short cut fades", () => {
    const audio = splitClip(song(["c", 1000, 4000]), "c", 2500, ["l", "r"]);
    const left = clip(audio, "l");
    const right = clip(audio, "r");
    expect(left).toMatchObject({ startMs: 1000, lengthMs: 1500 });
    expect(right).toMatchObject({ startMs: 2500, lengthMs: 2500 });
    expect(right.takes[0]!.offsetMs).toBe(1500);
    expect(clipEndMs(left)).toBe(right.startMs);
    expect(left.fadeOut.ms).toBe(CUT_FADE_MS);
    expect(right.fadeIn.ms).toBe(CUT_FADE_MS);
  });

  it("does not split a locked clip or at its very edge", () => {
    const locked = updateClip(song(["c", 0, 4000]), "c", { locked: true });
    expect(splitClip(locked, "c", 2000)).toBe(locked);
    const plain = song(["c", 0, 4000]);
    expect(splitClip(plain, "c", 2)).toBe(plain);
  });

  it("glues the pieces of a split back into the original clip", () => {
    const before = song(["c", 1000, 4000]);
    const split = splitClip(before, "c", 2500, ["l", "r"]);
    const glued = glueClips(split, ["l", "r"]);
    const [one] = glued.lanes[0]!.clips;
    expect(glued.lanes[0]!.clips).toHaveLength(1);
    expect(one).toMatchObject({ startMs: 1000, lengthMs: 4000 });
    expect(one!.takes[0]!.offsetMs).toBe(0);
  });

  it("does not glue clips that do not continue each other", () => {
    const audio = song(["x", 0, 1000], ["y", 1000, 1000]);
    expect(glueClips(audio, ["x", "y"]).lanes[0]!.clips).toHaveLength(2);
  });
});

describe("move, trim and ripple", () => {
  it("moves a clip along its lane and onto another lane", () => {
    const moved = moveClip(song(["c", 0, 1000]), "c", 3000, "b");
    expect(clip(moved, "c").startMs).toBe(3000);
    expect(laneOf(moved, "c")).toBe("b");
  });

  it("leaves a locked clip where it is", () => {
    const audio = updateClip(song(["c", 0, 1000]), "c", { locked: true });
    expect(moveClip(audio, "c", 500)).toBe(audio);
  });

  it("crossfades clips that overlap after a move", () => {
    const moved = moveClip(song(["x", 0, 1000], ["y", 2000, 1000]), "y", 800);
    expect(clip(moved, "y").fadeIn).toEqual({ ms: 200, shape: "equalPower" });
    expect(clip(moved, "x").fadeOut).toEqual({ ms: 200, shape: "equalPower" });
  });

  it("trims both edges inside the source", () => {
    const start = trimClip(song(["c", 1000, 4000]), "c", "start", 1500);
    expect(clip(start, "c")).toMatchObject({ startMs: 1500, lengthMs: 3500 });
    expect(clip(start, "c").takes[0]!.offsetMs).toBe(500);
    const end = trimClip(song(["c", 1000, 4000]), "c", "end", 2000);
    expect(clip(end, "c").lengthMs).toBe(1000);
  });

  it("cannot trim the start before the beginning of the source", () => {
    expect(clip(trimClip(song(["c", 1000, 4000]), "c", "start", 0), "c").startMs).toBe(1000);
  });

  it("closes the gap with ripple editing on", () => {
    const audio = { ...song(["x", 0, 1000], ["y", 1000, 1000]), ripple: "lane" as const };
    expect(clip(removeClips(audio, ["x"]), "y").startMs).toBe(0);
    expect(clip(removeClips({ ...audio, ripple: "off" }, ["x"]), "y").startMs).toBe(1000);
  });

  it("moves grouped lanes together", () => {
    const base = song(["x", 0, 1000]);
    const grouped = {
      ...base,
      lanes: [
        { ...base.lanes[0]!, group: 1 },
        { ...base.lanes[1]!, group: 1, clips: [newClip("s", "z", 0, 1000, "z")] },
      ],
    };
    expect(clip(moveClip(grouped, "x", 500), "z").startMs).toBe(500);
  });
});

describe("copy, takes and ranges", () => {
  it("duplicates right after the original and pastes at a point", () => {
    const dup = duplicateClips(song(["c", 0, 1000]), ["c"]);
    expect(dup.lanes[0]!.clips.map((c) => c.startMs)).toEqual([0, 1000]);
    const pasted = pasteClips(song(), "b", [newClip("s", "p", 300, 500, "p")], 2000);
    expect(pasted.lanes[1]!.clips[0]!.startMs).toBe(2000);
  });

  it("adds a take and switches between takes", () => {
    const audio = addTake(song(["c", 0, 1000]), "c", { name: "Take 2", sourceId: "t", offsetMs: 0 });
    expect(clip(audio, "c").take).toBe(1);
    expect(clip(chooseTake(audio, "c", 0), "c").take).toBe(0);
  });

  it("deletes a range across lanes", () => {
    const base = song(["c", 0, 3000]);
    const audio = addClip(base, "b", newClip("s", "d", 0, 3000, "d"));
    const cut = deleteRange(audio, ["a", "b"], 1000, 2000);
    for (const lane of cut.lanes) {
      expect(lane.clips.map((c) => [c.startMs, clipEndMs(c)])).toEqual([
        [0, 1000],
        [2000, 3000],
      ]);
    }
  });

  it("moves a range later", () => {
    const moved = moveRange(song(["c", 0, 3000]), ["a"], 1000, 2000, 5000);
    expect(moved.lanes[0]!.clips.map((c) => c.startMs)).toEqual([0, 2000, 6000]);
  });
});
