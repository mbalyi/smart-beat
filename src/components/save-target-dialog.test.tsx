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

  it("says Open from… in open mode", async () => {
    const onChoose = vi.fn();
    const { user } = renderWithProviders(
      <SaveTargetDialog
        mode="open"
        open
        providers={[{ provider: "drive", label: "Google Drive" }]}
        onChoose={onChoose}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("Where is the song?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open from Google Drive" }));
    expect(onChoose).toHaveBeenCalledWith("drive");
    await user.click(screen.getByRole("button", { name: /Open from this computer/ }));
    expect(onChoose).toHaveBeenCalledWith("computer");
  });
});
