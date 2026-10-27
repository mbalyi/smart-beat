import { screen } from "@testing-library/react";

import { SaveTargetDialog } from "@/components/save-target-dialog";
import { renderWithProviders } from "@/test/render";

describe("SaveTargetDialog", () => {
  it("offers this computer and each connected drive", async () => {
    const onChoose = vi.fn();
    const { user } = renderWithProviders(
      <SaveTargetDialog
        open
        providers={[{ provider: "drive", label: "Google Drive" }]}
        onChoose={onChoose}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save to Google Drive" }));
    expect(onChoose).toHaveBeenCalledWith("drive");
    await user.click(screen.getByRole("button", { name: /Save to this computer/ }));
    expect(onChoose).toHaveBeenCalledWith("computer");
  });
});
