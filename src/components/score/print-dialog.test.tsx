import { screen, within } from "@testing-library/react";

import { PrintDialog } from "@/components/score/print-dialog";
import { DEFAULT_PRINT } from "@/lib/print";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function setup() {
  const onSubmit = vi.fn();
  const onOpenChange = vi.fn();
  const utils = renderWithProviders(
    <PrintDialog
      open
      onOpenChange={onOpenChange}
      initial={DEFAULT_PRINT}
      trackName="Guitar"
      onSubmit={onSubmit}
    />,
  );
  return {
    ...utils,
    dialog: screen.getByRole("dialog", { name: "Print or save as PDF" }),
    onSubmit,
    onOpenChange,
  };
}

describe("PrintDialog", () => {
  it("names the track that is printed and explains how to get a PDF", async () => {
    const { dialog } = setup();
    expect(dialog).toHaveTextContent("“Guitar”");
    expect(dialog).toHaveTextContent("Save as PDF");
    expect(within(dialog).getByRole("combobox", { name: "Paper size" })).toHaveTextContent("A4");
    expect(within(dialog).getByRole("combobox", { name: "Orientation" })).toHaveTextContent(
      "Portrait",
    );
    expect(within(dialog).getByRole("combobox", { name: "Margins" })).toHaveTextContent("15 mm");
    await expectNoA11yViolations();
  });

  it("prints with the chosen page settings", async () => {
    const { user, dialog, onSubmit, onOpenChange } = setup();

    await user.click(within(dialog).getByRole("combobox", { name: "Paper size" }));
    await user.click(await screen.findByRole("option", { name: "Letter" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Orientation" }));
    await user.click(await screen.findByRole("option", { name: "Landscape" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Margins" }));
    await user.click(await screen.findByRole("option", { name: "10 mm" }));
    await user.click(within(dialog).getByRole("button", { name: "Print…" }));

    expect(onSubmit).toHaveBeenCalledWith({
      paper: "letter",
      orientation: "landscape",
      margin: 10,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("cancels without printing", async () => {
    const { user, dialog, onSubmit, onOpenChange } = setup();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
