import { model } from "@coderline/alphatab";

import { ScoreEditor } from "@/lib/score/editor";
import { applyOps } from "@/lib/score/ops/apply";
import { assignProps, changedProps, checkProps, encodeProps } from "@/lib/score/ops/codec";
import { IdRegistry } from "@/lib/score/ops/ids";
import type { Op } from "@/lib/score/ops/types";
import { validOps } from "@/lib/score/ops/validate";
import { refinish } from "@/lib/score/model";
import { createTrack, insertTrack, trackFromPreset } from "@/lib/score/tracks";
import { getPreset } from "@/lib/score/music";
import { dump, practiceSong, Room } from "@/test/shared-edit";

const NOTE = "m0:t0.s0.v0.b0";

describe("ops: what another computer sends is checked", () => {
  it("accepts operations the editor makes", () => {
    const room = new Room();
    const host = room.join("host", practiceSong());
    room.join("guest", practiceSong());
    host.editor.setFret(5);
    host.editor.insertBar("after");
    for (const entry of room.log) expect(validOps(entry.ops)).not.toBeNull();
  });

  it("refuses malformed operations", () => {
    const node = { u: "n1", k: "note", p: {} };
    const bad: unknown[] = [
      "x",
      [null],
      [{ t: "nope" }],
      [{ t: "set", u: "a" }],
      [{ t: "set", u: "a", d: [] }],
      [{ t: "set", u: "", d: {} }],
      [{ t: "del" }],
      [{ t: "ins", k: "beat", p: NOTE, a: null }],
      [{ t: "ins", k: "beat", p: NOTE, a: null, d: { ...node, k: "note" } }],
      [{ t: "ins", k: "note", p: null, a: null, d: node }],
      [{ t: "ins", k: "mbar", p: NOTE, a: null, d: { u: "m", k: "mbar", p: {} } }],
      [{ t: "ins", k: "note", p: NOTE, a: 3, d: node }],
      // A beat inside a track, a note with children, a bar line that holds a beat:
      [
        {
          t: "ins",
          k: "track",
          p: null,
          a: null,
          d: { u: "t", k: "track", p: {}, c: [{ u: "b", k: "beat", p: {} }] },
        },
      ],
      [{ t: "ins", k: "note", p: NOTE, a: null, d: { ...node, c: [node] } }],
      [
        {
          t: "ins",
          k: "mbar",
          p: null,
          a: null,
          d: { u: "m", k: "mbar", p: {}, c: [{ u: "b", k: "beat", p: {} }] },
        },
      ],
      [{ t: "set", u: "a", d: JSON.parse('{"__proto__": {"x": 1}}') }],
      [{ t: "set", u: "a", d: { v: deep(60) } }],
      Array.from({ length: 4001 }, () => ({ t: "del", u: "a" })),
    ];
    for (const ops of bad) expect(validOps(ops)).toBeNull();
  });

  it("an operation that cannot be written changes nothing", () => {
    const score = practiceSong();
    const ids = new IdRegistry("p");
    ids.init(score);
    const before = JSON.stringify(dumpOf(score, ids));
    const ops: Op[] = [
      { t: "set", u: NOTE, d: { dots: 1 } },
      { t: "set", u: NOTE, d: { duration: { $c: "Score", p: {} } } },
    ];
    expect(() => applyOps(ids, score, ops)).toThrow();
    expect(JSON.stringify(dumpOf(score, ids))).toBe(before);
  });
});

describe("ops: an id leads to one part", () => {
  const VOICE = "m0:t0.s0.v0";
  const beatOp = (u: string, p = VOICE): Op => ({
    t: "ins",
    k: "beat",
    p,
    a: null,
    d: { u, k: "beat", p: {} },
  });

  it("lets an id be used again by another kind once its part was deleted in the batch", () => {
    const score = practiceSong();
    const ids = new IdRegistry("p");
    ids.init(score);
    const voice = ids.get(VOICE) as model.Voice;
    const beats = voice.beats.length;

    applyOps(ids, score, [{ t: "del", u: NOTE + ".n0" }, beatOp(NOTE + ".n0")]);

    expect(ids.get(NOTE + ".n0")).toBeInstanceOf(model.Beat);
    expect(voice.beats.length).toBe(beats + 1);
  });

  it("moves a part that is inserted again, even from another voice, and keeps one id", () => {
    const score = practiceSong();
    const ids = new IdRegistry("p");
    ids.init(score);
    const voice = ids.get(VOICE) as model.Voice;
    const beat = ids.get(NOTE) as model.Beat;
    const other = new model.Voice();
    other.bar = voice.bar;
    voice.bar.voices.push(other);
    ids.adopt(other, "m0:t0.s0.v1");
    const total = voice.beats.length;

    applyOps(ids, score, [beatOp(NOTE, "m0:t0.s0.v1")]);

    expect(voice.beats.length).toBe(total - 1);
    expect(other.beats.length).toBe(1);
    expect(ids.get(NOTE)).toBe(other.beats[0]);
    expect(ids.get(NOTE)).not.toBe(beat);
  });

  it("refuses an id that a part of another kind carries, before anything changes", () => {
    const score = practiceSong();
    const ids = new IdRegistry("p");
    ids.init(score);
    const before = JSON.stringify(dumpOf(score, ids));
    const ops: Op[] = [
      { t: "set", u: NOTE, d: { dots: 1 } },
      beatOp(NOTE + ".n0"),
      { t: "set", u: NOTE + ".n0", d: { fret: 3 } },
    ];

    expect(() => applyOps(ids, score, ops)).toThrow();

    expect(JSON.stringify(dumpOf(score, ids))).toBe(before);
    expect(ids.get(NOTE + ".n0")).toBeInstanceOf(model.Note);
  });
});

function deep(levels: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < levels; i += 1) value = [value];
  return value;
}

function dumpOf(score: ReturnType<typeof practiceSong>, ids: IdRegistry) {
  return score.tracks.map((track) =>
    track.staves.map((staff) =>
      staff.bars.map((bar) =>
        bar.voices.map((voice) => voice.beats.map((b) => [ids.uid(b), b.dots])),
      ),
    ),
  );
}

describe("ops: the codec refuses what would change other parts", () => {
  it("does not let a property reach the prototype or change the type of an object", () => {
    const note = new model.Note();
    const hostile = JSON.parse('{"__proto__": {"$c": "Object", "p": {"polluted": true}}}');
    expect(() => assignProps(note, hostile)).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((new model.Note() as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(note)).toBe(model.Note.prototype);
    expect(() =>
      checkProps("note", JSON.parse('{"text": {"$c": "Object", "p": {"__proto__": {}}}}')),
    ).toThrow();
  });

  it("does not take links, lists of parts or derived values from the network", () => {
    const note = new model.Note();
    const beat = new model.Beat();
    note.beat = beat;
    assignProps(note, { beat: { $u: 1 }, id: 99, index: 7, tieOrigin: null, fret: 4 });
    expect(note.beat).toBe(beat);
    expect(note.fret).toBe(4);
    expect(note.index).not.toBe(7);
    const parent = new model.Beat();
    assignProps(parent, { notes: { $u: 1 } });
    expect(Array.isArray(parent.notes)).toBe(true);
  });

  it("does not instantiate a part of the score from a property", () => {
    expect(() => checkProps("beat", { text: { $c: "Track", p: {} } })).toThrow();
    expect(() => checkProps("beat", { text: { $c: "NotAClass", p: {} } })).toThrow();
    expect(() => checkProps("beat", { text: { $m: "nope" } })).toThrow();
    expect(() => checkProps("beat", { text: deep(60) as never })).toThrow();
  });

  it("round-trips the special values", () => {
    const note = new model.Beat();
    const source = new model.Beat();
    Object.assign(source, {
      lyrics: [NaN, Infinity, -Infinity],
      text: undefined,
      chordId: new Set([1, 2]),
    });
    assignProps(note, encodeProps(source));
    const copy = note as unknown as Record<string, unknown>;
    expect(copy.lyrics).toEqual([NaN, Infinity, -Infinity]);
    expect(copy.chordId).toEqual(new Set([1, 2]));
    expect("text" in copy).toBe(true);
  });

  it("tells null from undefined", () => {
    expect(changedProps({ a: null }, {})).toEqual({ a: { $u: 1 } });
    expect(changedProps({}, { a: null })).toEqual({ a: null });
    expect(changedProps({ a: null }, { a: null })).toBeNull();
  });
});

describe("ops: placeholders and undo anchors", () => {
  it("a track and a bar line added at the same time leave the same parts everywhere, and edits in them land", async () => {
    const room = new Room();
    const host = room.join("host", practiceSong());
    const a = room.join("a", practiceSong());
    const b = room.join("b", practiceSong());
    a.editor.run(
      "Add track",
      () => a.editor.structureTargets(),
      () =>
        insertTrack(
          a.editor.score,
          createTrack(a.editor.score, trackFromPreset(getPreset("drums")!)),
        ),
    );
    b.editor.setCursorTo({ bar: 1, beat: 0 });
    b.editor.insertBar("after");
    room.settle();
    expect(room.resets).toEqual([]);
    expect(dump(a)).toEqual(dump(host));
    expect(dump(b)).toEqual(dump(host));

    // Someone writes into the new track's bar that every computer had to make for itself.
    const last = host.editor.score.tracks.length - 1;
    host.editor.setTrack(last);
    host.editor.setCursorTo({ bar: 2, beat: 0 });
    host.editor.toggleDrum(36);
    room.settle();
    expect(room.resets).toEqual([]);
    expect(dump(a)).toEqual(dump(host));
    expect(dump(b)).toEqual(dump(host));
    expect(JSON.stringify(dump(b))).toContain("percussionArticulation");
  });

  it("when two players delete the last bars at once, an edit in the stand-in bar lands everywhere", () => {
    const room = new Room();
    const host = room.join("host", practiceSong());
    const a = room.join("a", practiceSong());
    const bars = host.editor.score.masterBars.length;
    for (let i = 0; i < bars - 1; i += 1) host.editor.deleteBar(0);
    room.settle();
    // Both delete the one bar left, each seeing it as theirs to delete.
    a.editor.deleteBar(0);
    room.settle();
    expect(dump(a)).toEqual(dump(host));
  });

  it("an undo whose neighbour another player deleted puts the bar back in its place", () => {
    const room = new Room();
    const host = room.join("host", practiceSong());
    const guest = room.join("guest", practiceSong());
    const ids = (p: typeof host) => p.editor.score.masterBars.map((m) => p.sync.ids.uid(m));
    const original = ids(host);
    // The guest deletes bar 3; the host deletes bar 2, which was in front of it; the guest undoes.
    guest.editor.deleteBar(2);
    room.settle();
    host.editor.deleteBar(1);
    room.settle();
    guest.editor.undo();
    room.settle();
    expect(dump(guest)).toEqual(dump(host));
    // Bar 3 is back in front of bar 4, not after it.
    expect(ids(host)).toEqual([original[0], original[2], original[3]]);
  });
});

describe("the editor in a session", () => {
  it("does not rewind other players' edits when the session ends", () => {
    const room = new Room();
    const host = room.join("host", practiceSong());
    const guest = room.join("guest", practiceSong());
    host.editor.setCursorTo({ bar: 1, beat: 0 });
    host.editor.setFret(3);
    room.settle();
    guest.editor.setCursorTo({ bar: 1, beat: 1 });
    guest.editor.setFret(9);
    room.settle();
    const edited = JSON.stringify(dump(host));
    // The session ends: the host's old history is gone, so Undo cannot rewind the bar.
    host.sync.detach();
    expect(host.editor.canUndo).toBe(false);
    host.editor.undo();
    expect(JSON.stringify(dump(host))).toBe(edited);
    // And it still shows the unsaved changes.
    expect(host.editor.edited).toBe(true);
  });

  it("ordinary undo starts fresh after a session begins and again after it ends", () => {
    const score = practiceSong();
    const editor = new ScoreEditor(score);
    editor.setFret(4);
    expect(editor.canUndo).toBe(true);
    const room = new Room();
    const host = room.join("host", score);
    expect(host.editor.canUndo).toBe(false);
    host.editor.setFret(6);
    expect(host.editor.canUndo).toBe(true);
    host.sync.detach();
    expect(host.editor.canUndo).toBe(false);
    host.editor.setFret(2);
    host.editor.undo();
    expect(host.editor.canUndo).toBe(false);
  });

  it("is clean again after undoing back to the saved state, and a replayed join is not an edit", () => {
    const room = new Room();
    const host = room.join("host", practiceSong());
    const guest = room.join("guest", practiceSong());
    host.editor.markSaved();
    expect(host.editor.edited).toBe(false);
    host.editor.setFret(5);
    expect(host.editor.edited).toBe(true);
    host.editor.undo();
    expect(host.editor.edited).toBe(false);
    host.editor.redo();
    expect(host.editor.edited).toBe(true);
    host.editor.markSaved();
    expect(host.editor.edited).toBe(false);
    // The guest got the edit over the wire: its tab differs from the file, so it counts.
    room.settle();
    expect(guest.editor.edited).toBe(true);

    // A guest that is only getting the tab (edits replayed before it is live) is not edited.
    const late = new ScoreEditor(practiceSong());
    late.applyRemote(() => {});
    expect(late.edited).toBe(false);
  });
});

void refinish;
