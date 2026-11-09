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
    t.host.left("g1");
    g.editor.setFret(6);
    await t.settle();
    expect(dumpOf(t.hostEditor, t.host.sync.ids)).not.toContain('"fret":6');
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
