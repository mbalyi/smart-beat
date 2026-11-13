import {
  applyAudioOps,
  diffAudio,
  isAudioOp,
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
    expect(ops.map((o) => o.t)).toEqual(["a-src-add", "a-lane-add"]);
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
      { t: "a-lane-add", lane: sharedLane({ ...newLane("x", "l1"), clips: [clip] }), at: 0 },
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
