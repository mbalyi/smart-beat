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
      trackNames={["Guitar", "Bass", "Drums"]}
      shownTrack={0}
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

    await user.click(within(dialog).getByRole("combobox", { name: "Notation size" }));
    await user.click(await screen.findByRole("option", { name: "125%" }));
    await user.click(within(dialog).getByRole("button", { name: "Print…" }));

    expect(onSubmit).toHaveBeenCalledWith(
      { paper: "letter", orientation: "landscape", margin: 10, scale: 1.25 },
      [0],
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("cancels without printing", async () => {
    const { user, dialog, onSubmit, onOpenChange } = setup();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("prints all tracks, or the chosen ones", async () => {
    const { user, dialog, onSubmit } = setup();
    await user.click(within(dialog).getByRole("radio", { name: /All 3 tracks/ }));
    await user.click(within(dialog).getByRole("button", { name: "Print…" }));
    expect(onSubmit).toHaveBeenLastCalledWith(DEFAULT_PRINT, [0, 1, 2]);
  });

  it("needs at least one chosen track", async () => {
    const { user, dialog, onSubmit } = setup();
    await user.click(within(dialog).getByRole("radio", { name: "Choose tracks…" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Guitar" }));
    expect(within(dialog).getByRole("button", { name: "Print…" })).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: "Drums" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Bass" }));
    await user.click(within(dialog).getByRole("button", { name: "Print…" }));
    expect(onSubmit).toHaveBeenLastCalledWith(DEFAULT_PRINT, [1, 2]);
    await expectNoA11yViolations();
  });
});

describe("PrintDialog: Export as PDF (#83)", () => {
  it("offers Export as PDF where the app can save it, and closes", async () => {
    const onExportPdf = vi.fn();
    const onOpenChange = vi.fn();
    const { user } = renderWithProviders(
      <PrintDialog
        open
        onOpenChange={onOpenChange}
        initial={DEFAULT_PRINT}
        trackNames={["Guitar", "Bass"]}
        shownTrack={1}
        onSubmit={vi.fn()}
        onExportPdf={onExportPdf}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Print or save as PDF" });
    expect(dialog).toHaveTextContent("Export as PDF saves a PDF file where you choose");
    await user.click(within(dialog).getByRole("button", { name: "Export as PDF…" }));
    expect(onExportPdf).toHaveBeenCalledWith(DEFAULT_PRINT, [1]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("explains the system dialog's PDF option elsewhere", () => {
    const { dialog } = setup();
    expect(within(dialog).queryByRole("button", { name: "Export as PDF…" })).toBeNull();
    expect(dialog).toHaveTextContent("Microsoft Print to PDF");
  });
});
