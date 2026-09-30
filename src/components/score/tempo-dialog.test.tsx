import { screen, within } from "@testing-library/react";

import { TempoDialog, type TempoInitial } from "@/components/score/tempo-dialog";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const INITIAL: TempoInitial = { bpm: 100, barCount: 8, bar: 3, endBar: 3, beats: 4 };

function setup(initial: Partial<TempoInitial> = {}) {
  const onSubmit = vi.fn();
  const onOpenChange = vi.fn();
  const utils = renderWithProviders(
    <TempoDialog
      open
      onOpenChange={onOpenChange}
      initial={{ ...INITIAL, ...initial }}
      onSubmit={onSubmit}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Tempo" });
  return { ...utils, dialog, onSubmit, onOpenChange };
}

async function typeInto(user: ReturnType<typeof setup>["user"], field: HTMLElement, text: string) {
  await user.clear(field);
  await user.type(field, text);
}

describe("TempoDialog", () => {
  it("starts from the current tempo and offers the three ways to apply it", async () => {
    const { dialog } = setup();

    expect(within(dialog).getByRole("spinbutton", { name: "Tempo" })).toHaveValue(100);
    expect(within(dialog).getAllByRole("radio")).toHaveLength(3);
    expect(within(dialog).getByRole("radio", { name: /From a bar and beat/ })).toBeChecked();
    expect(within(dialog).getByRole("spinbutton", { name: "Bar" })).toHaveValue(3);
    await expectNoA11yViolations();
  });

  it("sets the tempo of the whole song, with decimals", async () => {
    const { user, dialog, onSubmit, onOpenChange } = setup();

    await user.click(within(dialog).getByRole("radio", { name: /The whole song/ }));
    await typeInto(user, within(dialog).getByRole("spinbutton", { name: "Tempo" }), "92.5");
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    expect(onSubmit).toHaveBeenCalledWith({ scope: "song", bpm: 92.5 });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("sets a change at a bar and beat (counted from 1 in the dialog, from 0 in the request)", async () => {
    const { user, dialog, onSubmit } = setup();

    await typeInto(user, within(dialog).getByRole("spinbutton", { name: "Bar" }), "5");
    await typeInto(user, within(dialog).getByRole("spinbutton", { name: "Beat" }), "3");
    await typeInto(user, within(dialog).getByRole("spinbutton", { name: "Tempo" }), "80");
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    expect(onSubmit).toHaveBeenCalledWith({ scope: "from", bar: 4, beat: 2, bpm: 80 });
  });

  it("sets a tempo for a range of bars, starting with the selection", async () => {
    const { user, dialog, onSubmit } = setup({ bar: 2, endBar: 4 });

    expect(within(dialog).getByRole("radio", { name: /Only some bars/ })).toBeChecked();
    expect(within(dialog).getByRole("spinbutton", { name: "From bar" })).toHaveValue(2);
    expect(within(dialog).getByRole("spinbutton", { name: "To bar" })).toHaveValue(4);
    await typeInto(user, within(dialog).getByRole("spinbutton", { name: "Tempo" }), "60");
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    expect(onSubmit).toHaveBeenCalledWith({ scope: "range", from: 1, to: 3, bpm: 60 });
  });

  it("refuses tempos outside 10 to 400 BPM", async () => {
    const { user, dialog, onSubmit } = setup();
    const tempo = within(dialog).getByRole("spinbutton", { name: "Tempo" });

    await typeInto(user, tempo, "5");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("10 to 400 BPM");
    expect(within(dialog).getByRole("button", { name: "Apply" })).toBeDisabled();
    await typeInto(user, tempo, "401");
    expect(within(dialog).getByRole("button", { name: "Apply" })).toBeDisabled();
    await user.clear(tempo);
    expect(within(dialog).getByRole("button", { name: "Apply" })).toBeDisabled();

    await typeInto(user, tempo, "400");
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ bpm: 400 }));
  });

  it("cancels without changing anything", async () => {
    const { user, dialog, onSubmit, onOpenChange } = setup();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
