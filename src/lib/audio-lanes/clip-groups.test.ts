import { describe, expect, it } from "vitest";

import {
  anyGrouped,
  freshGroups,
  groupClips,
  groupHue,
  groupLeaders,
  groupMembers,
  moveClipGroup,
  pruneGroups,
  regroupCopies,
  ungroupClips,
  withGroup,
} from "@/lib/audio-lanes/clip-groups";
import { duplicateClips, findClip, splitClip, updateClip } from "@/lib/audio-lanes/edits";
import { EMPTY_AUDIO, newClip, newLane, normalizeAudio } from "@/lib/audio-lanes/model";
import type { AudioLanesSettings } from "@/lib/tauri";

const src = { id: "s", name: "a.wav", ext: "wav", embedded: true };

/** Lane A holds x (0 … 1 s) and y (2 … 3 s); lane B holds z (500 … 1500 ms). */
function song(): AudioLanesSettings {
  return {
    ...EMPTY_AUDIO,
    sources: [src],
    lanes: [
      {
        ...newLane("A", "a"),
        clips: [newClip("s", "x", 0, 1000, "x"), newClip("s", "y", 2000, 1000, "y")],
      },
      { ...newLane("B", "b"), clips: [newClip("s", "z", 500, 1000, "z")] },
      newLane("C", "c"),
    ],
  };
}
const clip = (audio: AudioLanesSettings, id: string) => findClip(audio, id)!.clip;
const laneOf = (audio: AudioLanesSettings, id: string) => findClip(audio, id)!.lane.id;
const starts = (audio: AudioLanesSettings, ...ids: string[]) =>
  ids.map((id) => clip(audio, id).startMs);

describe("groupClips", () => {
  it("gives two or more clips one new group, across lanes", () => {
    const grouped = groupClips(song(), ["x", "z"], "g1");
    expect(clip(grouped, "x").groupId).toBe("g1");
    expect(clip(grouped, "z").groupId).toBe("g1");
    expect(clip(grouped, "y").groupId).toBeUndefined();
    expect(groupMembers(grouped, "z")).toEqual(["x", "z"]);
  });

  it("needs two clips: one clip, or unknown ones, change nothing", () => {
    const audio = song();
    expect(groupClips(audio, ["x"])).toBe(audio);
    expect(groupClips(audio, ["x", "nope"])).toBe(audio);
  });

  it("makes a fresh id each time; a clip moved to a new group leaves its old one", () => {
    const first = groupClips(song(), ["x", "y"]);
    const id = clip(first, "x").groupId!;
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    const second = groupClips(first, ["y", "z"]);
    const moved = clip(second, "z").groupId;
    expect(moved).not.toBe(id);
    expect(groupMembers(second, "y")).toEqual(["y", "z"]);
    // x is alone in the old group, so it is no longer grouped.
    expect(clip(second, "x").groupId).toBeUndefined();
  });

  it("does not touch the edit groups of lanes", () => {
    const grouped = groupClips(song(), ["x", "z"], "g1");
    expect(grouped.lanes.map((l) => l.group)).toEqual([0, 0, 0]);
  });
});

describe("ungroupClips", () => {
  it("breaks up the whole group of any clip given", () => {
    const grouped = groupClips(song(), ["x", "y", "z"], "g1");
    const apart = ungroupClips(grouped, ["y"]);
    for (const id of ["x", "y", "z"]) {
      expect(clip(apart, id).groupId).toBeUndefined();
      expect("groupId" in clip(apart, id)).toBe(false);
    }
  });

  it("leaves ungrouped clips (and other groups) as they are", () => {
    const audio = groupClips(song(), ["x", "y"], "g1");
    expect(ungroupClips(audio, ["z"])).toBe(audio);
    expect(anyGrouped(audio, ["z"])).toBe(false);
    expect(anyGrouped(audio, ["z", "y"])).toBe(true);
  });
});

describe("group members and selections", () => {
  const audio = groupClips(song(), ["x", "z"], "g1");

  it("lists the members of a clip's group", () => {
    expect(groupMembers(audio, "x")).toEqual(["x", "z"]);
    expect(groupMembers(audio, "y")).toEqual(["y"]);
    expect(groupMembers(audio, "nope")).toEqual([]);
  });

  it("expands a selection to whole groups, each clip once", () => {
    expect(withGroup(audio, ["z"])).toEqual(["z", "x"]);
    expect(withGroup(audio, ["y", "x", "z"])).toEqual(["y", "x", "z"]);
    expect(withGroup(audio, ["y", "y"])).toEqual(["y"]);
  });

  it("keeps one clip per group for edits that move a group", () => {
    expect(groupLeaders(audio, ["x", "z", "y"])).toEqual(["x", "y"]);
  });
});

describe("moveClipGroup", () => {
  const grouped = () => groupClips(song(), ["x", "z"], "g1");

  it("moves every member by the same amount on its own lane", () => {
    const moved = moveClipGroup(grouped(), "x", 700);
    expect(starts(moved, "x", "z", "y")).toEqual([700, 1200, 2000]);
    expect(laneOf(moved, "z")).toBe("b");
  });

  it("takes the dragged clip to another lane; the rest stay on theirs", () => {
    const moved = moveClipGroup(grouped(), "z", 1500, "c");
    expect(laneOf(moved, "z")).toBe("c");
    expect(laneOf(moved, "x")).toBe("a");
    expect(starts(moved, "z", "x")).toEqual([1500, 1000]);
  });

  it("moves nothing when any member is locked", () => {
    const locked = updateClip(grouped(), "z", { locked: true });
    expect(moveClipGroup(locked, "x", 700)).toBe(locked);
  });

  it("stops the group at the start of the timeline", () => {
    const moved = moveClipGroup(grouped(), "z", 0);
    expect(starts(moved, "x", "z")).toEqual([0, 500]);
  });

  it("moves an ungrouped clip alone", () => {
    const moved = moveClipGroup(grouped(), "y", 2500);
    expect(starts(moved, "x", "y", "z")).toEqual([0, 2500, 500]);
  });

  it("moves a member a lane edit group carries only once", () => {
    const base = grouped();
    const audio = {
      ...base,
      lanes: base.lanes.map((l) => (l.id === "c" ? l : { ...l, group: 1 })),
    };
    // A lane edit group moves clips that start with the moved one: z starts with x.
    const lined = updateClip(audio, "z", { startMs: 0 });
    const moved = moveClipGroup(lined, "x", 300);
    expect(starts(moved, "x", "z")).toEqual([300, 300]);
  });
});

describe("copies", () => {
  it("duplicates get a new group of their own", () => {
    const audio = groupClips(song(), ["x", "z"], "g1");
    const copied = regroupCopies(audio, duplicateClips(audio, ["x", "z"]));
    const copies = copied.lanes
      .flatMap((l) => l.clips)
      .filter((c) => !["x", "y", "z"].includes(c.id));
    expect(copies).toHaveLength(2);
    const [a, b] = copies;
    expect(a!.groupId).toBe(b!.groupId);
    expect(a!.groupId).not.toBe("g1");
    expect(groupMembers(copied, "x")).toEqual(["x", "z"]);
  });

  it("pasted clips get fresh group ids, one per group", () => {
    const audio = groupClips(groupClips(song(), ["x", "z"], "g1"), ["y"], "g2");
    const clips = audio.lanes.flatMap((l) => l.clips);
    const fresh = freshGroups(clips);
    const byId = new Map(fresh.map((c) => [c.id, c.groupId]));
    expect(byId.get("x")).toBe(byId.get("z"));
    expect(byId.get("x")).not.toBe("g1");
    expect(byId.get("y")).toBeUndefined();
  });

  it("an edit that adds nothing is left alone", () => {
    const audio = song();
    expect(regroupCopies(audio, audio)).toBe(audio);
  });
});

describe("pruneGroups", () => {
  it("removes the group of a clip left alone in it", () => {
    const audio = updateClip(song(), "x", { groupId: "lonely" });
    expect(clip(pruneGroups(audio), "x").groupId).toBeUndefined();
    const fine = groupClips(song(), ["x", "y"]);
    expect(pruneGroups(fine)).toBe(fine);
  });

  it("keeps both halves of a split clip in its group", () => {
    const audio = groupClips(song(), ["x", "z"], "g1");
    const split = splitClip(audio, "x", 500, ["x1", "x2"]);
    expect(groupMembers(split, "z")).toEqual(["x1", "x2", "z"]);
  });
});

describe("saving", () => {
  it("keeps a valid group id and drops a bad one when the lanes are read", () => {
    const audio = groupClips(song(), ["x", "z"], "g1");
    const saved = JSON.parse(JSON.stringify(audio)) as AudioLanesSettings;
    saved.lanes[0]!.clips[1]!.groupId = "../../x";
    const read = normalizeAudio(saved);
    expect(clip(read, "x").groupId).toBe("g1");
    expect("groupId" in clip(read, "y")).toBe(false);
  });

  it("old clips without a group read as ungrouped", () => {
    const read = normalizeAudio(JSON.parse(JSON.stringify(song())) as AudioLanesSettings);
    expect(read.lanes.flatMap((l) => l.clips).every((c) => !("groupId" in c))).toBe(true);
  });
});

describe("groupHue", () => {
  it("is stable for a group and in range", () => {
    expect(groupHue("g1")).toBe(groupHue("g1"));
    expect(groupHue("g1")).toBeGreaterThanOrEqual(0);
    expect(groupHue("g1")).toBeLessThan(360);
  });
});
