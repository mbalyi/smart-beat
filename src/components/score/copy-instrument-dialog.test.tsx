import { screen } from "@testing-library/react";

import { CopyInstrumentDialog } from "@/components/score/copy-instrument-dialog";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function setup() {
  const onSubmit = vi.fn();
  const onOpenChange = vi.fn();
  const utils = renderWithProviders(
    <CopyInstrumentDialog open onOpenChange={onOpenChange} trackName="Lead" onSubmit={onSubmit} />,
  );
  return { ...utils, onSubmit, onOpenChange };
}

describe("CopyInstrumentDialog", () => {
  it("copies to the chosen instrument and is accessible", async () => {
    const { user, onSubmit, onOpenChange } = setup();
    expect(screen.getByRole("dialog", { name: "Copy to instrument" })).toBeInTheDocument();
    await expectNoA11yViolations();

    await user.click(screen.getByRole("combobox", { name: "Instrument" }));
    expect(screen.queryByRole("option", { name: "Drums" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "Bass (4 strings)" }));
    await user.click(screen.getByRole("button", { name: "Copy track" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ id: "bass-4" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("can be cancelled", async () => {
    const { user, onSubmit, onOpenChange } = setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
