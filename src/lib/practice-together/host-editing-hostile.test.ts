import { scoreFingerprint } from "@/lib/practice-together/fingerprint";
import type { EditBody } from "@/lib/practice-together/protocol";
import { HostEditing, type HostLink } from "@/lib/practice-together/shared-editing";
import { ScoreEditor } from "@/lib/score/editor";
import { kindOf } from "@/lib/score/ops/fields";
import { subtree } from "@/lib/score/ops/ids";
import { practiceSong } from "@/test/shared-edit";

const BEAT = "m0:t0.s0.v0.b0";
const NOTE = "m0:t0.s0.v0.b0.n0";
const VOICE = "m0:t0.s0.v0";
const newBeat = (u: string, c?: unknown[]) => ({ u, k: "beat", p: {}, ...(c ? { c } : {}) });
const newNote = (u: string) => ({ u, k: "note", p: {} });
const insBeat = (node: unknown) => ({ t: "ins", k: "beat", p: VOICE, a: null, d: node });
const UNDEFINED = { $u: 1 };

/** A host with one admitted guest that has the tab and may edit. */
function hostWithGuest() {
  const editor = new ScoreEditor(practiceSong());
  const sent: EditBody[] = [];
  const reshared: string[] = [];
  const link: HostLink = {
    seats: () => [{ id: "g1", name: "Guest" }],
    send: (_seat, body) => void sent.push(body),
    setLive: () => undefined,
    shareTab: (seat) => void reshared.push(seat),
  };
  const host = new HostEditing(editor, link, { name: "Host", currentKey: async () => "key" });
  host.receive("g1", { k: "since", seq: host.snapshot().seq, key: "key" });
  sent.length = 0;
  return { editor, host, sent, reshared };
}

const keyOf = async (editor: ScoreEditor) => (await scoreFingerprint(editor.score)).key;
/** Every part with the id it carries, its kind, and whether the id leads back to it. */
function registryOf(editor: ScoreEditor, host: HostEditing) {
  const { ids } = host.sync;
  const { score } = editor;
  const parts = [...score.masterBars, ...score.tracks.flatMap((track) => [...subtree(track)])];
  const known = parts.map((part) => {
    const uid = ids.uid(part);
    return [uid, kindOf(part), ids.get(uid) === part];
  });
  return { known, probes: [NOTE, BEAT, "x1", "x2"].map((uid) => kindOf(ids.get(uid)) ?? null) };
}

const ops = (...list: unknown[]): EditBody => ({ k: "ops", ops: list as never });
const wire = (text: string): unknown => JSON.parse(text);

/** One hostile batch per case: each must be refused whole and leave the host's tab as it was. */
const HOSTILE: [string, EditBody][] = [
  ["a method shadowed by undefined", ops({ t: "set", u: BEAT, d: { finish: UNDEFINED } })],
  ["a method shadowed by a number", ops({ t: "set", u: BEAT, d: { addNote: 1 } })],
  ["a method of a note", ops({ t: "set", u: NOTE, d: { clone: null } })],
  ["a name that is no field", ops({ t: "set", u: BEAT, d: { somethingElse: 1 } })],
  ["a text where a number belongs", ops({ t: "set", u: NOTE, d: { fret: "7" } })],
  ["undefined where a number belongs", ops({ t: "set", u: NOTE, d: { fret: UNDEFINED } })],
  [
    "an object where a flag belongs",
    ops({ t: "set", u: NOTE, d: { isDead: { $c: "Object", p: {} } } }),
  ],
  [
    "a nested object hiding a method",
    ops({ t: "set", u: BEAT, d: { text: { $c: "Object", p: { toString: 1 } } } }),
  ],
  ["an object nobody tagged", ops({ t: "set", u: BEAT, d: { text: { toString: 1 } } })],
  ["a prototype key", ops(wire('{"t":"set","u":"' + BEAT + '","d":{"__proto__":{"x":1}}}'))],
  [
    "a nested prototype key",
    ops(wire('{"t":"set","u":"' + BEAT + '","d":{"text":{"$c":"Object","p":{"__proto__":{}}}}}')),
  ],
  [
    "a part of the score as a value",
    ops({ t: "set", u: BEAT, d: { text: { $c: "Beat", p: {} } } }),
  ],
  ["an unknown class", ops({ t: "set", u: BEAT, d: { text: { $c: "Function", p: {} } } })],
  [
    "a method named inside a new beat",
    ops({
      t: "ins",
      k: "beat",
      p: "m0:t0.s0.v0",
      a: null,
      d: { u: "x1", k: "beat", p: { finish: UNDEFINED } },
    }),
  ],
  [
    "a bad edit after a good one",
    ops({ t: "set", u: NOTE, d: { fret: 3 } }, { t: "set", u: BEAT, d: { finish: UNDEFINED } }),
  ],
  [
    "a bad edit on a beat made earlier in the batch",
    ops(
      { t: "ins", k: "beat", p: "m0:t0.s0.v0", a: null, d: { u: "x2", k: "beat", p: {} } },
      { t: "set", u: "x2", d: { finish: UNDEFINED } },
    ),
  ],
  [
    "a beat that takes the id of a note, then a fret set on that id",
    ops(insBeat(newBeat(NOTE)), { t: "set", u: NOTE, d: { fret: 3 } }),
  ],
  ["a beat that takes the id of a note", ops(insBeat(newBeat(NOTE)))],
  ["a beat that takes the id of a track", ops(insBeat(newBeat("t0")))],
  [
    "a note inside a new beat with the id of another note",
    ops(insBeat(newBeat("x1", [newNote(NOTE)]))),
  ],
  ["a note inside a new beat with the id of a beat", ops(insBeat(newBeat("x1", [newNote(BEAT)])))],
  [
    "two notes of a new beat with one id",
    ops(insBeat(newBeat("x1", [newNote("x2"), newNote("x2")]))),
  ],
  ["a note with the id of the beat that holds it", ops(insBeat(newBeat("x1", [newNote("x1")])))],
  [
    "a beat made twice as different kinds in one batch",
    ops(insBeat(newBeat("x1")), {
      t: "ins",
      k: "note",
      p: BEAT,
      a: null,
      d: newNote("x1"),
    }),
  ],
  [
    "a fret on an id that a note was deleted from and a beat took over",
    ops({ t: "del", u: NOTE }, insBeat(newBeat(NOTE)), { t: "set", u: NOTE, d: { fret: 3 } }),
  ],
  [
    "a beat put where a voice is wanted",
    ops({ t: "ins", k: "beat", p: BEAT, a: null, d: newBeat("x1") }),
  ],
  [
    "more operations than a batch may hold",
    ops(...Array.from({ length: 4001 }, () => ({ t: "reset" }))),
  ],
  [
    "a value nested far too deep",
    ops({
      t: "set",
      u: BEAT,
      d: { text: Array.from({ length: 80 }).reduce<unknown>((v) => [v], 1) },
    }),
  ],
  ["no target", ops({ t: "set", d: {} })],
  ["an operation that is no object", ops(5)],
];

describe("the host does not trust what a guest sends", () => {
  it.each(HOSTILE)(
    "refuses %s, leaves the tab unchanged and hands the guest the tab",
    async (_, body) => {
      const { editor, host, sent, reshared } = hostWithGuest();
      const before = await keyOf(editor);
      const registry = registryOf(editor, host);

      expect(() => host.receive("g1", body)).not.toThrow();

      expect(await keyOf(editor)).toBe(before);
      expect(registryOf(editor, host)).toEqual(registry);
      expect(host.seq).toBe(0);
      expect(sent.some((item) => item.k === "ops")).toBe(false);
      expect(reshared).toContain("g1");
      expect(({} as Record<string, unknown>).x).toBeUndefined();
    },
  );

  it("a refused method shadowing leaves the beat intact, and the host can still edit", async () => {
    const { editor, host } = hostWithGuest();
    editor.setCursorTo({ bar: 0, beat: 0 });
    const beat = editor.cursorBeat()!;

    host.receive("g1", ops({ t: "set", u: BEAT, d: { finish: UNDEFINED } }));

    expect(typeof beat.finish).toBe("function");
    expect(Object.prototype.hasOwnProperty.call(beat, "finish")).toBe(false);
    expect(() => editor.setFret(4)).not.toThrow();
    expect(editor.cursorBeat()!.notes.some((note) => note.fret === 4)).toBe(true);
  });

  it("an edit that is fine is still applied and sent on after a refused one", async () => {
    const { editor, host, sent } = hostWithGuest();
    host.receive("g1", ops({ t: "set", u: BEAT, d: { finish: UNDEFINED } }));
    host.receive("g1", { k: "since", seq: host.snapshot().seq, key: "key" });
    sent.length = 0;

    host.receive("g1", ops({ t: "set", u: NOTE, d: { fret: 12 } }));

    expect(host.seq).toBe(1);
    expect(sent.some((item) => item.k === "ops")).toBe(true);
    const note = editor.score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!;
    expect(note.fret).toBe(12);
  });
});
