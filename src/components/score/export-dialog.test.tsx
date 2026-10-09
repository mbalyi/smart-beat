import { screen, within } from "@testing-library/react";

import { ExportDialog } from "@/components/score/export-dialog";
import { exportGroups } from "@/lib/export/choices";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function setup(opts = { m4a: true, pdf: true }) {
  const onChoose = vi.fn();
  const onOpenChange = vi.fn();
  return {
    ...renderWithProviders(
      <ExportDialog
        open
        onOpenChange={onOpenChange}
        groups={exportGroups(opts)}
        onChoose={onChoose}
      />,
    ),
    onChoose,
    onOpenChange,
  };
}

describe("ExportDialog", () => {
  it("lists the formats with their extensions, GP5 included", async () => {
    setup();
    const dialog = await screen.findByRole("dialog", { name: "Export" });
    const gp5 = within(dialog).getByRole("button", { name: /Guitar Pro 5/ });
    expect(gp5).toHaveTextContent(".gp5");
    expect(within(dialog).getAllByRole("button").length).toBeGreaterThan(10);
    await expectNoA11yViolations();
  });

  it("hides M4A and PDF where they can't be written", async () => {
    setup({ m4a: false, pdf: false });
    await screen.findByRole("dialog", { name: "Export" });
    expect(screen.queryByRole("button", { name: /M4A/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /PDF/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /WAV/ })).toBeInTheDocument();
  });

  it("closes and hands over the picked format", async () => {
    const { user, onChoose, onOpenChange } = setup();
    await user.click(await screen.findByRole("button", { name: /Guitar Pro 5/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ id: "gp5", target: { kind: "format", format: "gp5" } }),
    );
  });
});
