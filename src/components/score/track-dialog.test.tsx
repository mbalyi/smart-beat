import { screen, within } from "@testing-library/react";

import { TrackDialog, type TrackSettings } from "@/components/score/track-dialog";
import { drumKitOf } from "@/lib/score/instrument-view";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const GUITAR: TrackSettings = {
  kind: "stringed",
  name: "Lead",
  program: 29,
  tuning: [64, 59, 55, 50, 45, 40],
  capo: 0,
};

function setup(initial: TrackSettings | null) {
  const onSubmit = vi.fn();
  const onOpenChange = vi.fn();
  const utils = renderWithProviders(
    <TrackDialog
      open
      onOpenChange={onOpenChange}
      initial={initial}
      drumKit={drumKitOf(null)}
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
    });
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
