import { model } from "@coderline/alphatab";

import { NO_VALUE } from "@/lib/score/no-value";
import { assignProps, changedProps, checkProps, encodeProps } from "@/lib/score/ops/codec";
import type { Props } from "@/lib/score/ops/types";
import { practiceSong } from "@/test/shared-edit";

const UNDEFINED = { $u: 1 };

/** What a peer's JSON arrives as: parsed text, so `__proto__` is an own key. */
const wire = (props: unknown): Props => JSON.parse(JSON.stringify(props)) as Props;

describe("score ops codec: what a peer may set", () => {
  it("refuses a method of the part, so the part keeps working", () => {
    expect(() => checkProps("beat", { finish: UNDEFINED })).toThrow();
    expect(() => checkProps("beat", { addNote: 1 })).toThrow();
    expect(() => checkProps("note", { clone: { $u: 1 } })).toThrow();
    expect(() => checkProps("mbar", { addTempoAutomation: 0 })).toThrow();
    expect(() => checkProps("track", { ensureStaveCount: null })).toThrow();
  });

  it("refuses a method name or an unknown name for every kind", () => {
    for (const kind of ["track", "staff", "mbar", "bar", "voice", "beat", "note"] as const) {
      expect(() => checkProps(kind, { toString: UNDEFINED })).toThrow();
      expect(() => checkProps(kind, { hasOwnProperty: 1 })).toThrow();
      expect(() => checkProps(kind, { notAFieldOfAnything: 1 })).toThrow();
    }
  });

  it("leaves out links, lists of parts and derived values instead of writing them", () => {
    const beat = new model.Beat();
    const before = { ...beat };
    const props = { voice: 1, notes: 1, id: 99, index: 7, nextBeat: 1, displayStart: 5 };
    expect(() => checkProps("beat", props)).not.toThrow();
    assignProps(beat, props);
    expect({ ...beat }).toEqual(before);
  });

  it("refuses a value of the wrong type for a plain field", () => {
    expect(() => checkProps("note", { fret: "7" })).toThrow();
    expect(() => checkProps("note", { fret: UNDEFINED })).toThrow();
    expect(() => checkProps("note", { fret: null })).toThrow();
    expect(() => checkProps("note", { isDead: 1 })).toThrow();
    expect(() => checkProps("track", { name: 5 })).toThrow();
    expect(() => checkProps("beat", { automations: { $c: "Object", p: {} } })).toThrow();
    expect(() => checkProps("staff", { stringTuning: [1, 2] })).toThrow();
  });

  it("accepts ordinary data fields of the right type", () => {
    expect(() => checkProps("note", { fret: 7, isDead: true, string: 2 })).not.toThrow();
    expect(() => checkProps("note", { fret: { $n: "NaN" } })).not.toThrow();
    expect(() => checkProps("track", { name: "Bass", smartBeatLyrics: null })).not.toThrow();
    expect(() => checkProps("beat", { text: "hello", lyrics: ["a"] })).not.toThrow();
  });

  it("checks nothing is written when one property of the batch is refused", () => {
    const note = new model.Note();
    expect(() => checkProps("note", { fret: 3, finish: UNDEFINED })).toThrow();
    expect(note.fret).toBe(NO_VALUE);
  });

  it("refuses a method name inside a nested object, whatever its class", () => {
    expect(() =>
      checkProps("beat", { text: { $c: "Object", p: { toString: { $u: 1 } } } }),
    ).toThrow();
    expect(() =>
      checkProps("track", { playbackInfo: { $c: "PlaybackInformation", p: { constructor: 1 } } }),
    ).toThrow();
    const color = new model.Color(1, 2, 3, 4);
    const method = Object.getOwnPropertyNames(Object.getPrototypeOf(color) as object).find(
      (name) => name !== "constructor" && typeof (color as never)[name] === "function",
    );
    if (method) {
      expect(() =>
        checkProps("track", { color: { $c: "Color", p: { [method]: { $u: 1 } } } }),
      ).toThrow();
    }
  });
});

describe("score ops codec: hostile encodings", () => {
  it("refuses __proto__, constructor and prototype keys at any depth", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(() => checkProps("beat", wire({ [key]: 1 }))).toThrow();
      expect(() =>
        checkProps("beat", wire({ text: { $c: "Object", p: { [key]: { x: 1 } } } })),
      ).toThrow();
      expect(() => checkProps("beat", wire({ lyrics: [{ $m: [["k", { [key]: 1 }]] }] }))).toThrow();
    }
    const polluted = JSON.parse('{"text":{"$c":"Object","p":{"__proto__":{"polluted":1}}}}');
    expect(() => assignProps(new model.Beat(), polluted as Props)).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("does not instantiate classes it should not", () => {
    expect(() => checkProps("beat", { text: { $c: "Beat", p: {} } })).toThrow();
    expect(() => checkProps("beat", { text: { $c: "Track", p: {} } })).toThrow();
    expect(() => checkProps("beat", { text: { $c: "NotAClass", p: {} } })).toThrow();
    expect(() => checkProps("beat", { text: { $c: "Function", p: {} } })).toThrow();
    expect(() => checkProps("beat", { text: { $c: "Object", p: "x" } })).toThrow();
    expect(() => checkProps("beat", { text: { $c: "Object", p: null } })).toThrow();
  });

  it("refuses a value nested too deep", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = [deep];
    expect(() => checkProps("beat", { text: deep })).toThrow();
  });

  it("refuses malformed maps and sets", () => {
    expect(() => checkProps("beat", { text: { $m: "x" } })).toThrow();
    expect(() => checkProps("beat", { text: { $m: [[1]] } })).toThrow();
    expect(() => checkProps("beat", { text: { $s: 5 } })).toThrow();
  });

  it("round-trips numbers that JSON cannot carry, undefined, maps and sets", () => {
    const source = new model.Beat();
    const holder = source as unknown as Record<string, unknown>;
    holder.text = new Map<string, unknown>([
      ["nan", Number.NaN],
      ["inf", Number.POSITIVE_INFINITY],
      ["ninf", Number.NEGATIVE_INFINITY],
      ["gone", undefined],
    ]);
    holder.lyrics = new Set([1, 2, 3]);
    const props = wire(encodeProps(source));
    checkProps("beat", props);
    const target = new model.Beat();
    assignProps(target, props);
    const text = (target as unknown as { text: Map<string, unknown> }).text;
    expect(text.get("nan")).toBeNaN();
    expect(text.get("inf")).toBe(Number.POSITIVE_INFINITY);
    expect(text.get("ninf")).toBe(Number.NEGATIVE_INFINITY);
    expect(text.has("gone")).toBe(true);
    expect(text.get("gone")).toBeUndefined();
    expect([...(target as unknown as { lyrics: Set<number> }).lyrics]).toEqual([1, 2, 3]);
  });

  it("every property the encoder emits for the practice song is accepted", () => {
    const score = practiceSong();
    const parts: [Parameters<typeof checkProps>[0], object][] = [];
    for (const masterBar of score.masterBars) parts.push(["mbar", masterBar]);
    for (const track of score.tracks) {
      parts.push(["track", track]);
      for (const staff of track.staves) {
        parts.push(["staff", staff]);
        for (const bar of staff.bars) {
          parts.push(["bar", bar]);
          for (const voice of bar.voices) {
            parts.push(["voice", voice]);
            for (const beat of voice.beats) {
              parts.push(["beat", beat]);
              for (const note of beat.notes) parts.push(["note", note]);
            }
          }
        }
      }
    }
    for (const [kind, part] of parts) {
      expect(() => checkProps(kind, wire(encodeProps(part))), kind).not.toThrow();
    }
  });
});

describe("score ops codec: no value (alphaTab 1.9 NaN, 1.8 -1)", () => {
  const FIELDS = ["fret", "string", "octave", "tone", "percussionArticulation"] as const;

  it("writes -1 for a note's empty fields, which an app on alphaTab 1.8 understands", () => {
    const props = wire(encodeProps(new model.Note()));
    for (const key of FIELDS) expect(props[key]).toBe(-1);
    const note = new model.Note();
    note.fret = 5;
    note.string = 2;
    expect(wire(encodeProps(note))).toMatchObject({ fret: 5, string: 2, octave: -1 });
  });

  it("reads the -1 of an older app as no value, so the note is not stringed", () => {
    const note = new model.Note();
    note.fret = 3;
    note.string = 2;
    assignProps(
      note,
      wire({ fret: -1, string: -1, octave: -1, tone: -1, percussionArticulation: 4 }),
    );
    expect(note.fret).toBeNaN();
    expect(note.string).toBeNaN();
    expect(note.octave).toBeNaN();
    expect(note.tone).toBeNaN();
    expect(note.percussionArticulation).toBe(4);
    expect(note.isStringed).toBe(false);
    expect(note.isPercussion).toBe(true);
  });

  it("reads NaN from an app on alphaTab 1.9 the same way", () => {
    const note = new model.Note();
    note.fret = 3;
    assignProps(note, wire({ fret: { $n: "NaN" } }));
    expect(note.fret).toBe(NO_VALUE);
  });

  it("does not turn a real number or another kind of part's -1 into no value", () => {
    const note = new model.Note();
    assignProps(note, wire({ fret: 0, string: 6 }));
    expect([note.fret, note.string]).toEqual([0, 6]);
    const beat = new model.Beat();
    assignProps(beat, wire({ restDisplayTone: -1 }));
    expect(beat.restDisplayTone).toBe(-1);
  });

  it("a change to no value and back is a change on the wire", () => {
    const note = new model.Note();
    note.fret = 3;
    const before = encodeProps(note);
    note.fret = NO_VALUE;
    expect(changedProps(before, encodeProps(note))).toEqual({ fret: -1 });
  });
});

describe("score ops codec: other versions of alphaTab", () => {
  it("leaves out what alphaTab computes, and the properties 1.9 added while they are at their default", () => {
    const bar = new model.MasterBar();
    expect(Object.keys(encodeProps(bar))).not.toContain("_realBarNumber");
    for (const key of ["customBarNumber", "customBarNumberText", "anacrusisOffset"]) {
      expect(Object.keys(encodeProps(bar))).not.toContain(key);
    }
    const beat = new model.Beat();
    expect(Object.keys(encodeProps(beat))).not.toContain("restDisplayTone");
    beat.restDisplayTone = 4;
    expect(wire(encodeProps(beat)).restDisplayTone).toBe(4);
  });

  it("says a 1.9 property is back at its default instead of dropping it", () => {
    const beat = new model.Beat();
    const before = encodeProps(beat);
    beat.restDisplayTone = 4;
    const during = encodeProps(beat);
    expect(changedProps(before, during)).toEqual({ restDisplayTone: 4 });
    beat.restDisplayTone = Number.NaN;
    expect(changedProps(during, encodeProps(beat))).toEqual({ restDisplayTone: { $n: "NaN" } });
  });

  it("reads the bar number setting an app on alphaTab 1.8 sent, and ignores an empty one", () => {
    const bar = new model.Bar();
    expect(() => checkProps("bar", wire({ barNumberDisplay: UNDEFINED }))).not.toThrow();
    expect(() => checkProps("bar", wire({ barNumberDisplay: "x" }))).toThrow();
    assignProps(bar, wire({ barNumberDisplay: UNDEFINED }));
    expect(bar.scoreDisplay).toBeUndefined();
    assignProps(bar, wire({ barNumberDisplay: 2 }));
    expect(bar.scoreDisplay?.barNumber).toBe(2);
    expect(bar.tabDisplay?.barNumber).toBe(2);
  });
});
