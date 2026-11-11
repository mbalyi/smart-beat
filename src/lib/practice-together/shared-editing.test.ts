import { writeGp7 } from "@/lib/export/gp7";
import { scoreFingerprint } from "@/lib/practice-together/fingerprint";
import type { EditBody } from "@/lib/practice-together/protocol";
import {
  EditInbox,
  GuestEditing,
  HostEditing,
  hueOf,
  locate,
  presenceOf,
  splitOps,
  type HostLink,
} from "@/lib/practice-together/shared-editing";
import { ScoreEditor } from "@/lib/score/editor";
import { subtree } from "@/lib/score/ops/ids";
import { parseScore } from "@/lib/score/score";
import { practiceSong } from "@/test/shared-edit";

/** The id of every part of the tab, in order: two players with the same ids can address the same parts. */
const dumpOf = (editor: ScoreEditor, ids: HostEditing["sync"]["ids"]) =>
  JSON.stringify([
    editor.score.masterBars.map((m) => ids.uid(m)),
    ...editor.score.tracks.flatMap((t) => [...subtree(t)].map((part) => ids.uid(part))),
  ]);

/** A host and its guests, linked in memory; nothing arrives until `settle`. */
function setup() {
  const hostEditor = new ScoreEditor(practiceSong());
  const guests = new Map<string, { editor: ScoreEditor; edit: GuestEditing }>();
  const toGuest = new Map<string, EditBody[]>();
  const toHost: { id: string; body: EditBody }[] = [];
  const lives = new Map<string, boolean>();
  const reshared: string[] = [];
  let key = "key";
  const link: HostLink = {
    seats: () => [...guests.keys()].map((id) => ({ id, name: `Guest ${id}` })),
    send: (seat, body) => void (toGuest.get(seat) ?? toGuest.set(seat, []).get(seat))!.push(body),
    setLive: (seat, on) => void lives.set(seat, on),
    shareTab: (seat) => void reshared.push(seat),
  };
  const host = new HostEditing(hostEditor, link, { name: "Host", currentKey: async () => key });

  /** A guest opens the file the host wrote now (what the tab transfer does) and joins. */
  function join(id: string, options: { file?: boolean; key?: string } = {}) {
    const snapshot = options.file === false ? null : host.snapshot();
    const score =
      options.file === false ? practiceSong() : parseScore(writeGp7(hostEditor.score)).score;
    const editor = new ScoreEditor(score);
    const edit = new GuestEditing(
      editor,
      { send: (body) => void toHost.push({ id, body }) },
      { guest: id, seq: snapshot?.seq ?? -1, key: options.key ?? key },
    );
    edit.start();
    guests.set(id, { editor, edit });
    host.welcomed(id);
    return { editor, edit };
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

  return {
    /** What the guests said that the host has not heard yet. */
    takeUpstream: () => toHost.splice(0),
    host,
    hostEditor,
    guests,
    join,
    settle,
    lives,
    reshared,
    toGuest,
    setKey: (next: string) => (key = next),
  };
}

const sameTab = async (a: ScoreEditor, b: ScoreEditor) =>
  expect((await scoreFingerprint(a.score)).key).toBe((await scoreFingerprint(b.score)).key);

describe("shared editing: joining", () => {
  it("a guest that got the tab goes live and then edits both ways", async () => {
    const t = setup();
    const g = t.join("g1");
    await t.settle();
    expect(g.edit.live).toBe(true);
    expect(g.edit.editable).toBe(true);
    expect(t.lives.get("g1")).toBe(true);

    t.hostEditor.setFret(7);
    g.editor.setCursorTo({ bar: 1, beat: 0 });
    g.editor.setFret(3);
    await t.settle();
    await sameTab(t.hostEditor, g.editor);
    expect(dumpOf(g.editor, g.edit.sync.ids)).toBe(dumpOf(t.hostEditor, t.host.sync.ids));
  });

  it("a guest joining after the host edited gets ids that match, so its edits land", async () => {
    const t = setup();
    // The host edits (some parts are new, so they have ids the file cannot give).
    t.hostEditor.setFret(5);
    t.hostEditor.insertBar("after");
    t.hostEditor.setFret(2);
    const g = t.join("g1");
    await t.settle();
    expect(g.edit.live).toBe(true);
    expect(dumpOf(g.editor, g.edit.sync.ids)).toBe(dumpOf(t.hostEditor, t.host.sync.ids));
    // An edit on a part the host made after the session began:
    g.editor.setCursorTo({ bar: 1, beat: 0 });
    g.editor.setFret(9);
    t.hostEditor.setCursorTo({ bar: 0, beat: 0 });
    t.hostEditor.setFret(1);
    await t.settle();
    await sameTab(t.hostEditor, g.editor);
  });

  it("edits made while the tab was on its way are replayed", async () => {
    const t = setup();
    const snapshot = t.host.snapshot();
    const file = parseScore(writeGp7(t.hostEditor.score)).score;
    const editor = new ScoreEditor(file);
    const toHost: EditBody[] = [];
    const edit = new GuestEditing(
      editor,
      { send: (b) => void toHost.push(b) },
      { guest: "g1", seq: snapshot.seq, key: "key" },
    );
    edit.start();
    t.guests.set("g1", { editor, edit });
    t.host.welcomed("g1");
    // Edits during the transfer: nobody sees them yet.
    t.hostEditor.setFret(4);
    t.hostEditor.insertBar("before");
    for (const body of toHost.splice(0)) t.host.receive("g1", body);
    // The guest answers the host's rights message:
    for (const body of t.toGuest.get("g1")!.splice(0)) edit.receive(body);
    for (const body of toHost.splice(0)) t.host.receive("g1", body);
    for (const body of t.toGuest.get("g1")!.splice(0)) edit.receive(body);
    expect(edit.live).toBe(true);
    await sameTab(t.hostEditor, editor);
  });

  it("a guest that already had the tab (no file) is served when its key matches", async () => {
    const t = setup();
    const g = t.join("g1", { file: false });
    await t.settle();
    expect(g.edit.live).toBe(true);
    await sameTab(t.hostEditor, g.editor);
  });

  it("a guest whose tab differs is sent the tab again instead", async () => {
    const t = setup();
    t.hostEditor.setFret(5);
    const g = t.join("g1", { file: false, key: "older" });
    await t.settle();
    expect(g.edit.live).toBe(false);
    expect(t.reshared).toContain("g1");
  });
});

describe("shared editing: rights", () => {
  it("turning editing off makes a guest read-only and its edits are not applied", async () => {
    const t = setup();
    const g = t.join("g1");
    await t.settle();
    t.host.setGuestsCanEdit(false);
    await t.settle();
    expect(g.edit.editable).toBe(false);
    expect(t.host.guestsCanEdit).toBe(false);
    // A modified guest that sends an edit anyway:
    g.edit.sync.attach();
    g.editor.setFret(11);
    await t.settle();
    expect(dumpOf(g.editor, g.edit.sync.ids)).not.toBe(dumpOf(t.hostEditor, t.host.sync.ids));
    t.host.setGuestsCanEdit(true);
    await t.settle();
    expect(g.edit.editable).toBe(true);
  });

  it("a guest that is kicked loses its edits", async () => {
    const t = setup();
    const g = t.join("g1");
    await t.settle();
    const before = (await scoreFingerprint(t.hostEditor.score)).key;
    t.host.left("g1");
    g.editor.setFret(6);
    await t.settle();
    // The host's tab is what it was, and nothing was published to anyone.
    expect((await scoreFingerprint(t.hostEditor.score)).key).toBe(before);
    expect(t.host.seq).toBe(0);
  });

  it("an edit already on its way when the guest is kicked is not applied", async () => {
    const t = setup();
    const g = t.join("g1");
    await t.settle();
    const before = (await scoreFingerprint(t.hostEditor.score)).key;
    g.editor.setFret(6);
    // The host removes the guest before the edit reaches it.
    t.host.left("g1");
    await t.settle();
    expect((await scoreFingerprint(t.hostEditor.score)).key).toBe(before);
    expect(t.host.seq).toBe(0);
  });
});

describe("shared editing: reconnecting", () => {
  it("a guest that was away gets the edits it missed, and its own unsent edits arrive", async () => {
    const t = setup();
    const g = t.join("g1");
    await t.settle();
    // The line drops: nothing reaches the guest, and the guest's frames are lost too.
    t.hostEditor.setFret(2);
    t.hostEditor.insertBar("after");
    t.toGuest.get("g1")!.splice(0);
    g.editor.setCursorTo({ bar: 0, beat: 1 });
    g.editor.setFret(8);
    t.guests.get("g1")!.edit.sync.pending();
    // (the guest's frame is dropped by the line)
    // The host says hello again (the guest came back): rights, then the guest asks since.
    t.host.welcomed("g1");
    await t.settle();
    expect(g.edit.live).toBe(true);
    await t.settle();
    await sameTab(t.hostEditor, g.editor);
  });
});

describe("shared editing: cursors", () => {
  it("shows where the other players are, by name and colour, and drops them when they leave", async () => {
    const t = setup();
    const a = t.join("a");
    const b = t.join("b");
    await t.settle();
    a.editor.setCursorTo({ bar: 2, beat: 0 });
    a.edit.setPresence();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await t.settle();
    const seen = b.edit.players.find((p) => p.id === "a");
    expect(seen).toMatchObject({ name: "Guest a", hue: hueOf("a") });
    const spot = locate(b.edit.sync, seen!.cur!);
    expect(spot?.beat.voice.bar.index).toBe(2);
    expect(t.host.players.map((p) => p.id)).toContain("a");
    t.host.left("a");
    await t.settle();
    expect(b.edit.players.find((p) => p.id === "a")).toBeUndefined();
  });

  it("a cursor follows its beat when a bar is inserted before it", async () => {
    const t = setup();
    const a = t.join("a");
    await t.settle();
    a.editor.setCursorTo({ bar: 2, beat: 0 });
    const cur = presenceOf(a.editor, a.edit.sync)!;
    t.hostEditor.setCursorTo({ bar: 0, beat: 0 });
    t.hostEditor.insertBar("before");
    await t.settle();
    expect(locate(a.edit.sync, cur)?.beat.voice.bar.index).toBe(3);
    expect(a.editor.cursor.bar).toBe(3);
  });
});

describe("shared editing: a selected range in the cursor", () => {
  const presence = async (selects: (editor: ScoreEditor) => void) => {
    const t = setup();
    const a = t.join("a");
    await t.settle();
    selects(a.editor);
    return presenceOf(a.editor, a.edit.sync)!;
  };

  it("sends no range for a single position", async () => {
    expect(await presence((e) => e.setCursorTo({ bar: 1, beat: 1 }))).not.toHaveProperty("sel");
  });

  it("sends the range the player selected with Shift, a click or select all", async () => {
    expect(await presence((e) => e.moveBeat(1, true))).toHaveProperty("sel");
    expect(await presence((e) => e.setCursorTo({ bar: 1, beat: 1 }, true))).toHaveProperty("sel");
    expect(await presence((e) => e.selectAll())).toHaveProperty("sel");
  });

  it("sends no range once the player moved on without Shift or cleared it", async () => {
    expect(
      await presence((e) => {
        e.moveBeat(1, true);
        e.moveBeat(1);
      }),
    ).not.toHaveProperty("sel");
    expect(
      await presence((e) => {
        e.selectAll();
        e.clearSelection();
      }),
    ).not.toHaveProperty("sel");
  });

  it("sends no range when the selection is only what an edit left behind", async () => {
    const typed = await presence((e) => {
      e.moveBeat(1, true);
      e.typeDigit(5);
    });
    expect(typed).not.toHaveProperty("sel");
    const pasted = await presence((e) => {
      e.moveBeat(1, true);
      e.copy();
      e.moveBar(1);
      e.paste();
    });
    expect(pasted).not.toHaveProperty("sel");
    const undone = await presence((e) => {
      e.moveBeat(1, true);
      e.moveBeat(1, true);
      e.typeDigit(5);
      e.undo();
    });
    expect(undone).not.toHaveProperty("sel");
    expect(
      await presence((e) => {
        e.copyBar(0);
      }),
    ).not.toHaveProperty("sel");
  });

  it("sends the drum line of a drummer, and locate() gives it back", async () => {
    const t = setup();
    const a = t.join("a");
    await t.settle();
    // The test song has no drum track: a drummer's cursor is read from the editor's cursor, so
    // fake the two things `presenceOf` reads.
    const drums = Object.create(a.editor) as typeof a.editor;
    Object.defineProperty(drums, "kind", { value: "drums" });
    Object.defineProperty(drums, "cursor", { value: { ...a.editor.cursor, line: 3 } });
    const cur = presenceOf(drums, a.edit.sync)!;
    expect(cur).toMatchObject({ line: 3 });
    expect(cur).not.toHaveProperty("string");
    expect(locate(a.edit.sync, cur)).toMatchObject({ line: 3 });
    // A guitarist sends a string, no line.
    expect(presenceOf(a.editor, a.edit.sync)).not.toHaveProperty("line");
  });

  it("drops the range when another player's edit arrives", async () => {
    const t = setup();
    const a = t.join("a");
    await t.settle();
    a.editor.moveBeat(1, true);
    expect(presenceOf(a.editor, a.edit.sync)).toHaveProperty("sel");
    t.hostEditor.setCursorTo({ bar: 3, beat: 0 });
    t.hostEditor.typeDigit(4);
    await t.settle();
    expect(presenceOf(a.editor, a.edit.sync)).not.toHaveProperty("sel");
  });
});

describe("shared editing: big batches and the inbox", () => {
  it("splits a batch that does not fit a frame, and the other side puts it back together", async () => {
    const t = setup();
    const g = t.join("g1");
    await t.settle();
    g.editor.setCursorTo({ bar: 0, beat: 0 });
    g.editor.copyBar(0);
    g.editor.pasteBarsAfter(0);
    g.editor.pasteBarsAfter(1);
    g.editor.pasteBarsAfter(2);
    await t.settle();
    await sameTab(t.hostEditor, g.editor);
    expect(t.hostEditor.score.masterBars.length).toBe(g.editor.score.masterBars.length);
  });

  it("splitOps keeps each part small and refuses an operation that alone is too big", () => {
    const op = { t: "set", u: "x", d: { v: "y".repeat(2000) } };
    const parts = splitOps(Array.from({ length: 20 }, () => op))!;
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => JSON.stringify(part).length < 12000)).toBe(true);
    expect(splitOps([{ t: "set", u: "x", d: { v: "y".repeat(20000) } }])).toBeNull();
  });

  it("the inbox holds messages until something listens", () => {
    const inbox = new EditInbox();
    const heard: string[] = [];
    inbox.push({ k: "live", seq: 1 });
    inbox.push({ k: "rights", canEdit: true });
    inbox.listen((body) => heard.push(body.k));
    inbox.push({ k: "resync" });
    expect(heard).toEqual(["live", "rights", "resync"]);
  });
});

describe("shared editing: what the host does not trust", () => {
  it("ignores operations that are not well formed, and gives the guest the tab again", async () => {
    const t = setup();
    const g = t.join("g1");
    await t.settle();
    const before = (await scoreFingerprint(t.hostEditor.score)).key;
    const hostile: EditBody[] = [
      { k: "ops", ops: [{ t: "ins", k: "beat", p: "m0:t0.s0.v0", a: null }] },
      { k: "ops", ops: [{ t: "set", u: "m0:t0.s0.v0.b0" }] },
      {
        k: "ops",
        ops: [JSON.parse('{"t":"set","u":"m0:t0.s0.v0.b0.n0","d":{"__proto__":{"x":1}}}')],
      },
      {
        k: "ops",
        ops: [
          {
            t: "ins",
            k: "track",
            p: null,
            a: null,
            d: { u: "t9", k: "track", p: {}, c: [{ u: "b", k: "beat", p: {} }] },
          },
        ],
      },
    ];
    for (const body of hostile) {
      t.reshared.length = 0;
      expect(() => t.host.receive("g1", body)).not.toThrow();
      expect(t.reshared).toContain("g1");
      // The guest takes the tab again, as it would from the app.
      t.host.receive("g1", { k: "since", seq: t.host.snapshot().seq, key: "k" });
      await t.settle();
      expect(g.edit.live).toBe(true);
    }
    expect((await scoreFingerprint(t.hostEditor.score)).key).toBe(before);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(t.host.seq).toBe(0);
  });

  it("an operation that fails while it is applied leaves the others with a fresh tab, not half an edit", async () => {
    const t = setup();
    const g = t.join("g1");
    await t.settle();
    t.reshared.length = 0;
    // Well formed, but its property cannot be written (a part of the score as a nested object).
    t.host.receive("g1", {
      k: "ops",
      ops: [{ t: "set", u: "m0:t0.s0.v0.b0", d: { duration: { $c: "Track", p: {} } } }],
    });
    expect(t.reshared).toContain("g1");
    expect(t.host.seq).toBe(0);
    void g;
  });

  it("a guest that sends parts out of order or without a start is given the tab again", async () => {
    const t = setup();
    t.join("g1");
    await t.settle();
    const op = { t: "del", u: "nothing" };
    t.reshared.length = 0;
    t.host.receive("g1", { k: "ops", ops: [op], part: [1, 3] });
    expect(t.reshared).toContain("g1");
    await t.settle();
    t.reshared.length = 0;
    t.host.receive("g1", { k: "ops", ops: [op], part: [5, 3] });
    expect(t.reshared).toContain("g1");
  });

  it("does not hold on to parts without end", async () => {
    const t = setup();
    const g = t.join("g1");
    await t.settle();
    const many = Array.from({ length: 4000 }, () => ({ t: "del", u: "nothing" }));
    t.reshared.length = 0;
    t.host.receive("g1", { k: "ops", ops: many, part: [0, 100] });
    for (let i = 1; i < 10 && t.reshared.length === 0; i += 1) {
      t.host.receive("g1", { k: "ops", ops: many, part: [i, 100] });
    }
    expect(t.reshared).toContain("g1");
    void g;
  });

  it("a guest whose rights are taken away while its edit is on its way gets the host's tab", async () => {
    const t = setup();
    const g = t.join("g1");
    await t.settle();
    const before = (await scoreFingerprint(t.hostEditor.score)).key;
    // The guest edits; before that reaches the host, the host turns editing off.
    g.editor.setFret(11);
    t.host.setGuestsCanEdit(false);
    t.reshared.length = 0;
    await t.settle();
    expect((await scoreFingerprint(t.hostEditor.score)).key).toBe(before);
    expect(t.reshared).toContain("g1");
  });

  it("an ended host editing does not serve a guest that was being served", async () => {
    const t = setup();
    t.setKey("slow");
    const first = t.join("g1", { file: false, key: "slow" });
    // The guest's "since" is being served (it awaits the host's key) when the host moves to
    // another tab.
    for (const item of t.takeUpstream()) t.host.receive(item.id, item.body);
    t.host.end();
    await t.settle();
    expect(first.edit.live).toBe(false);
    expect(t.lives.get("g1")).not.toBe(true);
  });
});

describe("shared editing: the order of the host's edits", () => {
  it("skips an edit it already applied and asks for what it missed after a gap", async () => {
    const t = setup();
    const g = t.join("g1");
    await t.settle();
    const sent: EditBody[] = [];
    const original = t.host.sync;
    void original;
    t.hostEditor.setFret(2);
    t.hostEditor.setFret(3);
    const queued = t.toGuest.get("g1")!.filter((b) => b.k === "ops");
    expect(queued.length).toBe(2);
    // The second arrives first (the first was lost): a gap, so the guest asks for the missed ones.
    const [first, second] = queued as Extract<EditBody, { k: "ops" }>[];
    t.toGuest.get("g1")!.length = 0;
    g.edit.receive(second!);
    const asked = t.takeUpstream();
    expect(
      asked.some((item) => item.body.k === "since" && (item.body as { resume?: boolean }).resume),
    ).toBe(true);
    for (const item of asked) t.host.receive(item.id, item.body);
    await t.settle();
    await sameTab(t.hostEditor, g.editor);
    // The same edit again (a replay) changes nothing.
    const before = (await scoreFingerprint(g.editor.score)).key;
    g.edit.receive(first!);
    g.edit.receive(second!);
    expect((await scoreFingerprint(g.editor.score)).key).toBe(before);
    void sent;
  });

  it("does not take a switch on or off for a come-back", async () => {
    const t = setup();
    const g = t.join("g1");
    await t.settle();
    t.host.setGuestsCanEdit(false);
    await t.settle();
    t.host.setGuestsCanEdit(false);
    t.host.setGuestsCanEdit(true);
    const upstream = t.takeUpstream();
    expect(upstream.some((item) => item.body.k === "since")).toBe(false);
    await t.settle();
    expect(g.edit.editable).toBe(true);
  });

  it("a guest more than the log behind gets the tab, not the edits", async () => {
    const t = setup();
    const g = t.join("g1");
    await t.settle();
    // The guest is away for more edits than the host keeps.
    t.toGuest.get("g1")!.length = 0;
    for (let i = 0; i < 405; i += 1) {
      t.hostEditor.setCursorTo({ bar: i % 4, beat: 0 });
      t.hostEditor.setFret((i % 20) + 1);
    }
    t.toGuest.get("g1")!.length = 0;
    t.reshared.length = 0;
    t.host.welcomed("g1");
    await t.settle();
    expect(t.reshared).toContain("g1");
    // It waits for the tab; it is not live on edits it cannot be brought up to date with.
    expect(g.edit.live).toBe(false);
  });
});
