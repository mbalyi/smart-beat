/**
 * Practice together shares the audio lanes through the same channel as the tab: the host numbers
 * and hands out the operations, a guest that joins gets the lanes as they are, and an app that does
 * not know lanes (an older one) only gets the tab's edits.
 */
import {
  applyAudioOps,
  diffAudio,
  receiveAudioOps,
  snapshotOps,
  type LaneBridge,
} from "@/lib/audio-lanes/collab";
import { addClip, addLane, addSource, updateLane } from "@/lib/audio-lanes/edits";
import { EMPTY_AUDIO, newClip, newLane } from "@/lib/audio-lanes/model";
import { writeGp7 } from "@/lib/export/gp7";
import type { EditBody } from "@/lib/practice-together/protocol";
import { GuestEditing, HostEditing, type HostLink } from "@/lib/practice-together/shared-editing";
import { ScoreEditor } from "@/lib/score/editor";
import { parseScore } from "@/lib/score/score";
import type { AudioLanesSettings, AudioSource } from "@/lib/tauri";
import { practiceSong } from "@/test/shared-edit";

const SRC: AudioSource = { id: "b".repeat(64), name: "bass.wav", ext: "wav", embedded: true };

/** One player's lanes: what the lanes controller does with the session's bridge, without React. */
class Lanes implements LaneBridge {
  audio: AudioLanesSettings;
  base: AudioLanesSettings | null = null;
  refuse = false;
  constructor(audio: AudioLanesSettings = EMPTY_AUDIO) {
    this.audio = audio;
  }
  snapshot = () => snapshotOps(this.audio);
  apply = (ops: { t: string }[]) => {
    if (this.refuse) return false;
    const next = receiveAudioOps(this.audio, ops);
    if (!next) return false;
    this.base = this.base ? (receiveAudioOps(this.base, ops) ?? next) : next;
    this.audio = next;
    return true;
  };
  begin = (host: boolean) => {
    this.base = host ? this.audio : null;
  };
  end = () => {
    this.base = null;
  };
  /** The player edits the lanes; the diff goes out. */
  edit(next: AudioLanesSettings, send: (ops: ReturnType<typeof diffAudio>) => boolean) {
    const ops = diffAudio(this.audio, next);
    this.audio = next;
    this.base = next;
    return send(ops);
  }
}

function songWithLane(): AudioLanesSettings {
  const lane = newLane("Bass", "lane-bass");
  return addClip(
    addLane(addSource(EMPTY_AUDIO, SRC), lane),
    "lane-bass",
    newClip(SRC.id, "bass.wav", 0, 2_000, "clip-1"),
  );
}

function setup(initial: AudioLanesSettings = EMPTY_AUDIO) {
  const hostEditor = new ScoreEditor(practiceSong());
  const hostLanes = new Lanes(initial);
  const guests = new Map<
    string,
    { editor: ScoreEditor; edit: GuestEditing; lanes: Lanes; oldApp: boolean }
  >();
  const toGuest = new Map<string, EditBody[]>();
  const toHost: { id: string; body: EditBody }[] = [];
  const reshared: string[] = [];
  const link: HostLink = {
    seats: () => [...guests].map(([id, g]) => ({ id, name: id, lanes: !g.oldApp })),
    send: (seat, body) => void (toGuest.get(seat) ?? toGuest.set(seat, []).get(seat))!.push(body),
    setLive: () => {},
    shareTab: (seat) => void reshared.push(seat),
  };
  const host = new HostEditing(hostEditor, link, {
    name: "Host",
    currentKey: async () => "key",
    lanes: () => hostLanes,
  });
  hostLanes.begin(true);

  function join(id: string, options: { oldApp?: boolean; audio?: AudioLanesSettings } = {}) {
    const snapshot = host.snapshot();
    const editor = new ScoreEditor(parseScore(writeGp7(hostEditor.score)).score);
    const lanes = new Lanes(options.audio ?? EMPTY_AUDIO);
    const edit = new GuestEditing(
      editor,
      { send: (body) => void toHost.push({ id, body }) },
      {
        guest: id,
        seq: snapshot.seq,
        key: "key",
        lanes: () => lanes,
        hostLanes: () => !options.oldApp,
      },
    );
    lanes.begin(false);
    edit.start();
    guests.set(id, { editor, edit, lanes, oldApp: options.oldApp ?? false });
    host.welcomed(id);
    return { editor, edit, lanes };
  }

  async function settle() {
    for (let i = 0; i < 30; i++) {
      let moved = false;
      for (const item of toHost.splice(0)) {
        moved = true;
        host.receive(item.id, item.body);
      }
      await Promise.resolve();
      for (const [id, queue] of toGuest) {
        for (const body of queue.splice(0)) {
          moved = true;
          guests.get(id)?.edit.receive(body);
        }
      }
      if (!moved) return;
    }
  }
  return { host, hostEditor, hostLanes, guests, join, settle, reshared, toGuest };
}

describe("shared editing: audio lanes", () => {
  it("a guest that joins gets the host's lanes, with their file listed", async () => {
    const t = setup(songWithLane());
    const g = t.join("g1");
    await t.settle();
    expect(g.edit.live).toBe(true);
    expect(g.lanes.audio.lanes.map((l) => l.name)).toEqual(["Bass"]);
    expect(g.lanes.audio.lanes[0]!.clips).toHaveLength(1);
    expect(g.lanes.audio.sources.map((s) => s.id)).toEqual([SRC.id]);
    expect(diffAudio(t.hostLanes.audio, g.lanes.audio)).toEqual([]);
  });

  it("a guest's own lanes are replaced by the host's, keeping its mix of a lane both have", async () => {
    const t = setup(songWithLane());
    const mine = updateLane(songWithLane(), "lane-bass", { volume: 0.2, mute: true });
    const other = addLane(mine, newLane("Mine only", "lane-mine"));
    const g = t.join("g1", { audio: other });
    await t.settle();
    expect(g.lanes.audio.lanes.map((l) => l.id)).toEqual(["lane-bass"]);
    expect(g.lanes.audio.lanes[0]).toMatchObject({ volume: 0.2, mute: true });
  });

  it("a lane the host adds reaches the guests, and a guest's reaches the host and the others", async () => {
    const t = setup();
    const a = t.join("a");
    const b = t.join("b");
    await t.settle();

    t.hostLanes.edit(songWithLane(), (ops) => t.host.sendLanes(ops));
    await t.settle();
    expect(a.lanes.audio.lanes.map((l) => l.name)).toEqual(["Bass"]);
    expect(b.lanes.audio.lanes.map((l) => l.name)).toEqual(["Bass"]);

    const next = updateLane(a.lanes.audio, "lane-bass", { name: "Fat bass" });
    expect(a.lanes.edit(next, (ops) => a.edit.sendLanes(ops))).toBe(true);
    await t.settle();
    expect(t.hostLanes.audio.lanes[0]!.name).toBe("Fat bass");
    expect(b.lanes.audio.lanes[0]!.name).toBe("Fat bass");
  });

  it("every player ends with the same shared lanes after edits from several players", async () => {
    const t = setup(songWithLane());
    const a = t.join("a");
    const b = t.join("b");
    await t.settle();
    const edits = [
      () =>
        a.lanes.edit(updateLane(a.lanes.audio, "lane-bass", { name: "A" }), (o) =>
          a.edit.sendLanes(o),
        ),
      () =>
        b.lanes.edit(updateLane(b.lanes.audio, "lane-bass", { color: "#00ff00" }), (o) =>
          b.edit.sendLanes(o),
        ),
      () =>
        t.hostLanes.edit(addLane(t.hostLanes.audio, newLane("Keys", "lane-keys")), (o) =>
          t.host.sendLanes(o),
        ),
    ];
    for (const edit of edits) edit();
    await t.settle();
    expect(diffAudio(t.hostLanes.audio, a.lanes.audio)).toEqual([]);
    expect(diffAudio(t.hostLanes.audio, b.lanes.audio)).toEqual([]);
    expect(t.hostLanes.audio.lanes.map((l) => l.id)).toEqual(["lane-bass", "lane-keys"]);
  });

  it("does not send a player's own mix", async () => {
    const t = setup(songWithLane());
    const a = t.join("a");
    await t.settle();
    const muted = updateLane(a.lanes.audio, "lane-bass", { volume: 0.1, mute: true, solo: true });
    // Nothing differs in what is shared, so there is nothing to send.
    expect(diffAudio(a.lanes.audio, muted)).toEqual([]);
    expect(t.hostLanes.audio.lanes[0]).toMatchObject({ volume: 0.8, mute: false });
  });

  it("an app without audio lanes gets the tab's edits and no lane operations", async () => {
    const t = setup(songWithLane());
    const old = t.join("old", { oldApp: true });
    await t.settle();
    expect(old.edit.live).toBe(true);
    expect(old.lanes.audio.lanes).toEqual([]);
    // A lane edit and then a tab edit: the old app counts the edits one by one and keeps up.
    t.hostLanes.edit(addLane(t.hostLanes.audio, newLane("Keys", "lane-keys")), (o) =>
      t.host.sendLanes(o),
    );
    t.hostEditor.setFret(6);
    await t.settle();
    expect(old.edit.live).toBe(true);
    expect(t.reshared).toEqual([]);
    expect(old.lanes.audio.lanes).toEqual([]);
    // And the lane operation never left the host for it.
    expect(JSON.stringify([...t.toGuest.values()])).not.toContain("a-lane");
  });

  it("a guest that sends lanes to a host without them does not send", async () => {
    const t = setup();
    const g = t.join("g1", { oldApp: true });
    await t.settle();
    expect(g.edit.sendLanes([])).toBe(false);
  });

  it("a lane batch the host refuses gives that guest the tab and lanes again", async () => {
    const t = setup(songWithLane());
    const g = t.join("g1");
    await t.settle();
    t.hostLanes.refuse = true;
    g.lanes.edit(updateLane(g.lanes.audio, "lane-bass", { name: "X" }), (ops) =>
      g.edit.sendLanes(ops),
    );
    await t.settle();
    expect(t.reshared).toEqual(["g1"]);
  });

  it("a hostile batch of lane operations from a guest is refused", async () => {
    const t = setup(songWithLane());
    const g = t.join("g1");
    await t.settle();
    // A real bridge refuses it; the host then hands that guest the tab again.
    t.hostLanes.apply = () => false;
    g.edit.sendLanes([{ t: "a-lane-del", id: "../x" }]);
    await t.settle();
    expect(t.reshared).toEqual(["g1"]);
    expect(t.hostLanes.audio.lanes).toHaveLength(1);
  });

  it("a guest that was away gets the lane edits it missed", async () => {
    const t = setup(songWithLane());
    const a = t.join("a");
    await t.settle();
    // The guest's line drops: it asks for what it missed, with the same lanes controller.
    t.hostLanes.edit(updateLane(t.hostLanes.audio, "lane-bass", { name: "While away" }), (o) =>
      t.host.sendLanes(o),
    );
    t.toGuest.get("a")!.splice(1); // the frame is lost on the way
    await t.settle();
    t.hostLanes.edit(updateLane(t.hostLanes.audio, "lane-bass", { name: "After" }), (o) =>
      t.host.sendLanes(o),
    );
    await t.settle();
    expect(a.lanes.audio.lanes[0]!.name).toBe("After");
  });

  it("applying a snapshot twice gives the same lanes", () => {
    const base = songWithLane();
    const once = applyAudioOps(EMPTY_AUDIO, snapshotOps(base));
    expect(applyAudioOps(once, snapshotOps(base))).toEqual(once);
  });

  it("a lane with many clips reaches a guest that joins, and a guest's edit of it is shared", async () => {
    let big = addLane(addSource(EMPTY_AUDIO, SRC), newLane("Big", "lane-big"));
    for (let i = 0; i < 120; i++) {
      big = addClip(big, "lane-big", newClip(SRC.id, "bass.wav", i * 100, 90, `clip-${i}`));
    }
    const t = setup(big);
    const g = t.join("g1");
    await t.settle();
    // No endless starting over: the tab was not sent again, and the guest has every clip.
    expect(t.reshared).toEqual([]);
    expect(g.edit.live).toBe(true);
    expect(g.lanes.audio.lanes[0]!.clips).toHaveLength(120);
    // A change of one clip of that lane goes the other way.
    const moved = {
      ...g.lanes.audio,
      lanes: g.lanes.audio.lanes.map((l) => ({
        ...l,
        clips: l.clips.map((c) => (c.id === "clip-7" ? { ...c, gainDb: -6 } : c)),
      })),
    };
    expect(g.lanes.edit(moved, (ops) => g.edit.sendLanes(ops))).toBe(true);
    await t.settle();
    expect(t.hostLanes.audio.lanes[0]!.clips.find((c) => c.id === "clip-7")!.gainDb).toBe(-6);
  });

  it("stops asking for the tab again when a guest's lane batches keep being refused", async () => {
    const t = setup(songWithLane());
    const g = t.join("g1");
    await t.settle();
    t.hostLanes.apply = () => false;
    for (let i = 0; i < 6; i++) {
      // The host sends the tab again and the guest is up to date once more (what a real guest does).
      t.host.receive("g1", { k: "since", seq: t.host.seq, resume: true });
      await t.settle();
      g.edit.sendLanes([{ t: "a-lane-del", id: "lane-bass" }]);
      await t.settle();
    }
    // Asked a few times, then ignored: no endless loop.
    expect(t.reshared.length).toBe(3);
  });

  it("a guest that cannot take the host's lanes stops asking after a few tries and keeps the tab", async () => {
    const t = setup(songWithLane());
    const g = t.join("g1");
    await t.settle();
    g.lanes.apply = () => false;
    for (let i = 0; i < 6; i++) {
      t.host.receive("g1", { k: "since", seq: t.host.seq, resume: true });
      await t.settle();
      t.hostLanes.edit(updateLane(t.hostLanes.audio, "lane-bass", { name: `Name ${i}` }), (ops) =>
        t.host.sendLanes(ops),
      );
      await t.settle();
    }
    expect(g.edit.lanesOff).toBe(true);
    // Asked three times, not six; and the tab keeps working.
    expect(t.reshared.length).toBe(3);
    t.host.receive("g1", { k: "since", seq: t.host.seq, resume: true });
    await t.settle();
    t.hostEditor.setFret(3);
    await t.settle();
    expect(g.edit.live).toBe(true);
  });
});
