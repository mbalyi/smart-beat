import { model } from "@coderline/alphatab";

import { BEAT_EFFECTS, NOTE_EFFECTS, effectOff, type Effect } from "@/lib/score/effects";
import { KEY_SIGNATURES } from "@/lib/score/keys";
import { NOTE_VALUES, TUPLETS, tupletKey, type TrackKind } from "@/lib/score/music";
import {
  PALETTE_SECTIONS,
  allItems,
  boxGroups,
  itemAvailable,
  paletteFor,
  type PaletteAction,
  type PaletteBox,
  type PaletteVisual,
} from "@/lib/score/palette-model";
import { SMUFL } from "@/lib/score/smufl";
import { DIRECTIONS, MAX_ENDINGS, TRIPLET_FEELS } from "@/lib/score/structure";

const KINDS: TrackKind[] = ["stringed", "pitched", "drums"];

const boxes = () =>
  PALETTE_SECTIONS.flatMap((s) =>
    s.rows.flatMap((r) => r.entries.flatMap((e) => ("box" in e ? [e.box] : []))),
  );
const cells = () =>
  PALETTE_SECTIONS.flatMap((s) =>
    s.rows.flatMap((r) => r.entries.flatMap((e) => ("cell" in e ? [e.cell] : []))),
  );

const glyphsOf = (visual: PaletteVisual): string[] =>
  [visual.glyph, visual.sub?.glyph].flatMap((g) => (g === undefined ? [] : [g].flat()));

const effectOf = (action: Extract<PaletteAction, { type: "noteEffect" | "beatEffect" }>) =>
  (action.type === "noteEffect" ? NOTE_EFFECTS : BEAT_EFFECTS)[action.id as never] as Effect;

describe("palette model", () => {
  it("gives every item a unique id, a name and something to draw", () => {
    const items = allItems();
    expect(items.length).toBeGreaterThan(150);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    for (const item of items) {
      expect(item.label.trim(), item.id).not.toBe("");
      const v = item.visual;
      expect(
        v.glyph ?? v.icon ?? v.mark ?? v.text ?? v.digits,
        `${item.id} has nothing to draw`,
      ).toBeDefined();
    }
    expect(new Set([...boxes(), ...cells().map((c) => ({ id: c.id }))].map((b) => b.id)).size).toBe(
      boxes().length + cells().length,
    );
  });

  it("only uses glyphs the SMuFL table has", () => {
    for (const item of allItems()) {
      for (const name of glyphsOf(item.visual)) {
        expect(SMUFL, `${item.id}: ${name}`).toHaveProperty(name);
      }
    }
    for (const b of boxes()) {
      for (const name of b.idle ? glyphsOf(b.idle) : []) expect(SMUFL).toHaveProperty(name);
    }
  });

  it("maps every effect item to an effect of the catalogue and one of its values", () => {
    let count = 0;
    for (const item of allItems()) {
      const { action } = item;
      if (action.type !== "noteEffect" && action.type !== "beatEffect") continue;
      count++;
      const effect = effectOf(action);
      expect(effect, item.id).toBeDefined();
      expect(effect.scope).toBe(action.type === "noteEffect" ? "note" : "beat");
      if (action.value !== undefined) {
        expect(
          effect.choices.map((c) => c.value),
          item.id,
        ).toContain(action.value);
        // Picking the value that is on switches the effect off, so "off" is never an item
        // (except forte: it is how a beat without a marking reads, and stays a button).
        // The trill speed is always set, so it has no "off" either.
        if (item.id !== `beat:dynamics:${model.DynamicValue.F}` && action.id !== "trillSpeed") {
          expect(action.value, item.id).not.toBe(effectOff(effect));
        }
      }
    }
    expect(count).toBeGreaterThan(60);
  });

  it("takes the names of effects from the catalogue", () => {
    for (const item of allItems()) {
      const { action } = item;
      if (action.type !== "noteEffect" && action.type !== "beatEffect") continue;
      const effect = effectOf(action);
      if (action.value === undefined) {
        expect(item.label).toBe(effect.label);
      } else {
        const label = effect.choices.find((c) => c.value === action.value)!.label;
        // Heavy accent, Downstroke... may be reworded, but never lose the catalogue's words.
        expect(item.label.toLowerCase(), item.id).toContain(label.toLowerCase().split(" ")[0]!);
      }
    }
  });

  it("keeps every control of the old palette reachable", () => {
    const has = (match: (a: PaletteAction) => boolean) =>
      expect(allItems().some((i) => match(i.action))).toBe(true);
    const note = (id: string, value?: number) => (a: PaletteAction) =>
      a.type === "noteEffect" && a.id === id && a.value === value;
    const beat = (id: string, value?: number) => (a: PaletteAction) =>
      a.type === "beatEffect" && a.id === id && a.value === value;

    // Rhythm.
    for (const { duration } of NOTE_VALUES) {
      has((a) => a.type === "duration" && a.duration === duration);
    }
    for (const type of ["rest", "fillRests", "tie", "insertBeat", "deleteBeat", "bar"] as const) {
      has((a) => a.type === type);
    }
    has((a) => a.type === "dots" && a.count === 1);
    has((a) => a.type === "dots" && a.count === 2);
    has((a) => a.type === "voice" && a.voice === 0);
    has((a) => a.type === "voice" && a.voice === 1);
    for (const t of TUPLETS) {
      has((a) => a.type === "tuplet" && tupletKey(a.tuplet) === tupletKey(t));
    }
    has((a) => a.type === "nestedTuplet");

    // Marks.
    const { AccentuationType, CrescendoType, DynamicValue, NoteAccidentalMode, Ottavia } = model;
    has(note("accent", AccentuationType.Normal));
    has(note("accent", AccentuationType.Heavy));
    has(note("accent", AccentuationType.Tenuto));
    has(note("staccato"));
    has((a) => a.type === "fermata");
    has(note("dead"));
    has(note("ghost"));
    for (const value of [DynamicValue.PPP, DynamicValue.P, DynamicValue.F, DynamicValue.FFF]) {
      has(beat("dynamics", value));
    }
    has(beat("crescendo", CrescendoType.Crescendo));
    has(beat("crescendo", CrescendoType.Decrescendo));
    for (const c of NOTE_EFFECTS.accidental.choices.slice(1)) {
      has(note("accidental", c.value));
      expect(c.value).not.toBe(NoteAccidentalMode.Default);
    }
    for (const c of BEAT_EFFECTS.ottava.choices.slice(1)) has(beat("ottava", c.value));
    expect(Ottavia).toBeDefined();

    // Guitar.
    for (const id of ["hammerPull", "palmMute", "letRing", "leftHandTap"]) has(note(id));
    for (const id of ["tap", "slap", "pop"]) has(beat(id));
    for (const id of ["vibrato", "harmonic", "slideOut", "slideIn"]) {
      for (const c of NOTE_EFFECTS[id as "vibrato"].choices.slice(1)) has(note(id, c.value));
    }
    has(note("trill", 1));
    has(note("trill", 2));
    for (const c of NOTE_EFFECTS.trillSpeed.choices) has(note("trillSpeed", c.value));
    for (const id of ["pickStroke", "brush", "tremolo", "fade", "wah", "rasgueado"]) {
      for (const c of BEAT_EFFECTS[id as "brush"].choices.slice(1)) has(beat(id, c.value));
    }
    for (const type of ["bend", "whammy", "text", "chord", "lyrics", "shortcuts"] as const) {
      has((a) => a.type === type);
    }
    has((a) => a.type === "grace" && a.grace === model.GraceType.BeforeBeat);
    has((a) => a.type === "grace" && a.grace === model.GraceType.OnBeat);
    has((a) => a.type === "repeat" && a.side === "start");
    has((a) => a.type === "repeatEnd" && a.count === 2);
  });

  it("has the bar level boxes: all keys, time presets, tempo names, feels, endings and jumps", () => {
    const box = (id: string): PaletteBox => boxes().find((b) => b.id === id)!;
    const actions = (id: string) => box(id).groups.flatMap((g) => g.items.map((i) => i.action));

    expect(actions("key")).toHaveLength(KEY_SIGNATURES.length * 2);
    expect(box("key").groups.map((g) => g.label)).toEqual(["Major", "Minor"]);
    expect(actions("time").every((a) => a.type === "time")).toBe(true);
    expect(box("time").footer).toBe("time");
    expect(
      box("tempo")
        .groups.flatMap((g) => g.items)
        .every((i) => /^[A-Z][a-z]+, \d+ BPM$/.test(i.label)),
    ).toBe(true);
    expect(actions("feel")).toHaveLength(TRIPLET_FEELS.length);
    expect(actions("endings")).toHaveLength(MAX_ENDINGS);
    expect(
      actions("jumps")
        .map((a) => (a.type === "jump" ? a.direction : null))
        .sort(),
    ).toEqual(DIRECTIONS.map((d) => d.value).sort());
    expect(actions("octave")).toHaveLength(4);
  });

  it("keeps boxes to the columns of the grid and spans inside them", () => {
    for (const b of boxes()) {
      expect(b.columns, b.id).toBeGreaterThanOrEqual(2);
      expect(b.columns, b.id).toBeLessThanOrEqual(6);
      for (const g of b.groups) {
        for (const item of g.items) expect(item.span ?? 1, item.id).toBeLessThanOrEqual(b.columns);
      }
    }
  });

  it("fits a row into the 8 columns of the palette", () => {
    for (const s of PALETTE_SECTIONS) {
      for (const r of s.rows) expect(r.entries.length, s.id).toBeLessThanOrEqual(8);
    }
  });

  it("filters by track kind the way the old toolbars did", () => {
    const ids = (kind: TrackKind) =>
      new Set(
        paletteFor(kind).flatMap((s) =>
          s.rows.flatMap((r) => r.entries.map((e) => ("cell" in e ? e.cell.id : e.box.id))),
        ),
      );
    const stringed = ids("stringed");
    const pitched = ids("pitched");
    const drums = ids("drums");

    expect(stringed.has("note:palmMute")).toBe(true);
    expect(pitched.has("note:palmMute")).toBe(false);
    expect(drums.has("note:palmMute")).toBe(false);
    for (const id of ["bend", "whammy", "slide", "harmonic", "wah", "rasgueado", "pick"]) {
      expect(stringed.has(id), id).toBe(true);
      expect(pitched.has(id), id).toBe(false);
    }
    // Brush, tremolo, fade, staccato, vibrato: melodic tracks.
    for (const id of ["brush", "tremolo", "fade", "vibrato", "octave"]) {
      expect(stringed.has(id), id).toBe(true);
      expect(pitched.has(id), id).toBe(true);
      expect(drums.has(id), id).toBe(false);
    }
    expect(drums.has("lyrics")).toBe(false);
    expect(pitched.has("lyrics")).toBe(true);
    // Drums keep dynamics, accents, ghost notes, text, chords and all the structure.
    for (const id of [
      "articulation",
      "note:ghost",
      "beat:dynamics:" + model.DynamicValue.F,
      "key",
      "time",
      "jumps",
      "text",
      "chord",
    ]) {
      expect(drums.has(id), id).toBe(true);
    }
    // Accidentals are for pitched notes.
    expect(drums.has("note:accidental:" + model.NoteAccidentalMode.ForceSharp)).toBe(false);
  });

  it("leaves out boxes and sections that end up empty", () => {
    for (const kind of KINDS) {
      for (const s of paletteFor(kind)) {
        expect(s.rows.length).toBeGreaterThan(0);
        for (const r of s.rows) {
          for (const e of r.entries) {
            if ("box" in e) expect(boxGroups(e.box, kind).length).toBeGreaterThan(0);
            else expect(itemAvailable(e.cell, kind)).toBe(true);
          }
        }
      }
    }
    // The guitar section does not exist on drums.
    expect(paletteFor("drums").some((s) => s.id === "guitar")).toBe(false);
    expect(paletteFor("stringed").some((s) => s.id === "guitar")).toBe(true);
  });

  it("puts the sections in the two toolbars, Edit and Effects", () => {
    expect(PALETTE_SECTIONS.map((s) => [s.id, s.toolbar])).toEqual([
      ["structure", "Edit"],
      ["notes", "Edit"],
      ["marks", "Effects"],
      ["guitar", "Effects"],
      ["text", "Effects"],
    ]);
  });
});
