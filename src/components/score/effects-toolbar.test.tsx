import { model } from "@coderline/alphatab";
import { screen, within } from "@testing-library/react";

import {
  EffectsToolbar,
  type EffectActions,
  type PaletteState,
} from "@/components/score/effects-toolbar";
import { ScoreEditor } from "@/lib/score/editor";
import type { TrackKind } from "@/lib/score/music";
import { createSong } from "@/lib/score/tracks";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const { GraceType, HarmonicType, SlideOutType, VibratoType } = model;

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
});

function setup({
  editor = editorOf(),
  kind = "stringed" as TrackKind,
  state,
}: { editor?: ScoreEditor; kind?: TrackKind; state?: Partial<PaletteState> } = {}) {
  const actions: EffectActions = {
    onToggleNote: vi.fn(),
    onNoteEffect: vi.fn(),
    onToggleBeat: vi.fn(),
    onBeatEffect: vi.fn(),
    onGrace: vi.fn(),
    onFermata: vi.fn(),
    onRepeat: vi.fn(),
    onBend: vi.fn(),
    onWhammy: vi.fn(),
    onText: vi.fn(),
    onChord: vi.fn(),
    onLyrics: vi.fn(),
    onDone: vi.fn(),
  };
  const utils = renderWithProviders(
    <EffectsToolbar
      effects={editor.effects}
      state={{ ...stateOf(editor), ...state }}
      kind={kind}
      actions={actions}
    />,
  );
  return { ...utils, actions, editor };
}

describe("EffectsToolbar", () => {
  it("shows the note's effects as pressed toggles and switches them", async () => {
    const { user, actions } = setup();
    const toolbar = screen.getByRole("toolbar", { name: "Effects" });
    expect(within(toolbar).getByRole("button", { name: "Palm mute" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(toolbar).getByRole("button", { name: "Vibrato" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(toolbar).getByRole("button", { name: "Let ring" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // The key is shown in the tooltip, on hover and on keyboard focus.
    await user.hover(within(toolbar).getByRole("button", { name: "Hammer-on / pull-off" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Hammer-on / pull-off (H)");
    await user.unhover(within(toolbar).getByRole("button", { name: "Hammer-on / pull-off" }));
    await expectNoA11yViolations();

    await user.click(within(toolbar).getByRole("button", { name: "Let ring" }));
    expect(actions.onToggleNote).toHaveBeenCalledWith("letRing");
    expect(actions.onDone).toHaveBeenCalled();
  });

  it("picks effects with more choices from menus", async () => {
    const { user, actions } = setup();
    await user.click(screen.getByRole("button", { name: "Slide" }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Legato slide to the next note" }),
    );
    expect(actions.onNoteEffect).toHaveBeenCalledWith("slideOut", SlideOutType.Legato);

    await user.click(screen.getByRole("button", { name: "Harmonic" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Pinch harmonic" }));
    expect(actions.onNoteEffect).toHaveBeenCalledWith("harmonic", HarmonicType.Pinch);

    // The vibrato is on: its menu says so, and shows the current choice.
    await user.click(screen.getByRole("button", { name: "Vibrato and trill (on)" }));
    expect(await screen.findByRole("menuitemradio", { name: "Wide vibrato" })).toBeChecked();
    // No trill yet: its speed can't be chosen.
    expect(screen.getByRole("menuitemradio", { name: "32nd notes" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByRole("menuitemradio", { name: "Trill a whole step up" }));
    expect(actions.onNoteEffect).toHaveBeenCalledWith("trill", 2);
    expect(actions.onDone).toHaveBeenCalled();
  });

  it("sets beat effects, grace notes and tapping from the menus", async () => {
    const { user, actions } = setup();
    await user.click(screen.getByRole("button", { name: "Picking" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Arpeggio up" }));
    expect(actions.onBeatEffect).toHaveBeenCalledWith("brush", model.BrushType.ArpeggioUp);

    await user.click(screen.getByRole("button", { name: "Picking" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Downstroke" }));
    expect(actions.onBeatEffect).toHaveBeenCalledWith("pickStroke", model.PickStroke.Down);

    // The rasgueado patterns are in a submenu: open it with the keyboard.
    await user.click(screen.getByRole("button", { name: "Picking" }));
    (await screen.findByRole("menuitem", { name: "Rasgueado" })).focus();
    await user.keyboard("{ArrowRight}");
    await user.click(await screen.findByRole("menuitemradio", { name: "Rasgueado ami (triplet)" }));
    expect(actions.onBeatEffect).toHaveBeenCalledWith("rasgueado", model.Rasgueado.AmiTriplet);

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Grace note on the beat" }));
    expect(actions.onGrace).toHaveBeenCalledWith(GraceType.OnBeat);

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Slap" }));
    expect(actions.onToggleBeat).toHaveBeenCalledWith("slap");

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Left-hand tapping" }));
    expect(actions.onToggleNote).toHaveBeenCalledWith("leftHandTap");

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Wah closed" }));
    expect(actions.onBeatEffect).toHaveBeenCalledWith("wah", model.WahPedal.Closed);
  });

  it("opens the bend, whammy, text and chord editors", async () => {
    const { user, actions } = setup();
    await user.click(screen.getByRole("button", { name: "Bend…" }));
    await user.click(screen.getByRole("button", { name: "Whammy…" }));
    await user.click(screen.getByRole("button", { name: "Text…" }));
    await user.click(screen.getByRole("button", { name: "Chord…" }));
    expect(actions.onBend).toHaveBeenCalled();
    expect(actions.onWhammy).toHaveBeenCalled();
    expect(actions.onText).toHaveBeenCalled();
    expect(actions.onChord).toHaveBeenCalled();
  });

  it("disables note effects without a note", () => {
    setup({ editor: editorOf({ note: false }) });
    expect(screen.getByRole("button", { name: "Palm mute" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Bend…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Whammy…" })).toBeDisabled();
    // Text and chords can go on rests.
    expect(screen.getByRole("button", { name: "Text…" })).toBeEnabled();
  });

  it("offers only what suits the track", async () => {
    const { unmount } = setup({ kind: "pitched" });
    expect(screen.queryByRole("button", { name: "Palm mute" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Slide" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bend…" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Staccato" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Picking" })).toBeInTheDocument();
    unmount();

    setup({ kind: "drums" });
    expect(screen.getByRole("button", { name: "Ghost note" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accent" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Staccato" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Picking" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Vibrato and trill" })).not.toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("gives every modifier an icon button with a name (#53)", () => {
    setup();
    const buttons = screen
      .getAllByRole("button")
      .filter((b) => b.dataset.slot === "palette-button");
    expect(buttons.length).toBeGreaterThan(30);
    for (const button of buttons) {
      expect(button).toHaveAccessibleName();
      expect(button.className).toContain("size-8");
      // An icon: a Bravura glyph, a Lucide icon or a short text mark.
      expect(button.querySelector("[data-glyph], svg, span[aria-hidden]")).not.toBeNull();
    }
    for (const name of [
      "Accent",
      "Heavy accent",
      "Tenuto",
      "Staccato",
      "Fermata",
      "Piano (p)",
      "Fortissimo (ff)",
      "Crescendo",
      "Decrescendo",
      "Sharp",
      "Flat",
      "Natural",
      "8va (an octave higher)",
      "Grace note",
      "Trill",
      "Downstroke",
      "Upstroke",
      "Arpeggio up",
      "Tremolo picking",
      "Fade in",
      "Repeat start",
      "Repeat end",
      "Lyrics…",
    ]) {
      expect(screen.getByRole("button", { name }), name).toBeInTheDocument();
    }
    expect(
      screen.getByRole("button", { name: "Fermata" }).querySelector("[data-glyph]"),
    ).toHaveAttribute("data-glyph", "fermataAbove");
  });

  it("shows dynamics as an exclusive group with one pressed button (#53)", async () => {
    const editor = editorOf();
    editor.setBeatEffect("dynamics", model.DynamicValue.PP);
    const { user, actions } = setup({ editor });
    const group = screen.getByRole("group", { name: "Dynamics" });
    const pressed = within(group)
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressed.map((b) => b.getAttribute("aria-label"))).toEqual(["Pianissimo (pp)"]);
    await user.click(within(group).getByRole("button", { name: "Fortissimo (ff)" }));
    expect(actions.onBeatEffect).toHaveBeenCalledWith("dynamics", model.DynamicValue.FF);
  });

  it("follows the selection: pressed, mixed or not (#53)", () => {
    const editor = editorOf();
    editor.typeDigit(5); // no: stays on the same beat; add a second beat
    editor.moveBeat(1);
    editor.typeDigit(7);
    editor.moveBeat(-1, true); // select both: palm mute only on the first
    setup({ editor });
    expect(screen.getByRole("button", { name: "Palm mute" })).toHaveAttribute(
      "aria-pressed",
      "mixed",
    );
    expect(screen.getByRole("button", { name: "Let ring" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("puts fermatas and repeats on and opens the lyrics", async () => {
    const { user, actions } = setup({ state: { repeatStart: true, fermata: "on" } });
    expect(screen.getByRole("button", { name: "Repeat start" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Fermata" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Fermata" }));
    await user.click(screen.getByRole("button", { name: "Repeat end" }));
    await user.click(screen.getByRole("button", { name: "Lyrics…" }));
    expect(actions.onFermata).toHaveBeenCalled();
    expect(actions.onRepeat).toHaveBeenCalledWith("end");
    expect(actions.onLyrics).toHaveBeenCalled();
    await expectNoA11yViolations();
  });
});
