import { screen } from "@testing-library/react";

import { SaveTargetDialog } from "@/components/save-target-dialog";
import { expectNoA11yViolations } from "@/test/axe";
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

  it("shows one card per connected drive, with the label above the name", async () => {
    renderWithProviders(
      <SaveTargetDialog
        open
        providers={[
          { provider: "dropbox", label: "Dropbox" },
          { provider: "onedrive", label: "OneDrive" },
        ]}
        onChoose={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Save to Dropbox" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save to OneDrive" })).toBeInTheDocument();
    expect(screen.queryByTestId("save-target-drive")).not.toBeInTheDocument();
    expect(screen.getByTestId("save-target-computer")).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("works with no connected drive and cancels", async () => {
    const onCancel = vi.fn();
    const { user } = renderWithProviders(
      <SaveTargetDialog open providers={[]} onChoose={vi.fn()} onCancel={onCancel} />,
    );

    expect(screen.queryByTestId("save-target-drive")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("save-target-cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("shows every provider; disabled ones are muted, named with their hint and not clickable", async () => {
    const onChoose = vi.fn();
    const { user } = renderWithProviders(
      <SaveTargetDialog
        mode="open"
        open
        providers={[
          { provider: "drive", label: "Google Drive" },
          { provider: "dropbox", label: "Dropbox", disabled: true, hint: "Not connected" },
          {
            provider: "onedrive",
            label: "OneDrive",
            disabled: true,
            hint: "Not available in this build",
          },
        ]}
        onChoose={onChoose}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByTestId("save-target-drive")).toBeEnabled();
    expect(screen.getByTestId("save-target-dropbox")).toBeDisabled();
    expect(screen.getByTestId("save-target-onedrive")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open from Dropbox, not connected" })).toBeDisabled();
    expect(screen.getByText("Not available in this build")).toBeInTheDocument();
    await user.click(screen.getByTestId("save-target-dropbox"));
    expect(onChoose).not.toHaveBeenCalled();
    await expectNoA11yViolations();
  });

  it("disables providers in save mode too", () => {
    renderWithProviders(
      <SaveTargetDialog
        open
        providers={[
          { provider: "dropbox", label: "Dropbox", disabled: true, hint: "Not connected" },
        ]}
        onChoose={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Save to Dropbox, not connected" })).toBeDisabled();
  });

  it("links to the cloud setup only when asked to", async () => {
    const onSetupCloud = vi.fn();
    const { user, rerender } = renderWithProviders(
      <SaveTargetDialog
        open
        providers={[]}
        onChoose={vi.fn()}
        onCancel={vi.fn()}
        onSetupCloud={onSetupCloud}
      />,
    );
    await user.click(screen.getByTestId("save-target-setup"));
    expect(onSetupCloud).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Set up cloud storage")).toBeInTheDocument();
    rerender(<SaveTargetDialog open providers={[]} onChoose={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByTestId("save-target-setup")).not.toBeInTheDocument();
  });
});
