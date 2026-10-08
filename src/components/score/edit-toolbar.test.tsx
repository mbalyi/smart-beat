import { model } from "@coderline/alphatab";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { EditToolbar, type EditActions } from "@/components/score/edit-toolbar";
import type { BeatInfo } from "@/lib/score/editor";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const { Duration } = model;

const BEAT: BeatInfo = {
  duration: Duration.Quarter,
  dots: 0,
  tuplet: { numerator: 1, denominator: 1 },
  rest: false,
  notes: [{ string: 6, fret: 3, pitch: 67, tied: false }],
};

function setup(overrides: Partial<Parameters<typeof EditToolbar>[0]> = {}) {
  const actions: EditActions = {
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
    onDone: vi.fn(),
  };
  const props = {
    beat: BEAT,
    voice: 0,
    dots: () => "off" as const,
    tie: "off" as const,
    status: "Bar 1, beat 1 of 4, string 1 (E), fret 3, Quarter",
    message: "Fret 3 on string 1",
    actions,
    statusId: "status",
    ...overrides,
  };
  return { ...renderWithProviders(<EditToolbar {...props} />), actions };
}

describe("EditToolbar", () => {
  it("shows the beat under the cursor", async () => {
    setup();

    expect(screen.getByRole("toolbar", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Quarter" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Voice 1" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Dot" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Tie" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("combobox", { name: "Tuplet" })).toHaveTextContent("None");
    expect(screen.getByText(/fret 3, Quarter/)).toHaveAttribute("id", "status");
    expect(screen.getByRole("status")).toHaveTextContent("Fret 3 on string 1");
    await expectNoA11yViolations();
  });

  it("changes the rhythm and gives focus back to the score", async () => {
    const { user, actions } = setup({
      beat: { ...BEAT, dots: 1, notes: [{ ...BEAT.notes[0]!, tied: true }] },
      dots: (count) => (count === 1 ? "on" : "off"),
      tie: "on",
    });

    await user.click(screen.getByRole("radio", { name: "Eighth" }));
    await user.click(screen.getByRole("button", { name: "Double dot" }));
    await user.click(screen.getByRole("radio", { name: "Voice 2" }));
    await user.click(screen.getByRole("button", { name: "Rest" }));
    await user.click(screen.getByRole("button", { name: "Fill bar with rests" }));
    await user.click(screen.getByRole("button", { name: "Tie" }));
    await user.click(screen.getByRole("button", { name: "Insert beat" }));
    await user.click(screen.getByRole("button", { name: "Delete beat" }));

    expect(actions.onDuration).toHaveBeenCalledWith(Duration.Eighth);
    expect(actions.onDots).toHaveBeenCalledWith(2);
    expect(actions.onVoice).toHaveBeenCalledWith(1);
    expect(actions.onRest).toHaveBeenCalledOnce();
    expect(actions.onFillRests).toHaveBeenCalledOnce();
    expect(actions.onTie).toHaveBeenCalledOnce();
    expect(actions.onInsertBeat).toHaveBeenCalledOnce();
    expect(actions.onDeleteBeat).toHaveBeenCalledOnce();
    expect(actions.onDone).toHaveBeenCalledTimes(8);
    expect(screen.getByRole("button", { name: "Dot" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Tie" })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens the bar's settings", async () => {
    const { user, actions } = setup();
    await user.click(screen.getByRole("button", { name: "Bar…" }));
    expect(actions.onBar).toHaveBeenCalled();
  });

  it("chooses tuplets", async () => {
    const { user, actions } = setup();
    await user.click(screen.getByRole("combobox", { name: "Tuplet" }));
    await user.click(await screen.findByRole("option", { name: "Triplet (3:2)" }));
    expect(actions.onTuplet).toHaveBeenCalledWith(
      expect.objectContaining({ numerator: 3, denominator: 2 }),
    );
  });

  it("keeps focus where it was when a button is clicked", () => {
    setup();
    const quarter = screen.getByRole("radio", { name: "Quarter" });
    const event = fireEvent.mouseDown(quarter);
    expect(event).toBe(false); // default prevented: the score keeps focus
    expect(fireEvent.mouseDown(screen.getByRole("combobox", { name: "Tuplet" }))).toBe(true);
  });

  it("names every button and shows its shortcut in a tooltip", async () => {
    const { user } = setup();
    await user.hover(screen.getByRole("button", { name: "Dot" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Dot (.)");
  });

  it("draws notation icons with Bravura, every button the same size (#53)", () => {
    setup();
    expect(
      screen.getByRole("radio", { name: "Quarter" }).querySelector("[data-glyph]"),
    ).toHaveAttribute("data-glyph", "noteQuarterUp");
    expect(
      screen.getByRole("button", { name: "Rest" }).querySelector("[data-glyph]"),
    ).toHaveAttribute("data-glyph", "restQuarter");
    for (const button of screen
      .getAllByRole("button")
      .filter((b) => b.dataset.slot === "palette-button")) {
      expect(button.className).toContain("size-8");
      expect(button).toHaveAccessibleName();
    }
  });

  it("shows a selection where only some beats are dotted as mixed (#53)", () => {
    setup({ dots: (count) => (count === 1 ? "mixed" : "off"), tie: "mixed" });
    expect(screen.getByRole("button", { name: "Dot" })).toHaveAttribute("aria-pressed", "mixed");
    expect(screen.getByRole("button", { name: "Tie" })).toHaveAttribute("aria-pressed", "mixed");
    expect(screen.getByRole("button", { name: "Double dot" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});

describe("EditToolbar: nested tuplets (#43)", () => {
  it("opens the nested tuplet dialog from the tuplet menu and applies the combined ratio", async () => {
    const { user, actions } = setup();
    await user.click(screen.getByRole("combobox", { name: "Tuplet" }));
    await user.click(await screen.findByRole("option", { name: "Nested…" }));
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

  it("combines other ratios and shows the result before applying", async () => {
    const { user, actions } = setup();
    await user.click(screen.getByRole("combobox", { name: "Tuplet" }));
    await user.click(await screen.findByRole("option", { name: "Nested…" }));
    const dialog = await screen.findByRole("dialog", { name: "Nested tuplet" });
    await user.click(within(dialog).getByRole("combobox", { name: /^Inner tuplet/ }));
    await user.click(await screen.findByRole("option", { name: "Quintuplet (5:4)" }));
    expect(within(dialog).getByTestId("nested-tuplet-result")).toHaveTextContent(
      "15 notes in the time of 8 (15:8)",
    );
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(actions.onTuplet).toHaveBeenCalledWith({ numerator: 15, denominator: 8 });
  });

  it("refuses a combination with too many notes", async () => {
    const { user, actions } = setup();
    await user.click(screen.getByRole("combobox", { name: "Tuplet" }));
    await user.click(await screen.findByRole("option", { name: "Nested…" }));
    const dialog = await screen.findByRole("dialog", { name: "Nested tuplet" });
    for (const name of ["Outer tuplet", /^Inner tuplet/]) {
      await user.click(within(dialog).getByRole("combobox", { name }));
      await user.click(await screen.findByRole("option", { name: "13:8" }));
    }
    expect(within(dialog).getByTestId("nested-tuplet-result")).toHaveTextContent("too many notes");
    expect(within(dialog).getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(actions.onTuplet).not.toHaveBeenCalled();
  });

  it("cancelling changes nothing", async () => {
    const { user, actions } = setup();
    await user.click(screen.getByRole("combobox", { name: "Tuplet" }));
    await user.click(await screen.findByRole("option", { name: "Nested…" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Nested tuplet" })).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(actions.onTuplet).not.toHaveBeenCalled();
  });

  it("shows a nested ratio the list does not name under its own ratio", async () => {
    setup({ beat: { ...BEAT, tuplet: { numerator: 9, denominator: 4 } } });
    expect(screen.getByRole("combobox", { name: "Tuplet" })).toHaveTextContent("9:4");
  });
});
