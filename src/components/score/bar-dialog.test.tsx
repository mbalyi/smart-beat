import { model } from "@coderline/alphatab";
import { screen } from "@testing-library/react";

import { BarDialog } from "@/components/score/bar-dialog";
import type { BarSettings } from "@/lib/score/structure";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const { Direction, KeySignatureType, TripletFeel } = model;

const SETTINGS: BarSettings = {
  timeSignature: { numerator: 4, denominator: 4 },
  tripletFeel: TripletFeel.NoTripletFeel,
  keySignature: 0,
  keyType: KeySignatureType.Major,
  tempo: null,
  section: "",
  repeatStart: false,
  repeatEnd: 0,
  endings: 0,
  directions: [],
};

function setup({
  barNumber = 3,
  initial = SETTINGS,
  warningsFor = (): string[] => [],
}: { barNumber?: number; initial?: BarSettings; warningsFor?: (d: BarSettings) => string[] } = {}) {
  const onSubmit = vi.fn();
  const onOpenChange = vi.fn();
  const utils = renderWithProviders(
    <BarDialog
      open
      onOpenChange={onOpenChange}
      barNumber={barNumber}
      initial={initial}
      currentTempo={96}
      warningsFor={warningsFor}
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

describe("BarDialog", () => {
  it("edits time and key signatures and the triplet feel", async () => {
    const { user, onSubmit, onOpenChange } = setup();
    expect(screen.getByRole("dialog", { name: "Bar 3" })).toBeInTheDocument();
    await expectNoA11yViolations();

    const beats = screen.getByRole("spinbutton", { name: "Beats per bar" });
    await user.clear(beats);
    await user.type(beats, "7");
    await choose(user, "Beat unit", "1/8 notes");
    await choose(user, "Key signature", /Bb major \/ G minor/);
    await user.click(screen.getByRole("radio", { name: "Minor" }));
    await choose(user, "Triplet feel", "Triplet 8th");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(onSubmit).toHaveBeenCalledWith({
      ...SETTINGS,
      timeSignature: { numerator: 7, denominator: 8 },
      keySignature: -2,
      keyType: KeySignatureType.Minor,
      tripletFeel: TripletFeel.Triplet8th,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("adds a tempo change with a label, and a section", async () => {
    const { user, onSubmit } = setup();
    const bpm = screen.getByRole("spinbutton", { name: "Beats per minute" });
    expect(bpm).toBeDisabled();
    expect(bpm).toHaveValue(96); // the tempo so far

    await user.click(screen.getByRole("checkbox", { name: "Tempo change at this bar" }));
    await user.clear(bpm);
    await user.type(bpm, "144");
    await user.type(screen.getByRole("textbox", { name: "Tempo text (optional)" }), "Presto");
    await user.type(screen.getByRole("textbox", { name: "Section name" }), " Solo ");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ tempo: { bpm: 144, label: "Presto" }, section: "Solo" }),
    );
  });

  it("always keeps the song's tempo on bar 1", async () => {
    const { user, onSubmit } = setup({
      barNumber: 1,
      initial: { ...SETTINGS, tempo: { bpm: 120, label: "" } },
    });
    const box = screen.getByRole("checkbox", { name: "Song tempo (bar 1)" });
    expect(box).toBeChecked();
    expect(box).toBeDisabled();
    const bpm = screen.getByRole("spinbutton", { name: "Beats per minute" });
    await user.clear(bpm);
    await user.type(bpm, "9999");
    // Out of range: the form's own validation keeps it open.
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSubmit).not.toHaveBeenCalled();
    await user.clear(bpm);
    await user.type(bpm, "200");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ tempo: { bpm: 200, label: "" } }),
    );
  });

  it("writes repeats, alternate endings and jumps", async () => {
    const { user, onSubmit } = setup();
    await user.click(screen.getByRole("checkbox", { name: "Repeat starts here" }));
    const times = screen.getByRole("spinbutton", { name: "Play" });
    expect(times).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Repeat ends here" }));
    await user.clear(times);
    await user.type(times, "3");
    await user.click(screen.getByRole("button", { name: "Pass 1" }));
    await user.click(screen.getByRole("button", { name: "Pass 3" }));
    await user.click(screen.getByRole("checkbox", { name: "Segno" }));
    await user.click(screen.getByRole("checkbox", { name: "D.S. al Coda" }));
    await user.click(screen.getByRole("checkbox", { name: "Segno" }));
    await user.click(screen.getByRole("checkbox", { name: "To Coda" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(onSubmit).toHaveBeenCalledWith({
      ...SETTINGS,
      repeatStart: true,
      repeatEnd: 3,
      endings: 0b101,
      directions: [Direction.JumpDalSegnoAlCoda, Direction.JumpDaCoda].sort((a, b) => a - b),
    });
  });

  it("shows warnings for the jumps being edited", async () => {
    const warningsFor = (draft: BarSettings) =>
      draft.directions.includes(Direction.JumpDalSegno) ? ["A D.S. jump has no Segno."] : [];
    const { user } = setup({ warningsFor });
    expect(screen.queryByText("A D.S. jump has no Segno.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "D.S." }));
    expect(screen.getByRole("status")).toHaveTextContent("A D.S. jump has no Segno.");
    await expectNoA11yViolations();
  });

  it("closes without changes on Cancel", async () => {
    const { user, onSubmit, onOpenChange } = setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
