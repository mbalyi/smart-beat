import {
  applyAudioOps,
  diffAudio,
  applyMixChanges,
  isAudioOp,
  mixChanges,
  PERSONAL_LANE_FIELDS,
  receiveAudioOps,
  sharedLane,
  SHARED_LANE_FIELDS,
  snapshotOps,
  validAudioOps,
  type AudioOp,
} from "@/lib/audio-lanes/collab";
import { addClip, addLane, addSource, removeClips, updateLane } from "@/lib/audio-lanes/edits";
import { EMPTY_AUDIO, MAX_LANES, newClip, newLane } from "@/lib/audio-lanes/model";
import type { AudioLanesSettings, AudioSource } from "@/lib/tauri";

const SRC: AudioSource = { id: "a".repeat(64), name: "drums.wav", ext: "wav", embedded: true };

function song(): AudioLanesSettings {
  const lane = newLane("Drums", "lane-1");
  return addClip(
    addLane(addSource(EMPTY_AUDIO, SRC), lane),
    "lane-1",
    newClip(SRC.id, "drums.wav", 0, 4_000, "clip-1"),
  );
}

/** What one end sends, applied at the other. */
const carry = (from: AudioLanesSettings, to: AudioLanesSettings, base = EMPTY_AUDIO) =>
  applyAudioOps(to, diffAudio(base, from));

describe("audio lane sharing: operations", () => {
  it("lists every lane field as shared or personal, exactly once", () => {
    const all = Object.keys(newLane("x")).filter((k) => k !== "id" && k !== "clips");
    const named = [...SHARED_LANE_FIELDS, ...PERSONAL_LANE_FIELDS] as string[];
    // Every field a lane has is decided; "shownInScore", "height" and "parent" are optional.
    for (const key of all) expect(named).toContain(key);
    expect(new Set(named).size).toBe(named.length);
  });

  it("shares nothing when nothing changed", () => {
    expect(diffAudio(song(), song())).toEqual([]);
  });

  it("sends a new lane with its file and clip, and the other end gets the same lane", () => {
    const ops = diffAudio(EMPTY_AUDIO, song());
    expect(ops.map((o) => o.t)).toEqual(["a-src-add", "a-lane-add", "a-clip-set"]);
    const there = applyAudioOps(EMPTY_AUDIO, ops);
    expect(there.lanes).toHaveLength(1);
    expect(there.lanes[0]!.name).toBe("Drums");
    expect(there.lanes[0]!.clips).toHaveLength(1);
    // The file comes as an embedded file with no path of the sender's.
    expect(there.sources).toEqual([{ ...SRC, embedded: true }]);
  });

  it("never sends a path or the entry name of an old track", () => {
    const withPath = {
      ...song(),
      sources: [{ ...SRC, path: "/Users/me/secret.wav", legacyEntry: "x" }],
    };
    const text = JSON.stringify(diffAudio(EMPTY_AUDIO, withPath));
    expect(text).not.toContain("secret");
    expect(text).not.toContain("legacyEntry");
  });

  it("does not share a file without a content id", () => {
    const old = { ...song(), sources: [{ ...SRC, id: "legacy-1234" }] };
    expect(diffAudio(EMPTY_AUDIO, old).filter((o) => o.t === "a-src-add")).toEqual([]);
  });

  it("keeps each player's own mix when the lane changes", () => {
    const base = song();
    const theirs = updateLane(base, "lane-1", { volume: 0.3, mute: true, pan: -0.5, solo: true });
    // This player renames the lane and moves the clip; their volume is not touched.
    let mine = updateLane(base, "lane-1", { name: "Kit" });
    mine = {
      ...mine,
      lanes: mine.lanes.map((l) => ({ ...l, clips: l.clips.map((c) => ({ ...c, startMs: 500 })) })),
    };
    const result = applyAudioOps(theirs, diffAudio(base, mine));
    const lane = result.lanes[0]!;
    expect(lane.name).toBe("Kit");
    expect(lane.clips[0]!.startMs).toBe(500);
    expect(lane.volume).toBe(0.3);
    expect(lane.mute).toBe(true);
    expect(lane.pan).toBe(-0.5);
    expect(lane.solo).toBe(true);
  });

  it("does not send a change of the personal mix at all", () => {
    const base = song();
    const mixed = updateLane(base, "lane-1", {
      volume: 0.1,
      pan: 0.4,
      mute: true,
      solo: true,
      enabled: false,
      collapsed: true,
      height: 120,
      shownInScore: true,
    });
    expect(diffAudio(base, mixed)).toEqual([]);
  });

  it("carries a clip edit, a clip moved to another lane, and a removed clip", () => {
    let base = song();
    base = addLane(base, newLane("Bass", "lane-2"));
    const moved = {
      ...base,
      lanes: base.lanes.map((l) =>
        l.id === "lane-1"
          ? { ...l, clips: [] }
          : { ...l, clips: [newClip(SRC.id, "drums.wav", 100, 4_000, "clip-1")] },
      ),
    };
    const there = applyAudioOps(base, diffAudio(base, moved));
    expect(there.lanes.find((l) => l.id === "lane-1")!.clips).toHaveLength(0);
    expect(there.lanes.find((l) => l.id === "lane-2")!.clips.map((c) => c.id)).toEqual(["clip-1"]);
    const gone = removeClips(there, ["clip-1"]);
    expect(applyAudioOps(there, diffAudio(there, gone)).lanes.flatMap((l) => l.clips)).toHaveLength(
      0,
    );
  });

  it("carries the order of the lanes, a folder and its child, colour and group", () => {
    let base = addLane(song(), newLane("Bass", "lane-2"));
    base = {
      ...base,
      lanes: [
        { ...base.lanes[1]!, folder: true, color: "#ff0000", group: 2 },
        { ...base.lanes[0]!, parent: "lane-2" },
      ],
    };
    const there = carry(base, EMPTY_AUDIO);
    expect(there.lanes.map((l) => l.id)).toEqual(["lane-2", "lane-1"]);
    expect(there.lanes[0]).toMatchObject({ folder: true, color: "#ff0000", group: 2 });
    expect(there.lanes[1]!.parent).toBe("lane-2");
    // Take the folder away again: the child comes out of it.
    const flat = { ...base, lanes: base.lanes.map((l) => ({ ...l, parent: undefined })) };
    const after = applyAudioOps(there, diffAudio(base, flat));
    expect(after.lanes[1]!.parent).toBeUndefined();
  });

  it("carries the sync points, markers and regions by their ids", () => {
    const base = {
      ...song(),
      sync: [
        { bar: 0, ms: 0 },
        { bar: 4, ms: 8_000 },
      ],
      markers: [{ id: "m1", ms: 100, name: "A" }],
      regions: [{ id: "r1", startMs: 0, endMs: 500, name: "Verse" }],
    };
    const there = carry(base, EMPTY_AUDIO);
    expect(there.sync).toEqual(base.sync);
    expect(there.markers).toEqual(base.markers);
    expect(there.regions).toEqual(base.regions);
    const next = { ...base, sync: [{ bar: 0, ms: 0 }], markers: [], regions: [] };
    const after = applyAudioOps(there, diffAudio(base, next));
    expect(after.sync).toEqual([{ bar: 0, ms: 0 }]);
    expect(after.markers).toEqual([]);
    expect(after.regions).toEqual([]);
  });

  it("applying the same operations twice, or in another player's order, gives one result", () => {
    const base = song();
    const ops = diffAudio(base, updateLane(base, "lane-1", { name: "Kit" }));
    const once = applyAudioOps(base, ops);
    expect(applyAudioOps(once, ops)).toEqual(once);
    // An operation for something that is gone is skipped.
    const gone = applyAudioOps(base, [{ t: "a-lane-del", id: "lane-1" }]);
    expect(applyAudioOps(gone, ops).lanes).toEqual([]);
  });

  it("a snapshot builds the same shared lanes from nothing", () => {
    const base = song();
    const there = applyAudioOps(EMPTY_AUDIO, snapshotOps(base));
    expect(diffAudio(base, there)).toEqual([]);
  });

  it("isAudioOp tells lane operations from the tab's", () => {
    expect(isAudioOp({ t: "a-lane-del" })).toBe(true);
    expect(isAudioOp({ t: "ins-bar" })).toBe(false);
  });
});

describe("audio lane sharing: what a hostile player sends", () => {
  const bad = (ops: unknown[]) => expect(validAudioOps(ops as { t: string }[])).toBeNull();

  it("refuses unknown shapes, huge numbers and bad ids", () => {
    bad([{ t: "a-lane-del", id: 5 }]);
    bad([{ t: "a-lane-del", id: "../etc" }]);
    bad([{ t: "a-src-add", source: { id: "nothash", name: "x", ext: "wav" } }]);
    bad([{ t: "a-src-add", source: { id: "a".repeat(64), name: "x", ext: "../.." } }]);
    bad([{ t: "a-lane-add", lane: { id: "x" }, at: 0 }]);
    bad([{ t: "a-lane-order", ids: new Array(MAX_LANES + 1).fill("x") }]);
    bad([{ t: "a-sync-set", point: { bar: 1, ms: 1e12 } }]);
    bad([{ t: "a-mark-set", marker: { id: "m", ms: -1, name: "x" } }]);
    bad([{ t: "a-clip-set", lane: "l", clip: { id: "c" } }]);
  });

  it("refuses a clip with a huge envelope", () => {
    const clip = {
      ...newClip(SRC.id, "x", 0, 1000, "c"),
      envelope: Array.from({ length: 5_000 }, () => ({ at: 0.5, db: 0 })),
    };
    bad([{ t: "a-clip-set", lane: "l", clip }]);
  });

  it("refuses too many operations", () => {
    bad(Array.from({ length: 4_001 }, () => ({ t: "a-lane-del", id: "x" })));
  });

  it("keeps a state inside the limits and drops a clip of a file that is not there", () => {
    const ops: AudioOp[] = [
      {
        t: "a-lane-add",
        lane: sharedLane({
          ...newLane("x", "l1"),
          clips: [newClip("z".repeat(64), "n", 0, 100, "c1")],
        }),
        at: 0,
      },
    ];
    const result = receiveAudioOps(EMPTY_AUDIO, ops)!;
    expect(result.lanes[0]!.clips).toEqual([]);
    const many: AudioOp[] = Array.from({ length: MAX_LANES + 4 }, (_, i) => ({
      t: "a-lane-add",
      lane: sharedLane(newLane(`L${i}`, `l${i}`)),
      at: i,
    }));
    expect(receiveAudioOps(EMPTY_AUDIO, many)!.lanes).toHaveLength(MAX_LANES);
  });

  it("brings values into range", () => {
    const clip = { ...newClip(SRC.id, "x", 0, 1000, "c"), gainDb: 9_999, playrate: 99 };
    const base = addSource(EMPTY_AUDIO, SRC);
    const result = receiveAudioOps(base, [
      { t: "a-lane-add", lane: sharedLane(newLane("x", "l1")), at: 0 },
      { t: "a-clip-set", lane: "l1", clip },
    ])!;
    expect(result.lanes[0]!.clips[0]!.gainDb).toBeLessThanOrEqual(24);
    expect(result.lanes[0]!.clips[0]!.playrate).toBeLessThanOrEqual(4);
  });

  it("never lets another player change this player's mix, whatever the operation says", () => {
    const base = updateLane(song(), "lane-1", { volume: 0.2, mute: true });
    const op = { t: "a-lane-set", id: "lane-1", set: { name: "Z", volume: 1, mute: false } };
    // The checker refuses an operation that names a personal field...
    expect(validAudioOps([op])).toBeNull();
    // ...and applying one anyway only takes the shared names.
    const result = applyAudioOps(base, [op as unknown as AudioOp]);
    expect(result.lanes[0]).toMatchObject({ name: "Z", volume: 0.2, mute: true });
  });
});

describe("audio lane sharing: size", () => {
  const manyClips = (n: number): AudioLanesSettings => {
    const lane = newLane("Big", "lane-big");
    let audio = addLane(addSource(EMPTY_AUDIO, SRC), lane);
    for (let i = 0; i < n; i++) {
      audio = addClip(audio, "lane-big", newClip(SRC.id, "drums.wav", i * 100, 90, `clip-${i}`));
    }
    return audio;
  };

  it("sends a lane with many clips as small operations that each fit in a message", () => {
    const ops = snapshotOps(manyClips(300));
    expect(ops.filter((o) => o.t === "a-clip-set")).toHaveLength(300);
    // The lane itself carries no clips, and no operation is near a frame (16 K characters).
    expect(JSON.stringify(ops.find((o) => o.t === "a-lane-add"))).not.toContain("clips");
    for (const op of ops) expect(JSON.stringify(op).length).toBeLessThan(11_000);
    const there = applyAudioOps(EMPTY_AUDIO, ops);
    expect(there.lanes[0]!.clips).toHaveLength(300);
    expect(diffAudio(manyClips(300), there)).toEqual([]);
  });

  it("a lane that comes back after a reset keeps its mix but not its old clips", () => {
    const mine = updateLane(manyClips(2), "lane-big", { volume: 0.2 });
    const there = applyAudioOps(mine, snapshotOps(song()));
    expect(there.lanes.map((l) => l.id)).toEqual(["lane-1"]);
    const again = applyAudioOps(
      updateLane(manyClips(5), "lane-big", { volume: 0.2 }),
      snapshotOps(manyClips(1)),
    );
    expect(again.lanes[0]).toMatchObject({ volume: 0.2 });
    expect(again.lanes[0]!.clips.map((c) => c.id)).toEqual(["clip-0"]);
  });

  it("never sends what the other end would refuse: a long name is cut, a huge clip is left out", () => {
    const base = manyClips(1);
    const long = updateLane(base, "lane-big", { name: "n".repeat(300) });
    const ops = diffAudio(base, long);
    expect(ops).toEqual([{ t: "a-lane-set", id: "lane-big", set: { name: "n".repeat(120) } }]);
    expect(validAudioOps(ops)).not.toBeNull();
    const huge = {
      ...newClip(SRC.id, "x", 50_000, 1000, "huge"),
      envelope: Array.from({ length: 2_000 }, (_, i) => ({ at: i / 2_000, db: 0 })),
    };
    const withHuge = addClip(base, "lane-big", huge);
    expect(diffAudio(base, withHuge)).toEqual([]);
    // Everything diffAudio makes passes the check the receiver makes.
    const everything = snapshotOps(
      addClip(updateLane(base, "lane-big", { name: "n".repeat(300) }), "lane-big", huge),
    );
    expect(validAudioOps(everything)).not.toBeNull();
  });
});

describe("audio lane sharing: undo of a delete", () => {
  it("brings the lane back with its own mix when the gone lane is given", () => {
    const mixed = updateLane(song(), "lane-1", { volume: 0.3, mute: true, solo: true });
    const without = { ...mixed, lanes: [] };
    const gone = new Map(mixed.lanes.map((l) => [l.id, l]));
    const back = applyAudioOps(without, diffAudio(without, mixed), gone);
    expect(back.lanes[0]).toMatchObject({ volume: 0.3, mute: true, solo: true });
    expect(back.lanes[0]!.clips).toHaveLength(1);
    // Without it the lane comes back with the defaults.
    expect(applyAudioOps(without, diffAudio(without, mixed)).lanes[0]!.volume).toBe(0.8);
  });
});

describe("audio lane sharing: mix changes", () => {
  it("lists the personal fields that changed, and puts them back", () => {
    const base = song();
    const mixed = updateLane(base, "lane-1", { volume: 0.1, collapsed: true, shownInScore: true });
    const changes = mixChanges(base, mixed);
    expect(changes).toEqual([
      { id: "lane-1", set: { volume: 0.1, collapsed: true, shownInScore: true } },
    ]);
    const undone = applyMixChanges(mixed, mixChanges(mixed, base));
    expect(undone.lanes[0]).toMatchObject({ volume: 0.8, collapsed: false });
    expect(undone.lanes[0]!.shownInScore).toBeUndefined();
    expect(mixChanges(base, base)).toEqual([]);
  });
});

describe("audio lane sharing: what is kept of another player's operation", () => {
  it("keeps only the keys a clip, a lane, a file and a marker have", () => {
    const clip = { ...newClip(SRC.id, "x", 0, 1000, "c1"), evil: "<script>", __proto__x: 1 };
    const ops = validAudioOps([
      { t: "a-lane-add", at: 0, lane: { ...sharedLane(newLane("L", "l1")), extra: 1 } },
      { t: "a-clip-set", lane: "l1", clip: { ...clip, takes: [{ ...clip.takes[0], more: 1 }] } },
      { t: "a-src-add", source: { id: "a".repeat(64), name: "n", ext: "wav", path: "/etc/x" } },
      { t: "a-mark-set", marker: { id: "m", ms: 1, name: "m", junk: 1 } },
    ] as never);
    // An extra key on a lane is refused outright; take the lane without it to see the others cleaned.
    expect(ops).toBeNull();
    const cleaned = validAudioOps([
      { t: "a-clip-set", lane: "l1", clip: { ...clip, takes: [{ ...clip.takes[0], more: 1 }] } },
      { t: "a-src-add", source: { id: "a".repeat(64), name: "n", ext: "wav", path: "/etc/x" } },
      { t: "a-mark-set", marker: { id: "m", ms: 1, name: "m", junk: 1 } },
    ] as never)!;
    const text = JSON.stringify(cleaned);
    expect(text).not.toContain("evil");
    expect(text).not.toContain("more");
    expect(text).not.toContain("/etc/x");
    expect(text).not.toContain("junk");
  });

  it("does not take ids that name something on every object", () => {
    for (const id of ["__proto__", "constructor", "prototype"]) {
      expect(validAudioOps([{ t: "a-lane-del", id }])).toBeNull();
      expect(validAudioOps([{ t: "a-clip-del", lane: "l", id }])).toBeNull();
      expect(validAudioOps([{ t: "a-mark-del", id }])).toBeNull();
    }
    expect(validAudioOps([{ t: "a-lane-del", id: "protocol" }])).not.toBeNull();
  });

  it("two clips that differ only in the order of their keys are the same clip", () => {
    const a = song();
    const reordered = {
      ...a,
      lanes: a.lanes.map((l) => ({
        ...l,
        clips: l.clips.map((c) => Object.fromEntries(Object.entries(c).reverse()) as typeof c),
      })),
    };
    expect(diffAudio(a, reordered)).toEqual([]);
  });
});

describe("audio lane sharing: what the editor can make always passes the check", () => {
  it("cuts a 255-character file name, take name and lane name instead of being refused", () => {
    const long = "n".repeat(255);
    const source = { ...SRC, name: `${long}.wav` };
    const lane = newLane(long, "lane-long");
    const state = addClip(
      addLane(addSource(EMPTY_AUDIO, source), lane),
      "lane-long",
      newClip(SRC.id, long, 0, 4_000, "clip-long"),
    );
    const ops = diffAudio(EMPTY_AUDIO, state);
    // The file, the lane and the clip are all there (none is dropped), each within the limits.
    expect(ops.map((o) => o.t)).toEqual(["a-src-add", "a-lane-add", "a-clip-set"]);
    expect(validAudioOps(ops)).not.toBeNull();
    const there = applyAudioOps(EMPTY_AUDIO, ops);
    expect(there.lanes[0]!.clips).toHaveLength(1);
    expect(there.sources).toHaveLength(1);
  });
});
