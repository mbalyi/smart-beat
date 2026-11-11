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
  setLaneInScore,
  splitClip,
  trimClip,
  updateClip,
} from "@/lib/audio-lanes/edits";
import {
  CUT_FADE_MS,
  EMPTY_AUDIO,
  MAX_LANES,
  clipEndMs,
  newClip,
  newLane,
} from "@/lib/audio-lanes/model";
import type { AudioClip, AudioLanesSettings } from "@/lib/tauri";

const src = { id: "s", name: "a.wav", ext: "wav", embedded: true };

function song(...clips: [string, number, number][]): AudioLanesSettings {
  return {
    ...EMPTY_AUDIO,
    sources: [src, { ...src, id: "t" }],
    lanes: [
      {
        ...newLane("A", "a"),
        clips: clips.map(([id, start, len]) => newClip("s", id, start, len, id)),
      },
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
    expect(clip(moved, "y").fadeIn).toEqual({ ms: 200, shape: "equalPower", auto: true });
    expect(clip(moved, "x").fadeOut).toEqual({ ms: 200, shape: "equalPower", auto: true });
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
    const audio = addTake(song(["c", 0, 1000]), "c", {
      name: "Take 2",
      sourceId: "t",
      offsetMs: 0,
    });
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

describe("review regressions", () => {
  const one = (patch: Partial<AudioClip>) => {
    const base = song(["c", 0, 10_000]);
    return updateClip(base, "c", patch);
  };

  it("splits a reversed clip so each half plays the right part of the file", () => {
    // A reversed clip plays file 0–10 s backwards: its first 4 s are file 6–10 s.
    const audio = splitClip(one({ reversed: true }), "c", 4000, ["l", "r"]);
    expect(clip(audio, "l").takes[0]!.offsetMs).toBe(6000);
    expect(clip(audio, "l").lengthMs).toBe(4000);
    expect(clip(audio, "r").takes[0]!.offsetMs).toBe(0);
    expect(clip(audio, "r").lengthMs).toBe(6000);
    // And glues back to the original.
    const glued = glueClips(audio, ["l", "r"]).lanes[0]!.clips;
    expect(glued).toHaveLength(1);
    expect(glued[0]).toMatchObject({ lengthMs: 10_000, takes: [{ offsetMs: 0 }] });
  });

  it("trims the end of a reversed clip from its file's start", () => {
    const audio = trimClip(one({ reversed: true }), "c", "end", 6000);
    // Playing 10 s → 4 s backwards: the last 4 s of playback (file 0–4 s) are gone.
    expect(clip(audio, "c")).toMatchObject({ lengthMs: 6000, takes: [{ offsetMs: 4000 }] });
  });

  it("keeps the envelope's value at the cut on both halves", () => {
    const ramp = one({
      envelope: [
        { at: 0, db: -20 },
        { at: 1, db: 0 },
      ],
    });
    const audio = splitClip(ramp, "c", 2500, ["l", "r"]);
    const left = clip(audio, "l").envelope;
    const right = clip(audio, "r").envelope;
    expect(left.at(-1)).toEqual({ at: 1, db: -15 });
    expect(right[0]).toEqual({ at: 0, db: -15 });
    expect(right.at(-1)).toEqual({ at: 1, db: 0 });
  });

  it("splits a stretched clip at its source position and keeps each half's timing", () => {
    // 10 s on the timeline; the first 5 s play 8 s of source, the rest 2 s.
    const stretched = one({ stretch: [{ clipMs: 5000, sourceMs: 8000 }] });
    const audio = splitClip(stretched, "c", 5000, ["l", "r"]);
    expect(clip(audio, "l")).toMatchObject({ lengthMs: 8000, startMs: 0 });
    expect(clipEndMs(clip(audio, "l"))).toBeCloseTo(5000);
    expect(clip(audio, "r")).toMatchObject({
      lengthMs: 2000,
      startMs: 5000,
      takes: [{ offsetMs: 8000 }],
    });
    expect(clipEndMs(clip(audio, "r"))).toBeCloseTo(10_000);
  });

  it("drops envelope points a trim cuts off instead of squeezing them", () => {
    const audio = trimClip(
      one({
        envelope: [
          { at: 0.2, db: -6 },
          { at: 0.8, db: -12 },
        ],
      }),
      "c",
      "end",
      5000,
    );
    expect(clip(audio, "c").envelope.map((p) => p.at)).toEqual([0, 0.4, 1]);
  });

  it("takes an automatic crossfade away when the clips stop overlapping", () => {
    const overlapping = moveClip(song(["x", 0, 1000], ["y", 2000, 1000]), "y", 800);
    const apart = moveClip(overlapping, "y", 2000);
    expect(clip(apart, "x").fadeOut.ms).toBe(0);
    expect(clip(apart, "y").fadeIn.ms).toBe(0);
  });

  it("sizes a crossfade in source time for a clip played faster", () => {
    const fast = updateClip(song(["x", 0, 2000], ["y", 3000, 1000]), "x", { playrate: 2 });
    // x lasts 1 s on the timeline; y moved to 0.8 s overlaps it by 200 ms = 400 ms of x's source.
    const moved = moveClip(fast, "y", 800);
    expect(clip(moved, "x").fadeOut.ms).toBe(400);
    expect(clip(moved, "y").fadeIn.ms).toBe(200);
  });

  it("does not glue clips whose mute differs", () => {
    const split = splitClip(song(["c", 0, 4000]), "c", 2000, ["l", "r"]);
    const muted = updateClip(split, "r", { mute: true });
    expect(glueClips(muted, ["l", "r"]).lanes[0]!.clips).toHaveLength(2);
  });
});

describe("setLaneInScore", () => {
  it("hides a lane with a flag and shows it by removing the key", () => {
    const hidden = setLaneInScore(song(), "a", false);
    expect(hidden.lanes[0]!.hiddenInScore).toBe(true);
    expect(hidden.lanes[1]!.hiddenInScore).toBeUndefined();
    const shown = setLaneInScore(hidden, "a", true);
    expect("hiddenInScore" in shown.lanes[0]!).toBe(false);
  });

  it("does not change other lanes or a missing lane", () => {
    const audio = song();
    expect(setLaneInScore(audio, "nope", false)).toBe(audio);
    expect(setLaneInScore(audio, "a", false).lanes[1]).toBe(audio.lanes[1]);
  });

  it("sets the children of a folder together, not the folder", () => {
    const folder = makeFolder(song(), "Group", ["a", "b"], "f");
    const hidden = setLaneInScore(folder, "f", false);
    const flag = (id: string) => hidden.lanes.find((l) => l.id === id)!.hiddenInScore;
    expect([flag("a"), flag("b"), flag("f")]).toEqual([true, true, undefined]);
    const shown = setLaneInScore(hidden, "f", true);
    expect(shown.lanes.some((l) => "hiddenInScore" in l)).toBe(false);
  });
});
