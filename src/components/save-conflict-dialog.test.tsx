import { screen } from "@testing-library/react";

import { SaveConflictDialog } from "@/components/save-conflict-dialog";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function setup() {
  const onChoose = vi.fn();
  const onCancel = vi.fn();
  const utils = renderWithProviders(
    <SaveConflictDialog open fileName="riff.gp" onChoose={onChoose} onCancel={onCancel} />,
  );
  return { ...utils, onChoose, onCancel };
}

describe("SaveConflictDialog", () => {
  it("names the file and offers the three ways out", async () => {
    setup();

    const dialog = await screen.findByRole("dialog", { name: /riff\.gp.*changed on disk/ });
    expect(dialog).toHaveAttribute("data-testid", "save-conflict-dialog");
    expect(screen.getByTestId("conflict-copy")).toHaveAccessibleName("Save as a copy");
    expect(screen.getByTestId("conflict-reload")).toHaveAccessibleName("Reload from disk");
    expect(screen.getByTestId("conflict-cancel")).toHaveAccessibleName("Cancel");
  });

  it("reports the choice", async () => {
    const { user, onChoose, onCancel } = setup();

    await user.click(await screen.findByTestId("conflict-copy"));
    await user.click(screen.getByTestId("conflict-reload"));
    expect(onChoose.mock.calls).toEqual([["copy"], ["reload"]]);

    await user.click(screen.getByTestId("conflict-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("closes with Escape as a cancel", async () => {
    const { user, onCancel } = setup();
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");

    expect(onCancel).toHaveBeenCalled();
  });

  it("has no accessibility violations", async () => {
    setup();
    await screen.findByRole("dialog");
    await expectNoA11yViolations(document.body);
  });
});
