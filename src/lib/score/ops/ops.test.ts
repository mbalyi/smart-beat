import { scoreFingerprint } from "@/lib/practice-together/fingerprint";
import { dump, practiceSong, Room, type Player } from "@/test/shared-edit";

/** A host and `guests` guests on copies of the practice song. */
function room(guests = 1) {
  const r = new Room();
  const host = r.join("host", practiceSong());
  const others = Array.from({ length: guests }, (_, i) => r.join(`guest${i + 1}`, practiceSong()));
  return { r, host, guest: others[0]!, others };
}

async function expectSame(players: Player[]) {
  const [first, ...rest] = players;
  const key = (await scoreFingerprint(first!.editor.score)).key;
  for (const other of rest) {
    expect(dump(other)).toEqual(dump(first!));
    expect((await scoreFingerprint(other.editor.score)).key).toBe(key);
  }
}

const beats = (p: Player, bar = 0, voice = 0, track = 0) =>
  p.editor.score.tracks[track]!.staves[0]!.bars[bar]!.voices[voice]!.beats;

describe("shared editing: operations", () => {
  it("starts with the same ids on both sides", () => {
    const { host, guest } = room();
    expect(dump(guest)).toEqual(dump(host));
  });

  it("sends a note edit as a small set of operations and the other side shows it", async () => {
    const { r, host, guest } = room();
    host.editor.setFret(7);
    expect(r.log).toHaveLength(1);
    expect(JSON.stringify(r.log[0]!.ops).length).toBeLessThan(2000);
    r.settle();
    await expectSame([host, guest]);
    expect(beats(guest)[0]!.notes.some((n) => n.fret === 7)).toBe(true);
  });

  it("a guest's edit reaches the host and the other guests", async () => {
    const { r, host, others } = room(2);
    others[0]!.editor.setFret(9);
    r.settle();
    await expectSame([host, ...others]);
    expect(beats(host)[0]!.notes.some((n) => n.fret === 9)).toBe(true);
  });

  it("two players edit the same bar at the same time and keep both edits", async () => {
    const { r, host, guest } = room();
    // Host: beat 1. Guest: beat 2 of the same bar. Neither has seen the other's edit yet.
    host.editor.setCursorTo({ bar: 0, beat: 0 });
    guest.editor.setCursorTo({ bar: 0, beat: 1 });
    host.editor.setFret(3);
    guest.editor.setFret(5);
    r.settle();
    await expectSame([host, guest]);
    expect(beats(host)[0]!.notes.some((n) => n.fret === 3)).toBe(true);
    expect(beats(host)[1]!.notes.some((n) => n.fret === 5)).toBe(true);
  });

  it("two players edit different notes of the same beat and keep both", async () => {
    const { r, host, guest } = room();
    host.editor.setCursorTo({ bar: 0, beat: 0 });
    guest.editor.setCursorTo({ bar: 0, beat: 0 });
    host.editor.moveString(-1);
    guest.editor.moveString(1);
    host.editor.setFret(2);
    guest.editor.setFret(4);
    r.settle();
    await expectSame([host, guest]);
    const frets = beats(host)[0]!.notes.map((n) => n.fret);
    expect(frets).toEqual(expect.arrayContaining([2, 4]));
  });

  it("two players change the same note: the host's order wins on both", async () => {
    const { r, host, guest } = room();
    host.editor.setCursorTo({ bar: 0, beat: 0 });
    guest.editor.setCursorTo({ bar: 0, beat: 0 });
    host.editor.setFret(2);
    r.settle();
    host.editor.setFret(3);
    guest.editor.setFret(8);
    r.settle();
    await expectSame([host, guest]);
  });

  it("inserting and deleting bars while the other edits inside them", async () => {
    const { r, host, guest } = room();
    host.editor.setCursorTo({ bar: 1, beat: 0 });
    guest.editor.setCursorTo({ bar: 1, beat: 0 });
    host.editor.insertBar("after");
    guest.editor.setFret(6);
    r.settle();
    await expectSame([host, guest]);
    expect(r.resets).toEqual([]);
  });

  it("an edit to a bar the other player deleted is dropped, and both agree", async () => {
    const { r, host, guest } = room();
    guest.editor.setCursorTo({ bar: 2, beat: 0 });
    host.editor.setCursorTo({ bar: 2, beat: 0 });
    host.editor.deleteBar();
    guest.editor.setFret(4);
    r.settle();
    await expectSame([host, guest]);
  });

  it("converges with three players and slow, interleaved delivery", async () => {
    const { r, host, others } = room(2);
    const [a, b] = others as [Player, Player];
    for (let round = 0; round < 4; round++) {
      host.editor.setCursorTo({ bar: round % 3, beat: 0 });
      a.editor.setCursorTo({ bar: (round + 1) % 3, beat: 0 });
      b.editor.setCursorTo({ bar: (round + 2) % 3, beat: 1 });
      host.editor.setFret(round + 1);
      a.editor.setFret(round + 2);
      b.editor.setFret(round + 3);
      r.arrive();
      if (round % 2 === 0) r.deliver();
    }
    r.settle();
    await expectSame([host, a, b]);
    expect(r.resets).toEqual([]);
  });
});

describe("shared editing: undo and redo", () => {
  it("undo only takes back your own edits", async () => {
    const { r, host, guest } = room();
    host.editor.setCursorTo({ bar: 0, beat: 0 });
    guest.editor.setCursorTo({ bar: 0, beat: 1 });
    host.editor.setFret(3);
    guest.editor.setFret(5);
    r.settle();
    host.editor.undo();
    r.settle();
    await expectSame([host, guest]);
    expect(beats(host)[0]!.notes.some((n) => n.fret === 3)).toBe(false);
    expect(beats(host)[1]!.notes.some((n) => n.fret === 5)).toBe(true);
    expect(guest.editor.canUndo).toBe(true);
    expect(host.editor.canUndo).toBe(false);
  });

  it("redo puts your edit back", async () => {
    const { r, host, guest } = room();
    host.editor.setFret(3);
    r.settle();
    host.editor.undo();
    r.settle();
    host.editor.redo();
    r.settle();
    await expectSame([host, guest]);
    expect(beats(guest)[0]!.notes.some((n) => n.fret === 3)).toBe(true);
  });

  it("a guest undoes their own bar insert while the host keeps editing", async () => {
    const { r, host, guest } = room();
    guest.editor.setCursorTo({ bar: 1, beat: 0 });
    guest.editor.insertBar("after");
    r.settle();
    host.editor.setCursorTo({ bar: 0, beat: 0 });
    host.editor.setFret(4);
    r.settle();
    guest.editor.undo();
    r.settle();
    await expectSame([host, guest]);
    expect(host.editor.score.masterBars).toHaveLength(practiceSong().masterBars.length);
    expect(beats(host)[0]!.notes.some((n) => n.fret === 4)).toBe(true);
  });
});

describe("shared editing: cursors follow the beats they were on", () => {
  it("a bar inserted before the cursor moves the cursor along", () => {
    const { r, host, guest } = room();
    guest.editor.setCursorTo({ bar: 2, beat: 0 });
    host.editor.setCursorTo({ bar: 0, beat: 0 });
    host.editor.insertBar("after");
    r.settle();
    expect(guest.editor.cursor.bar).toBe(3);
  });
});
