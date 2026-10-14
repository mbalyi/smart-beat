import { fireEvent, screen, within } from "@testing-library/react";

import { ChordDialog, type ChordStrings } from "@/components/score/chord-dialog";
import { recognizeChord, type ChordDiagram, type ChordSpec } from "@/lib/score/chords";
import { STANDARD_GUITAR } from "@/lib/score/music";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const GUITAR: ChordStrings = { tuning: STANDARD_GUITAR, capo: 0 };

function setup({
  initial = null,
  strings = GUITAR,
  pitches = [],
  notesDiagram = null,
}: {
  initial?: ChordSpec | null;
  strings?: ChordStrings | null;
  pitches?: number[];
  notesDiagram?: ChordDiagram | null;
} = {}) {
  const onSubmit = vi.fn();
  const onOpenChange = vi.fn();
  const utils = renderWithProviders(
    <ChordDialog
      open
      onOpenChange={onOpenChange}
      initial={initial}
      strings={strings}
      suggestions={recognizeChord(pitches)}
      notesDiagram={notesDiagram}
      preferFlats={false}
      onSubmit={onSubmit}
    />,
  );
  return { ...utils, onSubmit, onOpenChange };
}

/** Picks a string's fret from its list (the keyboard route). The lists are long: allow time. */
const setString = async (user: ReturnType<typeof setup>["user"], name: RegExp, option: string) => {
  await user.click(screen.getByRole("combobox", { name }));
  await user.click(await screen.findByRole("option", { name: option }, { timeout: 5000 }));
};

/** The drawn diagram: the group of a string (0 = the lowest string, drawn on the left). */
const drawnString = (column: number) => {
  const groups = document.querySelectorAll("svg[aria-hidden='true'] g");
  return groups[groups.length - 1 - column]!;
};

describe("ChordDialog", () => {
  it("names the chord from the selected notes and starts from their diagram", async () => {
    // Open A minor: x 0 2 2 1 0.
    const diagram = { strings: [0, 1, 2, 2, 0, -1], firstFret: 1 };
    const { user, onSubmit } = setup({ pitches: [45, 52, 57, 60, 64], notesDiagram: diagram });
    expect(screen.getByRole("dialog", { name: "Chord" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Am");
    expect(screen.getByRole("button", { name: "Name it A minor" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "String 6 (E)" })).toHaveTextContent("Not played");
    expect(screen.getByRole("combobox", { name: "String 3 (G)" })).toHaveTextContent("Fret 2");
    // Lowest string first, as a chord shape is read (#119).
    const strings = within(screen.getByRole("list", { name: "Strings" })).getAllByRole("combobox");
    expect(strings.map((s) => s.getAttribute("aria-label"))).toEqual([
      "String 6 (E)",
      "String 5 (A)",
      "String 4 (D)",
      "String 3 (G)",
      "String 2 (B)",
      "String 1 (E)",
    ]);
    await expectNoA11yViolations();

    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSubmit).toHaveBeenCalledWith({ name: "Am", diagram, showDiagram: true });
  });

  it(
    "edits the diagram string by string and suggests names for it",
    { timeout: 20_000 },
    async () => {
      const { user, onSubmit } = setup();
      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled(); // no name yet
      // E minor: 0 2 2 0 0 0. Two strings from their lists, the rest on the drawing.
      await setString(user, /String 5/, "Fret 2");
      await setString(user, /String 1/, "Open");
      fireEvent.click(drawnString(2).querySelectorAll("rect")[1]!); // D string, fret 2
      for (const column of [0, 3, 4]) fireEvent.click(drawnString(column).querySelector("text")!);
      expect(screen.getByRole("combobox", { name: /String 4/ })).toHaveTextContent("Fret 2");
      await user.click(screen.getByRole("button", { name: "Name it E minor" }));
      await user.click(screen.getByRole("checkbox", { name: "Show the diagram" }));
      await user.click(screen.getByRole("button", { name: "Apply" }));

      expect(onSubmit).toHaveBeenCalledWith({
        name: "Em",
        diagram: { strings: [0, 0, 0, 2, 2, 0], firstFret: 1 },
        showDiagram: false,
      });
    },
  );

  it("moves the diagram up the neck for high chords", { timeout: 20_000 }, async () => {
    const { user } = setup();
    await setString(user, /String 5/, "Fret 7");
    expect(screen.getByRole("spinbutton", { name: "First fret shown" })).toHaveValue(7);
  });

  it("presses frets on the drawn diagram", async () => {
    const { user } = setup({ initial: null });
    const lowString = drawnString(0);
    fireEvent.click(lowString.querySelectorAll("rect")[2]!); // fret 3
    expect(screen.getByRole("combobox", { name: /String 6/ })).toHaveTextContent("Fret 3");
    fireEvent.click(lowString.querySelectorAll("rect")[2]!); // again: lifted
    expect(screen.getByRole("combobox", { name: /String 6/ })).toHaveTextContent("Not played");
    fireEvent.click(lowString.querySelector("text")!); // above the nut: open
    expect(screen.getByRole("combobox", { name: /String 6/ })).toHaveTextContent("Open");
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByRole("combobox", { name: /String 6/ })).toHaveTextContent("Not played");
  });

  it("changes and removes an existing chord", async () => {
    const initial = {
      name: "G",
      diagram: { strings: [3, 0, 0, 0, 2, 3], firstFret: 1 },
      showDiagram: true,
    };
    const { user, onSubmit } = setup({ initial });
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("G");
    await user.click(screen.getByRole("button", { name: "Remove chord" }));
    expect(onSubmit).toHaveBeenCalledWith(null);
  });

  it("names chords on tracks without strings (no diagram)", async () => {
    const { user, onSubmit } = setup({ strings: null, pitches: [60, 64, 67, 70] });
    expect(screen.queryByRole("group", { name: "Diagram" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("C7");
    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "C7(no5)");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSubmit).toHaveBeenCalledWith({ name: "C7(no5)", diagram: null, showDiagram: false });
    await expectNoA11yViolations();
  });
});
