import { fireEvent, screen, within } from "@testing-library/react";

import { UpdateDialog } from "@/components/update-dialog";
import type { Updater, UpdaterState } from "@/hooks/use-updater";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const info = {
  currentVersion: "0.1.0",
  version: "0.2.0",
  notes: "### Added\n- Update dialog.\n- <b>Not markup</b>",
};

function renderDialog(state: UpdaterState, overrides: Partial<Updater> = {}) {
  const updater: Updater = {
    state,
    open: true,
    checkNow: vi.fn(),
    install: vi.fn(),
    dismiss: vi.fn(),
    ...overrides,
  };
  return { updater, ...renderWithProviders(<UpdateDialog updater={updater} />) };
}

describe("UpdateDialog", () => {
  it("shows both versions and the release notes of an available update", async () => {
    renderDialog({ status: "available", info });

    const dialog = screen.getByRole("dialog", { name: "Update available" });
    expect(within(dialog).getByText("Installed version")).toBeInTheDocument();
    expect(within(dialog).getByText("0.1.0")).toBeInTheDocument();
    expect(within(dialog).getByText("Available version")).toBeInTheDocument();
    expect(within(dialog).getByText("0.2.0")).toBeInTheDocument();
    const notes = within(dialog).getByRole("region", { name: "Release notes" });
    expect(notes).toHaveTextContent("- Update dialog.");
    // Notes are text, never markup.
    expect(notes.querySelector("b")).toBeNull();
    expect(notes).toHaveTextContent("<b>Not markup</b>");
    await expectNoA11yViolations();
  });

  it("offers Later and Download & Install, and installs only when asked", async () => {
    const { user, updater } = renderDialog({ status: "available", info });

    expect(updater.install).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Later" }));
    expect(updater.dismiss).toHaveBeenCalledOnce();
    expect(updater.install).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Download & Install" }));
    expect(updater.install).toHaveBeenCalledOnce();
  });

  it("says when a release has no notes", () => {
    renderDialog({ status: "available", info: { ...info, notes: "" } });
    expect(screen.getByText("No release notes were published for this version.")).toBeVisible();
  });

  it("closes with Escape while nothing is being installed", async () => {
    const { user, updater } = renderDialog({ status: "available", info });
    await user.keyboard("{Escape}");
    expect(updater.dismiss).toHaveBeenCalledOnce();
  });

  it("shows a labelled progress bar while downloading, and cannot be closed", async () => {
    const { user, updater } = renderDialog({
      status: "downloading",
      info,
      progress: { downloaded: 1024 * 1024, total: 4 * 1024 * 1024 },
    });

    const bar = screen.getByRole("progressbar", { name: "Download progress" });
    expect(bar).toHaveAttribute("value", String(1024 * 1024));
    expect(bar).toHaveAttribute("max", String(4 * 1024 * 1024));
    expect(screen.getByText("1.0 MB of 4.0 MB (25%)")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    fireEvent.pointerDown(document.body);
    expect(updater.dismiss).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("shows an indeterminate bar when the size is unknown", () => {
    renderDialog({ status: "downloading", info, progress: { downloaded: 2048, total: null } });
    const bar = screen.getByRole("progressbar", { name: "Download progress" });
    expect(bar).not.toHaveAttribute("value");
  });

  it("announces the installation", async () => {
    renderDialog({ status: "installing", info });
    expect(screen.getByRole("status")).toHaveTextContent("Installing version 0.2.0…");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("reports that the app is up to date, with its version", async () => {
    const { user, updater } = renderDialog({ status: "up-to-date", version: "0.1.0" });

    const dialog = screen.getByRole("dialog", { name: "You're up to date" });
    expect(dialog).toHaveTextContent("Smart Beat 0.1.0 is the latest version.");
    await expectNoA11yViolations();

    await user.click(within(dialog).getByText("Close", { selector: "button" }));
    expect(updater.dismiss).toHaveBeenCalled();
  });

  it("still says it is up to date when the version is unknown", () => {
    renderDialog({ status: "up-to-date", version: "" });
    expect(screen.getByText("You have the latest version of Smart Beat.")).toBeInTheDocument();
  });

  it("explains a failure and offers to try again", async () => {
    const { user, updater } = renderDialog({
      status: "error",
      message: "Could not fetch a valid release JSON.",
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Could not fetch a valid release JSON.");
    await expectNoA11yViolations();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(updater.checkNow).toHaveBeenCalledOnce();
  });

  it("says it is checking", async () => {
    renderDialog({ status: "checking" });
    expect(screen.getByRole("dialog", { name: "Checking for updates" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Checking…");
    await expectNoA11yViolations();
  });

  it("renders nothing while closed", () => {
    renderDialog({ status: "idle" }, { open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
