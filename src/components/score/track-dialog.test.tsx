import { screen, within } from "@testing-library/react";

import { TrackDialog, type TrackSettings } from "@/components/score/track-dialog";
import { drumKitOf } from "@/lib/score/instrument-view";
import type { SoundFontId } from "@/lib/score/soundfonts";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const GUITAR: TrackSettings = {
  kind: "stringed",
  name: "Lead",
  program: 29,
  tuning: [64, 59, 55, 50, 45, 40],
  capo: 0,
};

function setup(initial: TrackSettings | null, soundFont?: SoundFontId) {
  const onSubmit = vi.fn();
  const onOpenChange = vi.fn();
  const utils = renderWithProviders(
    <TrackDialog
      open
      onOpenChange={onOpenChange}
      initial={initial}
      drumKit={drumKitOf(null)}
      soundFont={soundFont}
      onSubmit={onSubmit}
    />,
  );
  return { ...utils, onSubmit, onOpenChange };
}

const choose = async (
  user: ReturnType<typeof setup>["user"],
  field: string,
  option: string | RegExp,
) => {
  await user.click(screen.getByRole("combobox", { name: field }));
  await user.click(await screen.findByRole("option", { name: option }));
};

describe("TrackDialog: adding", () => {
  it("adds a track from an instrument preset", async () => {
    const { user, onSubmit, onOpenChange } = setup(null);

    expect(screen.getByRole("dialog", { name: "Add track" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Instrument" })).toHaveTextContent(
      "Guitar (6 strings)",
    );
    await expectNoA11yViolations();

    await choose(user, "Instrument", "Bass (5 strings)");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("5-String Bass");
    expect(screen.getByRole("combobox", { name: "Strings" })).toHaveTextContent("5 strings");
    expect(screen.getByRole("combobox", { name: "Tuning" })).toHaveTextContent(
      "Bass 5 Strings Tuning",
    );
    await user.click(screen.getByRole("button", { name: "Add track" }));

    expect(onSubmit).toHaveBeenCalledWith({
      presetId: "bass-5",
      kind: "stringed",
      name: "5-String Bass",
      program: 33,
      tuning: [43, 38, 33, 28, 23],
      capo: 0,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("adds a drum track, showing its drum-kit notation", async () => {
    const { user, onSubmit } = setup(null);

    await choose(user, "Instrument", "Drums");

    expect(
      screen.queryByRole("combobox", { name: "Sound (General MIDI)" }),
    ).not.toBeInTheDocument();
    const kit = screen.getByRole("table");
    const snare = within(kit).getByRole("rowheader", { name: "Snare" }).closest("tr")!;
    expect(snare).toHaveTextContent("38");
    expect(snare).toHaveTextContent("Space below the 2nd line");
    await expectNoA11yViolations();

    await user.click(screen.getByRole("button", { name: "Add track" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ kind: "drums", tuning: [] }));
  });

  it("adds any General MIDI instrument", async () => {
    const { user, onSubmit } = setup(null);
    await choose(user, "Instrument", "Other instrument (General MIDI)");
    await choose(user, "Sound (General MIDI)", "57. Trumpet");
    await user.clear(screen.getByRole("textbox", { name: "Name" }));
    await user.click(screen.getByRole("button", { name: "Add track" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "pitched", program: 56, name: "Track" }),
    );
  });
});

describe("TrackDialog: settings", () => {
  it("changes the name, sound, tuning and capo", async () => {
    const { user, onSubmit } = setup(GUITAR);

    expect(screen.getByRole("dialog", { name: "Track settings" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Instrument" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Sound (General MIDI)" })).toHaveTextContent(
      "30. Overdriven Guitar",
    );

    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Rhythm");
    await choose(user, "Tuning", /^Guitar Dropped D Tuning \(/);
    const capo = screen.getByRole("spinbutton", { name: "Capo" });
    await user.clear(capo);
    await user.type(capo, "3");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(onSubmit).toHaveBeenCalledWith({
      ...GUITAR,
      name: "Rhythm",
      tuning: [64, 59, 55, 50, 45, 38],
      capo: 3,
      keepPitches: true,
    });
  });

  it("can keep the fret numbers instead of the pitches when the tuning changes", async () => {
    const { user, onSubmit } = setup(GUITAR);
    const keep = screen.getByRole("checkbox", {
      name: "Keep the pitches of existing notes (move them to other frets)",
    });
    expect(keep).toBeChecked();
    await user.click(keep);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ keepPitches: false }));
  });

  it("does not offer to keep pitches when adding a track", () => {
    setup(null);
    expect(screen.queryByRole("checkbox", { name: /Keep the pitches/ })).not.toBeInTheDocument();
  });

  it("tunes single strings and adds strings", async () => {
    const { user, onSubmit } = setup(GUITAR);

    await user.click(screen.getByRole("button", { name: "Lower string 6" }));
    await user.click(screen.getByRole("button", { name: "Lower string 6" }));
    expect(screen.getByRole("status", { name: "String 6" })).toHaveTextContent("D2");
    expect(screen.getByRole("combobox", { name: "Tuning" })).toHaveTextContent(
      "Guitar Dropped D Tuning",
    );
    await user.click(screen.getByRole("button", { name: "Raise string 1" }));
    expect(screen.getByRole("combobox", { name: "Tuning" })).toHaveTextContent("Custom");

    await choose(user, "Strings", "7 strings");
    expect(screen.getByRole("status", { name: "String 7" })).toHaveTextContent("A1");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ tuning: [65, 59, 55, 50, 45, 38, 33] }),
    );
    await expectNoA11yViolations();
  });

  it("can be cancelled", async () => {
    const { user, onSubmit, onOpenChange } = setup(GUITAR);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("TrackDialog: extended-range guitars (#43)", () => {
  it("offers 3 to 10 strings", async () => {
    const { user } = setup(GUITAR);
    await user.click(screen.getByRole("combobox", { name: "Strings" }));
    const counts = screen.getAllByRole("option").map((o) => o.textContent);
    expect(counts).toEqual([
      "3 strings",
      "4 strings",
      "5 strings",
      "6 strings",
      "7 strings",
      "8 strings",
      "9 strings",
      "10 strings",
    ]);
  });

  it("adds a 9-string guitar with its standard tuning", async () => {
    const { user, onSubmit } = setup(null);
    await choose(user, "Instrument", "Guitar (9 strings)");
    expect(screen.getByRole("combobox", { name: "Strings" })).toHaveTextContent("9 strings");
    expect(screen.getByRole("combobox", { name: "Tuning" })).toHaveTextContent("C# standard");
    await user.click(screen.getByRole("button", { name: "Add track" }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        presetId: "guitar-9",
        tuning: [64, 59, 55, 50, 45, 40, 35, 30, 25],
      }),
    );
  });

  it("picks drop and low tunings for eight strings, then goes to ten", async () => {
    const { user, onSubmit } = setup({ ...GUITAR, tuning: [64, 59, 55, 50, 45, 40, 35, 30] });
    expect(screen.getByRole("combobox", { name: "Tuning" })).toHaveTextContent("F# standard");
    await choose(user, "Tuning", /^Drop E \(/);
    await choose(user, "Strings", "10 strings");
    // Each new string is a fourth lower than the one above: B0 (23), then F#0 (18).
    expect(screen.getByRole("status", { name: "String 10" })).toHaveTextContent("F#0");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ tuning: [64, 59, 55, 50, 45, 40, 35, 28, 23, 18] }),
    );
  });

  it("lists the drop tunings of metal on six strings", async () => {
    const { user } = setup(GUITAR);
    await user.click(screen.getByRole("combobox", { name: "Tuning" }));
    const names = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    for (const wanted of ["Dropped D", "Dropped C", "Drop B (", "Drop A# (", "Drop A ("]) {
      expect(
        names.some((n) => n.includes(wanted)),
        wanted,
      ).toBe(true);
    }
  });

  it("shows every preset tuning from the lowest string, as players say it (#119)", async () => {
    const { user } = setup(GUITAR);
    await user.click(screen.getByRole("combobox", { name: "Tuning" }));
    const names = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(names.some((n) => n.endsWith("(E A D G B E)"))).toBe(true);
    expect(names.some((n) => n.startsWith("Guitar Dropped D") && n.endsWith("(D A D G B E)"))).toBe(
      true,
    );
    expect(names.some((n) => n.endsWith("(E B G D A E)"))).toBe(false);
  });

  it("warns that very low strings sound thin, and stops when the tuning goes up", async () => {
    // An overdriven guitar (30) in the standard sound set, recorded from B2.
    const { user } = setup({ ...GUITAR, tuning: [64, 59, 55, 50, 45, 40, 35, 30] }, "sonivox");
    const warning = screen.getByTestId("low-sound-warning");
    expect(warning).toHaveTextContent("The lowest string (F#1)");
    expect(warning).toHaveTextContent("It will sound thin");
    expect(warning).toHaveTextContent("High quality");
    await expectNoA11yViolations();
    // A capo raises the lowest note: F#1 + 6 = C2, back inside the usual range.
    const capo = screen.getByRole("spinbutton", { name: "Capo" });
    await user.clear(capo);
    await user.type(capo, "6");
    expect(screen.queryByTestId("low-sound-warning")).not.toBeInTheDocument();
    await user.clear(capo);
    await user.type(capo, "0");
    expect(screen.getByTestId("low-sound-warning")).toBeInTheDocument();
    // Seven strings are fine: B1.
    await choose(user, "Strings", "7 strings");
    expect(screen.queryByTestId("low-sound-warning")).not.toBeInTheDocument();
  });

  it("does not warn without a sound set, for drums, or for a bass on its own sound", async () => {
    setup({ ...GUITAR, tuning: [64, 59, 55, 50, 45, 40, 35, 30] });
    expect(screen.queryByTestId("low-sound-warning")).not.toBeInTheDocument();
  });

  it("does not warn for a 5-string bass on the bass sound", () => {
    setup({ ...GUITAR, program: 33, tuning: [43, 38, 33, 28, 23] }, "sonivox");
    expect(screen.queryByTestId("low-sound-warning")).not.toBeInTheDocument();
  });
});
