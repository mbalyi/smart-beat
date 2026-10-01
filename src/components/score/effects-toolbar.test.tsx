import { model } from "@coderline/alphatab";
import { screen, within } from "@testing-library/react";

import { EffectsToolbar, type EffectActions } from "@/components/score/effects-toolbar";
import { ScoreEditor, type EffectsInfo } from "@/lib/score/editor";
import type { TrackKind } from "@/lib/score/music";
import { createSong } from "@/lib/score/tracks";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const { GraceType, HarmonicType, SlideOutType, VibratoType } = model;

/** The effects of a note: fret 5 with palm mute and wide vibrato (or of an empty beat). */
function effectsOf({ note = true } = {}): EffectsInfo {
  const editor = new ScoreEditor(createSong());
  if (!note) return editor.effects;
  editor.typeDigit(5);
  editor.toggleNoteEffect("palmMute");
  editor.setNoteEffect("vibrato", VibratoType.Wide);
  return editor.effects;
}

function setup({ effects = effectsOf(), kind = "stringed" as TrackKind } = {}) {
  const actions: EffectActions = {
    onToggleNote: vi.fn(),
    onNoteEffect: vi.fn(),
    onToggleBeat: vi.fn(),
    onBeatEffect: vi.fn(),
    onGrace: vi.fn(),
    onBend: vi.fn(),
    onWhammy: vi.fn(),
    onText: vi.fn(),
    onChord: vi.fn(),
    onDone: vi.fn(),
  };
  const utils = renderWithProviders(
    <EffectsToolbar effects={effects} kind={kind} actions={actions} />,
  );
  return { ...utils, actions };
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
    setup({ effects: effectsOf({ note: false }) });
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
});
