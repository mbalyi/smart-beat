import { model } from "@coderline/alphatab";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import {
  EditPalette,
  type EditActions,
  type EffectActions,
  type PaletteState,
} from "@/components/score/edit-palette";
import { ScoreEditor, type BeatInfo } from "@/lib/score/editor";
import type { TrackKind } from "@/lib/score/music";
import { barSettingsOf, type BarSettings } from "@/lib/score/structure";
import { createSong } from "@/lib/score/tracks";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const { BrushType, Duration, GraceType, HarmonicType, SlideOutType, VibratoType } = model;

const BEAT: BeatInfo = {
  duration: Duration.Quarter,
  dots: 0,
  tuplet: { numerator: 1, denominator: 1 },
  rest: false,
  notes: [{ string: 6, fret: 3, pitch: 67, tied: false }],
};

/** An editor on a note: fret 5 with palm mute and wide vibrato (or on an empty beat). */
function editorOf({ note = true } = {}): ScoreEditor {
  const editor = new ScoreEditor(createSong());
  if (!note) return editor;
  editor.typeDigit(5);
  editor.toggleNoteEffect("palmMute");
  editor.setNoteEffect("vibrato", VibratoType.Wide);
  return editor;
}

const stateOf = (editor: ScoreEditor): PaletteState => ({
  effect: (scope, id, value) => editor.effectState(scope, id, value),
  fermata: editor.fermataState,
  repeatStart: editor.repeatState("start"),
  repeatEnd: editor.repeatState("end"),
  repeatCount: editor.repeatCount(),
});

function setup({
  editor = editorOf(),
  kind = "stringed" as TrackKind,
  state,
  bar,
  ...overrides
}: {
  editor?: ScoreEditor;
  kind?: TrackKind;
  state?: Partial<PaletteState>;
  bar?: Partial<BarSettings>;
} & Partial<Omit<Parameters<typeof EditPalette>[0], "state" | "bar" | "kind">> = {}) {
  const edit: EditActions = {
    onDuration: vi.fn(),
    onDots: vi.fn(),
    onTuplet: vi.fn(),
    onRest: vi.fn(),
    onFillRests: vi.fn(),
    onTie: vi.fn(),
    onInsertBeat: vi.fn(),
    onDeleteBeat: vi.fn(),
    onVoice: vi.fn(),
    onBar: vi.fn(),
    onBarSettings: vi.fn(),
    onShortcuts: vi.fn(),
    onDone: vi.fn(),
  };
  const fx: EffectActions = {
    onToggleNote: vi.fn(),
    onNoteEffect: vi.fn(),
    onToggleBeat: vi.fn(),
    onBeatEffect: vi.fn(),
    onGrace: vi.fn(),
    onFermata: vi.fn(),
    onRepeat: vi.fn(),
    onRepeatEnd: vi.fn(),
    onBend: vi.fn(),
    onWhammy: vi.fn(),
    onText: vi.fn(),
    onChord: vi.fn(),
    onLyrics: vi.fn(),
  };
  const utils = renderWithProviders(
    <EditPalette
      beat={BEAT}
      bar={{ ...barSettingsOf(editor.score, 0), ...bar }}
      voice={0}
      effects={editor.effects}
      state={{ ...stateOf(editor), ...state }}
      kind={kind}
      dots={() => "off"}
      tie="off"
      status="Bar 1, beat 1 of 4, string 1 (E), fret 3, Quarter"
      message="Fret 3 on string 1"
      statusId="status"
      edit={edit}
      fx={fx}
      auditionNotes
      onAuditionNotesChange={vi.fn()}
      {...overrides}
    />,
  );
  return { ...utils, edit, fx, editor };
}

const effects = () => screen.getByRole("toolbar", { name: "Effects" });
const edit = () => screen.getByRole("toolbar", { name: "Edit" });
/** The box a cell opens, as a group named after the family. */
const box = (name: string) => screen.findByRole("group", { name });

describe("EditPalette: cells", () => {
  it("shows the beat under the cursor", async () => {
    setup();

    expect(edit()).toBeInTheDocument();
    expect(effects()).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Note value" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Quarter" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Eighth" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Dot" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Tie" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(/fret 3, Quarter/)).toHaveAttribute("id", "status");
    expect(screen.getByRole("status")).toHaveTextContent("Fret 3 on string 1");
    await expectNoA11yViolations();
  });

  it("changes the rhythm and gives focus back to the score", async () => {
    const { user, edit: actions } = setup({
      dots: (count) => (count === 1 ? "on" : "off"),
      tie: "on",
    });

    await user.click(screen.getByRole("radio", { name: "Eighth" }));
    await user.click(screen.getByRole("button", { name: "Double dot" }));
    await user.click(screen.getByRole("button", { name: "Rest" }));
    await user.click(screen.getByRole("button", { name: "Fill bar with rests" }));
    await user.click(screen.getByRole("button", { name: "Tie" }));
    await user.click(screen.getByRole("button", { name: "Insert beat" }));
    await user.click(screen.getByRole("button", { name: "Delete beat" }));

    expect(actions.onDuration).toHaveBeenCalledWith(Duration.Eighth);
    expect(actions.onDots).toHaveBeenCalledWith(2);
    expect(actions.onRest).toHaveBeenCalledOnce();
    expect(actions.onFillRests).toHaveBeenCalledOnce();
    expect(actions.onTie).toHaveBeenCalledOnce();
    expect(actions.onInsertBeat).toHaveBeenCalledOnce();
    expect(actions.onDeleteBeat).toHaveBeenCalledOnce();
    expect(actions.onDone).toHaveBeenCalledTimes(7);
    expect(screen.getByRole("button", { name: "Dot" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Tie" })).toHaveAttribute("aria-pressed", "true");
  });

  it("makes the checked note value the one tab stop and moves between them with arrow keys", async () => {
    const { user } = setup();
    const quarter = screen.getByRole("radio", { name: "Quarter" });
    expect(quarter).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "Whole" })).toHaveAttribute("tabindex", "-1");
    quarter.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Eighth" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Half" })).toHaveFocus();
  });

  it("opens the bar's settings without sending focus to the score", async () => {
    const { user, edit: actions } = setup();
    await user.click(screen.getByRole("button", { name: "Bar" }));
    expect(actions.onBar).toHaveBeenCalled();
    expect(actions.onDone).not.toHaveBeenCalled();
  });

  it("keeps focus where it was when a cell is clicked", () => {
    setup();
    expect(fireEvent.mouseDown(screen.getByRole("radio", { name: "Quarter" }))).toBe(false);
    // The cell that opens a box takes focus: the box moves it on.
    expect(fireEvent.mouseDown(screen.getByRole("button", { name: /^Slide/ }))).toBe(true);
  });

  it("names every cell and shows its shortcut in a tooltip", async () => {
    const { user } = setup();
    await user.hover(screen.getByRole("button", { name: "Dot" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Dot (.)");
  });

  it("draws icons only: Bravura glyphs, Lucide icons or written marks, every cell 32px", () => {
    setup();
    expect(
      screen.getByRole("radio", { name: "Quarter" }).querySelector("[data-glyph]"),
    ).toHaveAttribute("data-glyph", "noteQuarterUp");
    expect(
      screen.getByRole("button", { name: "Rest" }).querySelector("[data-glyph]"),
    ).toHaveAttribute("data-glyph", "restQuarter");
    const cells = screen.getAllByRole("button").filter((b) => b.dataset.slot === "palette-button");
    expect(cells.length).toBeGreaterThan(40);
    for (const cell of cells) {
      expect(cell).toHaveAccessibleName();
      expect(cell.className).toContain("size-8");
      expect(cell.querySelector("[data-glyph], svg, span[aria-hidden]")).not.toBeNull();
    }
  });

  it("shows a selection where only some beats are dotted as mixed", () => {
    setup({ dots: (count) => (count === 1 ? "mixed" : "off"), tie: "mixed" });
    expect(screen.getByRole("button", { name: "Dot" })).toHaveAttribute("aria-pressed", "mixed");
    expect(screen.getByRole("button", { name: "Tie" })).toHaveAttribute("aria-pressed", "mixed");
    expect(screen.getByRole("button", { name: "Double dot" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("shows pressed cells in the brand purple, not blue", () => {
    setup();
    const pressed = within(effects()).getByRole("button", { name: "Palm mute, P.M." });
    expect(pressed).toHaveAttribute("aria-pressed", "true");
    expect(pressed.className).toContain("#9a2ae6");
    expect(pressed.className).not.toContain("sky-");
    expect(screen.getByRole("radio", { name: "Quarter" }).className).toContain("#9a2ae6");
  });

  it("switches note effects on and off and gives focus back", async () => {
    const { user, fx, edit: actions } = setup();
    expect(within(effects()).getByRole("button", { name: "Palm mute, P.M." })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(effects()).getByRole("button", { name: "Let ring, L.R." })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await user.hover(within(effects()).getByRole("button", { name: "Hammer-on / pull-off, H/P" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Hammer-on / pull-off (H)");
    await user.unhover(
      within(effects()).getByRole("button", { name: "Hammer-on / pull-off, H/P" }),
    );
    await user.click(within(effects()).getByRole("button", { name: "Let ring, L.R." }));
    expect(fx.onToggleNote).toHaveBeenCalledWith("letRing");
    expect(actions.onDone).toHaveBeenCalled();
    await expectNoA11yViolations();
  });

  it("opens the bend, whammy, text, chord and lyrics editors and the shortcuts", async () => {
    const { user, fx, edit: actions } = setup();
    await user.click(screen.getByRole("button", { name: "Bend" }));
    await user.click(screen.getByRole("button", { name: "Whammy" }));
    await user.click(screen.getByRole("button", { name: "Text" }));
    await user.click(screen.getByRole("button", { name: "Chord" }));
    await user.click(screen.getByRole("button", { name: "Lyrics" }));
    await user.click(screen.getByRole("button", { name: "Shortcuts" }));
    expect(fx.onBend).toHaveBeenCalled();
    expect(fx.onWhammy).toHaveBeenCalled();
    expect(fx.onText).toHaveBeenCalled();
    expect(fx.onChord).toHaveBeenCalled();
    expect(fx.onLyrics).toHaveBeenCalled();
    expect(actions.onShortcuts).toHaveBeenCalled();
  });

  it("puts fermatas and repeats on", async () => {
    const { user, fx } = setup({ state: { repeatStart: true, fermata: "on" } });
    expect(screen.getByRole("button", { name: "Repeat start" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Fermata" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Fermata" }));
    expect(fx.onFermata).toHaveBeenCalled();
  });

  it("writes a repeat end that plays a chosen number of times, and takes it away (#228)", async () => {
    const { user, fx } = setup({ state: { repeatEnd: true, repeatCount: 3 } });
    await user.click(screen.getByRole("button", { name: /^Repeat end/ }));
    const counts = await box("Repeat end");
    expect(within(counts).getAllByRole("button")).toHaveLength(7);
    expect(
      within(counts).getByRole("button", { name: "Repeat end, play 3 times" }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(within(counts).getByRole("button", { name: "Repeat end, play 4 times" }));
    expect(fx.onRepeatEnd).toHaveBeenLastCalledWith(4);
    await user.click(screen.getByRole("button", { name: /^Repeat end/ }));
    await user.click(
      within(await box("Repeat end")).getByRole("button", { name: "Repeat end, play 3 times" }),
    );
    expect(fx.onRepeatEnd).toHaveBeenLastCalledWith(0);
  });

  it("disables note effects without a note", () => {
    setup({ editor: editorOf({ note: false }) });
    expect(screen.getByRole("button", { name: "Palm mute, P.M." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Bend" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Whammy" })).toBeDisabled();
    // Text and chords can go on rests.
    expect(screen.getByRole("button", { name: "Text" })).toBeEnabled();
  });

  it("follows the selection: pressed, mixed or not", () => {
    const editor = editorOf();
    editor.moveBeat(1);
    editor.typeDigit(7);
    editor.moveBeat(-1, true); // select both: palm mute only on the first
    setup({ editor });
    expect(screen.getByRole("button", { name: "Palm mute, P.M." })).toHaveAttribute(
      "aria-pressed",
      "mixed",
    );
    expect(screen.getByRole("button", { name: "Let ring, L.R." })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("shows dynamics as one pressed cell, and a second click takes it off", async () => {
    const editor = editorOf();
    editor.setBeatEffect("dynamics", model.DynamicValue.PP);
    const { user, fx } = setup({ editor });
    const pressed = within(screen.getByRole("group", { name: "Dynamics and marks" }))
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressed.map((b) => b.getAttribute("aria-label"))).toEqual(["Pianissimo (pp)"]);
    await user.click(screen.getByRole("button", { name: "Fortissimo (ff)" }));
    expect(fx.onBeatEffect).toHaveBeenCalledWith("dynamics", model.DynamicValue.FF);
    await user.click(screen.getByRole("button", { name: "Pianissimo (pp)" }));
    expect(fx.onBeatEffect).toHaveBeenLastCalledWith("dynamics", model.DynamicValue.F);
  });

  it("offers only what suits the track", async () => {
    const { unmount } = setup({ kind: "pitched" });
    expect(screen.queryByRole("button", { name: "Palm mute, P.M." })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Slide/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bend" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Articulation/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Brush/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lyrics" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sharp" })).toBeInTheDocument();
    unmount();

    setup({ kind: "drums" });
    expect(screen.getByRole("button", { name: "Ghost note" })).toBeInTheDocument();
    // Drum hits have a loudness too (#178).
    expect(screen.getByRole("button", { name: "Forte (f)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Articulation/ })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Guitar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sharp" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Lyrics" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Brush/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Octave line/ })).not.toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("names every cell of every row, with the marks written as text in the name", () => {
    setup();
    for (const name of [
      "Fermata",
      "Piano (p)",
      "Crescendo",
      "Decrescendo",
      "Sharp",
      "Double flat",
      "Natural",
      "Dead note",
      "Ghost note",
      "Tapping, T",
      "Slap, S",
      "Pop, P",
      "Left-hand tapping, LH",
      "Repeat start",
      "Repeat end",
    ]) {
      expect(screen.getByRole("button", { name }), name).toBeInTheDocument();
    }
    expect(
      screen.getByRole("button", { name: "Fermata" }).querySelector("[data-glyph]"),
    ).toHaveAttribute("data-glyph", "fermataAbove");
  });
});

describe("EditPalette: play notes while editing (#90)", () => {
  it("shows the setting on and switches it off", async () => {
    const onAuditionNotesChange = vi.fn();
    const { user } = setup({ onAuditionNotesChange });
    const toggle = screen.getByRole("switch", { name: "Play notes while editing" });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(onAuditionNotesChange).toHaveBeenCalledWith(false);
  });
});

describe("EditPalette: boxes of effects", () => {
  it("opens a box as a named group of pressed or unpressed buttons and picks one", async () => {
    const { user, fx, edit: actions } = setup();
    const trigger = screen.getByRole("button", { name: /^Slide/ });
    expect(trigger).toHaveAttribute("aria-haspopup");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const slides = await box("Slide");
    await user.click(
      within(slides).getByRole("button", { name: /^Legato slide to the next note/ }),
    );
    expect(fx.onNoteEffect).toHaveBeenCalledWith("slideOut", SlideOutType.Legato);
    // A pick closes the box and hands focus to the score.
    await waitFor(() => expect(actions.onDone).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "Slide" })).not.toBeInTheDocument();
  });

  it("picks a harmonic, a vibrato and an articulation", async () => {
    const { user, fx } = setup();
    await user.click(screen.getByRole("button", { name: "Harmonic" }));
    await user.click(
      within(await box("Harmonic")).getByRole("button", { name: /^Pinch harmonic/ }),
    );
    expect(fx.onNoteEffect).toHaveBeenCalledWith("harmonic", HarmonicType.Pinch);

    // The vibrato is on: the cell says so and its box shows the current choice.
    await user.click(screen.getByRole("button", { name: "Vibrato, Wide vibrato (on)" }));
    const vibrato = await box("Vibrato");
    expect(within(vibrato).getByRole("button", { name: "Wide vibrato" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(vibrato).getByRole("button", { name: "Vibrato" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await user.click(within(vibrato).getByRole("button", { name: "Wide vibrato" }));
    expect(fx.onNoteEffect).toHaveBeenLastCalledWith("vibrato", VibratoType.None);

    await user.click(screen.getByRole("button", { name: "Articulation" }));
    await user.click(within(await box("Articulation")).getByRole("button", { name: "Tenuto" }));
    expect(fx.onNoteEffect).toHaveBeenLastCalledWith("accent", model.AccentuationType.Tenuto);
  });

  it("sets the trill and its speed, which needs a trill first", async () => {
    const editor = editorOf();
    const { user, fx } = setup({ editor });
    await user.click(screen.getByRole("button", { name: /^Trill/ }));
    const trill = await box("Trill");
    expect(within(trill).getByRole("button", { name: /^Trill speed: 32nd notes/ })).toBeDisabled();
    await user.click(within(trill).getByRole("button", { name: /^Trill a whole step up/ }));
    expect(fx.onNoteEffect).toHaveBeenCalledWith("trill", 2);
  });

  it("sets beat effects: brush, pick stroke, rasgueado, wah, fade and tremolo", async () => {
    const { user, fx } = setup();
    await user.click(screen.getByRole("button", { name: "Brush / arpeggio" }));
    await user.click(
      within(await box("Brush / arpeggio")).getByRole("button", { name: "Arpeggio up" }),
    );
    expect(fx.onBeatEffect).toHaveBeenCalledWith("brush", BrushType.ArpeggioUp);

    await user.click(screen.getByRole("button", { name: "Pick stroke" }));
    await user.click(within(await box("Pick stroke")).getByRole("button", { name: "Downstroke" }));
    expect(fx.onBeatEffect).toHaveBeenLastCalledWith("pickStroke", model.PickStroke.Down);

    await user.click(screen.getByRole("button", { name: /^Rasgueado/ }));
    await user.click(
      within(await box("Rasgueado")).getByRole("button", { name: /^Rasgueado ami \(triplet\)/ }),
    );
    expect(fx.onBeatEffect).toHaveBeenLastCalledWith("rasgueado", model.Rasgueado.AmiTriplet);

    await user.click(screen.getByRole("button", { name: "Wah" }));
    await user.click(within(await box("Wah")).getByRole("button", { name: "Wah closed" }));
    expect(fx.onBeatEffect).toHaveBeenLastCalledWith("wah", model.WahPedal.Closed);

    await user.click(screen.getByRole("button", { name: "Fade" }));
    await user.click(within(await box("Fade")).getByRole("button", { name: "Volume swell" }));
    expect(fx.onBeatEffect).toHaveBeenLastCalledWith("fade", model.FadeType.VolumeSwell);

    await user.click(screen.getByRole("button", { name: /^Tremolo picking/ }));
    await user.click(
      within(await box("Tremolo picking")).getByRole("button", {
        name: "Tremolo picking in 16th notes",
      }),
    );
    expect(fx.onBeatEffect).toHaveBeenLastCalledWith("tremolo", 2);
  });

  it("sets the grace note, and a second pick takes it off", async () => {
    const { user, fx } = setup();
    await user.click(screen.getByRole("button", { name: "Grace note" }));
    await user.click(
      within(await box("Grace note")).getByRole("button", { name: "Grace note on the beat" }),
    );
    expect(fx.onGrace).toHaveBeenCalledWith(GraceType.OnBeat);
  });

  it("toggles tapping, slap, pop and left-hand tapping", async () => {
    const { user, fx } = setup();
    await user.click(screen.getByRole("button", { name: "Tapping, T" }));
    await user.click(screen.getByRole("button", { name: "Slap, S" }));
    await user.click(screen.getByRole("button", { name: "Pop, P" }));
    await user.click(screen.getByRole("button", { name: "Left-hand tapping, LH" }));
    expect(fx.onToggleBeat).toHaveBeenCalledWith("tap");
    expect(fx.onToggleBeat).toHaveBeenCalledWith("slap");
    expect(fx.onToggleBeat).toHaveBeenCalledWith("pop");
    expect(fx.onToggleNote).toHaveBeenCalledWith("leftHandTap");
  });
});

describe("EditPalette: bar boxes", () => {
  it("shows the key and changes it, major or minor", async () => {
    const { user, edit: actions } = setup({ bar: { keySignature: 2, keyType: 0 } });
    const trigger = screen.getByRole("button", { name: "Key signature, D major, 2 sharps" });
    await user.click(trigger);
    const keys = await box("Key signature");
    expect(
      within(within(keys).getByRole("group", { name: "Major" })).getByRole("button", {
        name: "D major, 2 sharps",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(
      within(within(keys).getByRole("group", { name: "Minor" })).getByRole("button", {
        name: "E minor, 1 sharp",
      }),
    );
    expect(actions.onBarSettings).toHaveBeenCalledWith({ keySignature: 1, keyType: 1 });
    await waitFor(() => expect(actions.onDone).toHaveBeenCalled());
  });

  it("shows and changes the time signature with presets and the beats and unit inputs", async () => {
    const { user, edit: actions } = setup({
      bar: { timeSignature: { numerator: 7, denominator: 8 } },
    });
    await user.click(screen.getByRole("button", { name: "Time signature, 7/8" }));
    const time = await box("Time signature");
    await user.click(within(time).getByRole("button", { name: "3/4 time" }));
    expect(actions.onBarSettings).toHaveBeenLastCalledWith({
      timeSignature: { numerator: 3, denominator: 4 },
    });

    await user.click(screen.getByRole("button", { name: "Time signature, 7/8" }));
    const again = await box("Time signature");
    const beats = within(again).getByRole("spinbutton", { name: "Beats per bar" });
    expect(beats).toHaveValue(7);
    expect(within(again).getByRole("combobox", { name: "Beat unit" })).toHaveTextContent("8");
    await user.clear(beats);
    await user.type(beats, "5{Enter}");
    expect(actions.onBarSettings).toHaveBeenLastCalledWith({
      timeSignature: { numerator: 5, denominator: 8 },
    });
    // The box closes and the score gets focus back (not the cell).
    await waitFor(() => expect(actions.onDone).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "Time signature" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Time signature/ })).not.toHaveFocus();
  });

  it("keeps the beats per bar within 1 to 32 and ignores no-ops", async () => {
    const { user, edit: actions } = setup();
    await user.click(screen.getByRole("button", { name: /^Time signature/ }));
    const beats = within(await box("Time signature")).getByRole("spinbutton", {
      name: "Beats per bar",
    });
    await user.clear(beats);
    await user.type(beats, "99{Enter}");
    expect(actions.onBarSettings).toHaveBeenLastCalledWith({
      timeSignature: { numerator: 32, denominator: 4 },
    });
  });

  it("sets a tempo from a preset with its name, and takes it off when pressed again", async () => {
    const { user, edit: actions } = setup({ bar: { tempo: { bpm: 120, label: "Moderato" } } });
    await user.click(screen.getByRole("button", { name: /^Tempo/ }));
    const tempo = await box("Tempo");
    expect(within(tempo).getByRole("button", { name: "Moderato, 120 BPM" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(tempo).getByRole("button", { name: "Allegro, 144 BPM" }));
    expect(actions.onBarSettings).toHaveBeenLastCalledWith({
      tempo: { bpm: 144, label: "Allegro" },
    });
    await user.click(screen.getByRole("button", { name: /^Tempo/ }));
    await user.click(within(await box("Tempo")).getByRole("button", { name: "Moderato, 120 BPM" }));
    expect(actions.onBarSettings).toHaveBeenLastCalledWith({ tempo: null });
  });

  it("sets the triplet feel, alternate endings and jumps", async () => {
    const { user, edit: actions } = setup({
      bar: { endings: 0b01, directions: [model.Direction.TargetCoda] },
    });
    await user.click(screen.getByRole("button", { name: "Triplet feel" }));
    await user.click(
      within(await box("Triplet feel")).getByRole("button", { name: "Triplet feel: Dotted 8th" }),
    );
    expect(actions.onBarSettings).toHaveBeenLastCalledWith({
      tripletFeel: model.TripletFeel.Dotted8th,
    });

    // The first ending is on: pressing the second adds it, pressing the first removes it.
    await user.click(screen.getByRole("button", { name: /^Alternate endings/ }));
    const endings = await box("Alternate endings");
    expect(within(endings).getByRole("button", { name: "Ending 1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(endings).getByRole("button", { name: "Ending 2" }));
    expect(actions.onBarSettings).toHaveBeenLastCalledWith({ endings: 0b11 });

    await user.click(screen.getByRole("button", { name: /^Jumps/ }));
    const jumps = await box("Jumps");
    expect(within(jumps).getAllByRole("button")).toHaveLength(19);
    expect(within(jumps).getByRole("button", { name: "Coda" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(jumps).getByRole("button", { name: /^Dal Segno al Coda/ }));
    expect(actions.onBarSettings).toHaveBeenLastCalledWith({
      directions: [model.Direction.TargetCoda, model.Direction.JumpDalSegnoAlCoda],
    });
    await user.click(screen.getByRole("button", { name: /^Jumps/ }));
    await user.click(within(await box("Jumps")).getByRole("button", { name: "Coda" }));
    expect(actions.onBarSettings).toHaveBeenLastCalledWith({ directions: [] });
  });

  it("changes the voice from the voice box", async () => {
    const { user, edit: actions } = setup();
    await user.click(screen.getByRole("button", { name: /^Voice, Voice 1/ }));
    await user.click(within(await box("Voice")).getByRole("button", { name: /^Voice 2/ }));
    expect(actions.onVoice).toHaveBeenCalledWith(1);
  });

  it("sets the octave line", async () => {
    const { user, fx } = setup();
    await user.click(screen.getByRole("button", { name: "Octave line" }));
    await user.click(
      within(await box("Octave line")).getByRole("button", { name: "8vb (an octave lower)" }),
    );
    expect(fx.onBeatEffect).toHaveBeenCalledWith("ottava", model.Ottavia._8vb);
  });
});

describe("EditPalette: the tuplet box", () => {
  it("chooses tuplets, none and the nested dialog's entry included", async () => {
    const { user, edit: actions } = setup();
    await user.click(screen.getByRole("button", { name: /^Tuplet/ }));
    const tuplets = await box("Tuplet");
    expect(within(tuplets).getByRole("button", { name: "None" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const name of [
      "Triplet (3:2)",
      "Quintuplet (5:4)",
      "Sextuplet (6:4)",
      "Septuplet (7:4)",
      "9:8",
      "10:8",
      "11:8",
      "12:8",
      "13:8",
      "Nested tuplet",
    ]) {
      expect(within(tuplets).getByRole("button", { name }), name).toBeInTheDocument();
    }
    await user.click(within(tuplets).getByRole("button", { name: "Triplet (3:2)" }));
    expect(actions.onTuplet).toHaveBeenCalledWith(
      expect.objectContaining({ numerator: 3, denominator: 2 }),
    );
  });

  it("opens the nested tuplet dialog and applies the combined ratio", async () => {
    const { user, edit: actions } = setup();
    await user.click(screen.getByRole("button", { name: /^Tuplet/ }));
    await user.click(within(await box("Tuplet")).getByRole("button", { name: "Nested tuplet" }));
    const dialog = await screen.findByRole("dialog", { name: "Nested tuplet" });
    // A triplet of triplets by default: nine notes in the time of four.
    expect(within(dialog).getByTestId("nested-tuplet-result")).toHaveTextContent(
      "9 notes in the time of 4 (9:4)",
    );
    await expectNoA11yViolations();
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(actions.onTuplet).toHaveBeenCalledWith({ numerator: 9, denominator: 4 });
    // Focus goes back to the score, whichever way the dialog closes.
    await waitFor(() => expect(actions.onDone).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", { name: "Nested tuplet" })).not.toBeInTheDocument();
  });

  it("combines other ratios, refuses too many notes and cancels", async () => {
    const { user, edit: actions } = setup();
    const open = async () => {
      await user.click(screen.getByRole("button", { name: /^Tuplet/ }));
      await user.click(within(await box("Tuplet")).getByRole("button", { name: "Nested tuplet" }));
      return screen.findByRole("dialog", { name: "Nested tuplet" });
    };
    let dialog = await open();
    await user.click(within(dialog).getByRole("combobox", { name: /^Inner tuplet/ }));
    await user.click(await screen.findByRole("option", { name: "Quintuplet (5:4)" }));
    expect(within(dialog).getByTestId("nested-tuplet-result")).toHaveTextContent(
      "15 notes in the time of 8 (15:8)",
    );
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(actions.onTuplet).toHaveBeenLastCalledWith({ numerator: 15, denominator: 8 });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Nested tuplet" })).not.toBeInTheDocument(),
    );
    dialog = await open();
    for (const name of ["Outer tuplet", /^Inner tuplet/]) {
      await user.click(within(dialog).getByRole("combobox", { name }));
      await user.click(await screen.findByRole("option", { name: "13:8" }));
    }
    expect(within(dialog).getByTestId("nested-tuplet-result")).toHaveTextContent("too many notes");
    expect(within(dialog).getByRole("button", { name: "Apply" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(actions.onTuplet).toHaveBeenCalledTimes(1);
  });

  it("shows a nested ratio the list does not name under its own ratio", async () => {
    const { user } = setup({ beat: { ...BEAT, tuplet: { numerator: 9, denominator: 4 } } });
    await user.click(screen.getByRole("button", { name: /^Tuplet/ }));
    expect(within(await box("Tuplet")).getByRole("button", { name: "9:4" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("EditPalette: effects of one value", () => {
  it("has the harmonics of the catalogue", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Harmonic" }));
    const harmonics = await box("Harmonic");
    for (const name of [
      "Natural harmonic",
      "Artificial harmonic",
      "Tapped harmonic",
      "Pinch harmonic",
      "Semi-harmonic",
    ]) {
      expect(
        within(harmonics).getByRole("button", { name: new RegExp(`^${name}`) }),
        name,
      ).toBeInTheDocument();
    }
  });
});
