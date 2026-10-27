import { screen } from "@testing-library/react";

import { LeaveDialog } from "@/components/leave-dialog";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function renderDialog(songNames: string[]) {
  const onSave = vi.fn();
  const onKeep = vi.fn();
  const onCancel = vi.fn();
  const utils = renderWithProviders(
    <LeaveDialog songNames={songNames} open onSave={onSave} onKeep={onKeep} onCancel={onCancel} />,
  );
  return { ...utils, onSave, onKeep, onCancel };
}

describe("LeaveDialog", () => {
  it("names the song with unsaved changes and focuses Save", async () => {
    renderDialog(["Riff"]);

    const dialog = screen.getByRole("alertdialog", { name: "Save your changes?" });
    expect(dialog).toHaveTextContent("“Riff” has unsaved changes.");
    expect(dialog).toHaveTextContent(
      "Save them now, or go to the start screen and keep them open to save later.",
    );
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
    await expectNoA11yViolations();
  });

  it("names every song and offers Save all", () => {
    renderDialog(["Riff", "Solo"]);
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "These songs have unsaved changes: “Riff”, “Solo”.",
    );
    expect(screen.getByRole("button", { name: "Save all" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("Save calls only onSave", async () => {
    const { user, onSave, onKeep, onCancel } = renderDialog(["Riff"]);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onKeep).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Not now calls only onKeep", async () => {
    const { user, onSave, onKeep, onCancel } = renderDialog(["Riff"]);
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(onKeep).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Cancel and Escape call only onCancel", async () => {
    const { user, onSave, onKeep, onCancel } = renderDialog(["Riff"]);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onSave).not.toHaveBeenCalled();
    expect(onKeep).not.toHaveBeenCalled();
  });
});
