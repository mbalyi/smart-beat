import { screen } from "@testing-library/react";

import { LeaveDialog } from "@/components/leave-dialog";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function renderDialog(songNames: string[]) {
  const onCancel = vi.fn();
  const onLeave = vi.fn();
  const utils = renderWithProviders(
    <LeaveDialog songNames={songNames} open onCancel={onCancel} onLeave={onLeave} />,
  );
  return { ...utils, onCancel, onLeave };
}

describe("LeaveDialog", () => {
  it("names the song with unsaved changes and offers to stay or leave", async () => {
    const { user, onCancel, onLeave } = renderDialog(["Riff"]);

    expect(screen.getByRole("alertdialog", { name: "Leave without saving?" })).toHaveTextContent(
      "“Riff” has unsaved changes.",
    );
    await expectNoA11yViolations();

    await user.click(screen.getByRole("button", { name: "Stay here" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("names every song with unsaved changes", () => {
    renderDialog(["Riff", "Solo"]);
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "These songs have unsaved changes: “Riff”, “Solo”.",
    );
  });

  it("leaves only when asked to", async () => {
    const { user, onLeave } = renderDialog(["Riff"]);
    await user.click(screen.getByRole("button", { name: "Leave without saving" }));
    expect(onLeave).toHaveBeenCalledOnce();
  });
});
