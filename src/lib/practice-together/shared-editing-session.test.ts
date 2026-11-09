import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeGp7 } from "@/lib/export/gp7";
import { scoreFingerprint } from "@/lib/practice-together/fingerprint";
import { HostRoom } from "@/lib/practice-together/host-room";
import { Session } from "@/lib/practice-together/session";
import {
  EditInbox,
  GuestEditing,
  HostEditing,
  type HostLink,
} from "@/lib/practice-together/shared-editing";
import {
  dropPair,
  memoryAcceptor,
  memoryPair,
  openPair,
  type GuestLink,
} from "@/lib/practice-together/transport";
import { ScoreEditor } from "@/lib/score/editor";
import { parseScore } from "@/lib/score/score";
import { practiceSong } from "@/test/shared-edit";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const key = async (editor: ScoreEditor) => (await scoreFingerprint(editor.score)).key;

/** A host with shared editing and a room, over in-memory links. */
async function makeHost() {
  const editor = new ScoreEditor(practiceSong());
  const acceptor = memoryAcceptor();
  const fingerprint = async () => ({
    key: await key(editor),
    bars: editor.score.masterBars.length,
  });
  let host: HostEditing | null = null;
  const snapshot = () => host!.snapshot();
  const room = new HostRoom({
    acceptor: acceptor.acceptor,
    name: "Host",
    score: await fingerprint(),
    hooks: {
      prepare: async () => false,
      schedule: () => () => {},
      position: () => ({ pos: 0, playing: false }),
      approve: async () => true,
      tab: {
        offer: async () => {
          const { seq } = snapshot();
          const bytes = writeGp7(editor.score);
          return { name: "Song", bytes, ...(await fingerprint()), seq };
        },
      },
    },
  });
  const link: HostLink = {
    seats: () => room.editSeats(),
    send: (seat, body) => room.sendEdit(seat, body),
    setLive: (seat, on) => room.setEditLive(seat, on),
    shareTab: (seat) => void room.shareTabTo(seat),
  };
  host = new HostEditing(editor, link, { name: "Host", currentKey: () => key(editor) });
  room.setEditHooks(host);
  // The host tells its guests the tab changed (the app does this after each edit).
  const announce = async () => room.setScore(await fingerprint());
  return { editor, room, acceptor, host, announce };
}

/** A guest that joins, gets the tab as a file and goes live. */
async function joinGuest(
  h: Awaited<ReturnType<typeof makeHost>>,
  id: string,
  existing?: { pair: ReturnType<typeof memoryPair> },
) {
  const pair = existing?.pair ?? memoryPair({ up: 2, down: 2 });
  const state: { editor: ScoreEditor | null; edit: GuestEditing | null } = {
    editor: null,
    edit: null,
  };
  const inbox = new EditInbox();
  let pending: { score: ReturnType<typeof parseScore>["score"]; seq?: number; key: string } | null =
    null;
  const session = new Session({
    role: "guest",
    transport: pair[1],
    name: id,
    score: { key: "something else", bars: 1 },
    guest: id.padEnd(16, "0"),
    now: () => performance.now() + 5_000,
    hooks: {
      prepare: async () => true,
      schedule: () => () => {},
      edit: { receive: (body) => inbox.push(body) },
      tab: {
        receive: async (tab) => {
          pending = { score: parseScore(tab.bytes).score, seq: tab.seq, key: tab.key };
          return null;
        },
        opened: () => {
          const tab = pending!;
          state.editor = new ScoreEditor(tab.score);
          state.edit = new GuestEditing(
            state.editor,
            { send: (body) => session.sendEdit(body) },
            { guest: id.padEnd(16, "0"), seq: tab.seq ?? -1, key: tab.key },
          );
          state.edit.start();
          inbox.listen((body) => state.edit!.receive(body));
        },
      },
    },
  });
  session.start();
  openPair(pair);
  h.acceptor.arrive(pair[0] as GuestLink, { address: "10.0.0.1" });
  await vi.advanceTimersByTimeAsync(3_000);
  return {
    ...state,
    session,
    pair,
    get editor() {
      return state.editor!;
    },
    get edit() {
      return state.edit!;
    },
  };
}

describe("shared editing over a real session", () => {
  it("a guest gets the tab with its edit number, goes live, and edits go both ways", async () => {
    const h = await makeHost();
    h.editor.setFret(6);
    const g = await joinGuest(h, "ann");
    expect(g.edit.live).toBe(true);
    expect(g.edit.editable).toBe(true);
    expect(await key(g.editor)).toBe(await key(h.editor));

    h.editor.setCursorTo({ bar: 0, beat: 1 });
    h.editor.setFret(2);
    g.editor.setCursorTo({ bar: 1, beat: 0 });
    g.editor.setFret(9);
    await vi.advanceTimersByTimeAsync(300);
    expect(await key(g.editor)).toBe(await key(h.editor));
    expect(
      h.editor.score.tracks[0]!.staves[0]!.bars[1]!.voices[0]!.beats[0]!.notes.some(
        (n) => n.fret === 9,
      ),
    ).toBe(true);
  });

  it("the tab is not sent again after every edit while players edit together", async () => {
    const h = await makeHost();
    const g = await joinGuest(h, "ann");
    let offers = 0;
    g.session.subscribe((s) => s.transfer && (offers += 1));
    for (let i = 0; i < 5; i += 1) {
      h.editor.setCursorTo({ bar: 0, beat: 0 });
      h.editor.setFret(i + 1);
      g.editor.setCursorTo({ bar: 1, beat: 0 });
      g.editor.setFret(i + 2);
      await h.announce();
      await vi.advanceTimersByTimeAsync(800);
    }
    await vi.advanceTimersByTimeAsync(1_500);
    expect(offers).toBe(0);
    expect(await key(g.editor)).toBe(await key(h.editor));
  });

  it("a guest that drops and comes back gets what it missed", async () => {
    const h = await makeHost();
    const g = await joinGuest(h, "ann");
    dropPair(g.pair);
    h.editor.setFret(4);
    h.editor.insertBar("after");
    await vi.advanceTimersByTimeAsync(300);
    openPair(g.pair);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(g.edit.live).toBe(true);
    expect(await key(g.editor)).toBe(await key(h.editor));
  });

  it("the host's switch stops a guest's edits, and turning it back on lets them in again", async () => {
    const h = await makeHost();
    const g = await joinGuest(h, "ann");
    h.host.setGuestsCanEdit(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(g.edit.editable).toBe(false);
    h.host.setGuestsCanEdit(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(g.edit.editable).toBe(true);
  });

  it("a kicked guest cannot edit any more", async () => {
    const h = await makeHost();
    const g = await joinGuest(h, "ann");
    h.room.kick("ann".padEnd(16, "0"));
    await vi.advanceTimersByTimeAsync(500);
    g.editor.setFret(12);
    await vi.advanceTimersByTimeAsync(500);
    expect(await key(g.editor)).not.toBe(await key(h.editor));
  });

  it("holds several guests that all edit", async () => {
    const h = await makeHost();
    const a = await joinGuest(h, "ann");
    const b = await joinGuest(h, "bob");
    a.editor.setCursorTo({ bar: 0, beat: 0 });
    b.editor.setCursorTo({ bar: 1, beat: 1 });
    h.editor.setCursorTo({ bar: 2, beat: 0 });
    a.editor.setFret(3);
    b.editor.setFret(5);
    h.editor.setFret(7);
    await vi.advanceTimersByTimeAsync(500);
    const k = await key(h.editor);
    expect(await key(a.editor)).toBe(k);
    expect(await key(b.editor)).toBe(k);
  });
});
