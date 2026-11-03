import { emit } from "@tauri-apps/api/event";
import { screen, waitFor, within } from "@testing-library/react";

import { OpenStemsDialog } from "@/components/stems/open-stems-dialog";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { backend, mockTauri } from "@/test/tauri";

const MB = 1024 * 1024;
const stems = (name: string, placeholder = false, size = 82 * MB) => ({
  name: `${name}.sbstems`,
  path: `/cloud/${name}.sbstems`,
  size,
  modified_ms: 1,
  placeholder,
});

function setup({
  cloudFolder = null as string | null,
  files = [] as ReturnType<typeof stems>[],
} = {}) {
  const calls = mockTauri();
  backend.cloudFolder = cloudFolder;
  backend.cloudStems = files;
  const onOpenChange = vi.fn();
  const onPickComputer = vi.fn();
  const onOpenStem = vi.fn();
  const onSetupCloud = vi.fn();
  const ui = renderWithProviders(
    <OpenStemsDialog
      open
      onOpenChange={onOpenChange}
      onPickComputer={onPickComputer}
      onOpenStem={onOpenStem}
      onSetupCloud={onSetupCloud}
    />,
  );
  return { ...ui, calls, onOpenChange, onPickComputer, onOpenStem, onSetupCloud };
}

const dialog = () => screen.getByRole("dialog");
const computer = () => screen.getByRole("button", { name: "Open from this computer" });
const cloud = () => screen.findByRole("button", { name: "Open from Cloud folder · Dropbox" });

describe("Open stems dialog", () => {
  it("offers this computer first and a Set up cloud storage card when no folder is linked", async () => {
    const { user, onOpenChange, onSetupCloud } = setup();
    const setUp = await screen.findByRole("button", { name: "Set up Cloud storage" });
    expect(
      computer().compareDocumentPosition(setUp) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Open from Cloud folder/ })).toBeNull();
    // Only the corner X closes it: no footer, no Cancel button.
    expect(dialog().querySelector('[data-slot="dialog-footer"]')).toBeNull();
    await expectNoA11yViolations(dialog());

    await user.click(setUp);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSetupCloud).toHaveBeenCalledOnce();
  });

  it("closes first and then asks for the native file dialog from this computer", async () => {
    const { user, onOpenChange, onPickComputer } = setup();
    await user.click(computer());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onPickComputer).toHaveBeenCalledOnce();
    expect(onOpenChange.mock.invocationCallOrder[0]!).toBeLessThan(
      onPickComputer.mock.invocationCallOrder[0]!,
    );
  });

  it("shows the linked cloud folder second", async () => {
    setup({ cloudFolder: "/Users/me/Dropbox" });
    const folder = await cloud();
    expect(folder).toHaveAccessibleDescription(/on any of your computers/);
    expect(screen.queryByRole("button", { name: "Set up Cloud storage" })).toBeNull();
    expect(
      computer().compareDocumentPosition(folder) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await expectNoA11yViolations(dialog());
  });

  it("lists the saved stems of the cloud folder and opens one after closing", async () => {
    const { user, onOpenChange, onOpenStem } = setup({
      cloudFolder: "/Users/me/Dropbox",
      files: [stems("Neon Nights"), stems("Blue Hour", false, 5 * MB)],
    });
    await user.click(await cloud());

    expect(
      await screen.findByRole("heading", { name: "Open from Cloud folder · Dropbox" }),
    ).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "Saved stems in your cloud folder" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Blue Hour/ })).toHaveTextContent("5 MB");
    await expectNoA11yViolations(dialog());

    await user.click(screen.getByRole("button", { name: /Neon Nights/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenStem).toHaveBeenCalledWith("/cloud/Neon Nights.sbstems");
  });

  it("marks an online-only file as waiting for download, then downloading", async () => {
    const { user } = setup({
      cloudFolder: "/Users/me/Dropbox",
      files: [stems("Far Away", true), stems("Here")],
    });
    await user.click(await cloud());

    const waiting = await screen.findByRole("button", { name: /Far Away/ });
    expect(waiting).toHaveTextContent("Waiting for download");
    expect(waiting).toHaveAttribute("data-placeholder", "true");
    expect(screen.getByRole("button", { name: /Here/ })).not.toHaveTextContent(/waiting/i);
    await expectNoA11yViolations(dialog());

    await emit("cloud-download-waiting", "/cloud/Far Away.sbstems");
    await waitFor(() => expect(waiting).toHaveTextContent("Downloading…"));
  });

  it("says when the folder holds no saved stems yet, and goes back to the choice", async () => {
    const { user } = setup({ cloudFolder: "/Users/me/Dropbox" });
    await user.click(await cloud());
    expect(await screen.findByText(/No saved stems in your cloud folder yet/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(computer()).toBeInTheDocument();
  });

  it("shows an unreadable folder as an alert and retries", async () => {
    let fail = true;
    const calls = mockTauri({
      list_cloud_stems: () => {
        if (fail) throw { kind: "not-found", message: "The cloud folder could not be found." };
        return [stems("Neon Nights")];
      },
    });
    backend.cloudFolder = "/Users/me/Dropbox";
    const { user } = renderWithProviders(
      <OpenStemsDialog
        open
        onOpenChange={vi.fn()}
        onPickComputer={vi.fn()}
        onOpenStem={vi.fn()}
        onSetupCloud={vi.fn()}
      />,
    );
    await user.click(await cloud());
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be found");
    await expectNoA11yViolations(dialog());

    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: /Neon Nights/ })).toBeInTheDocument();
    expect(calls.filter((call) => call.cmd === "list_cloud_stems")).toHaveLength(2);
  });

  it("starts at the choice again each time it opens", async () => {
    const ui = setup({ cloudFolder: "/Users/me/Dropbox", files: [stems("Neon Nights")] });
    await ui.user.click(await cloud());
    await screen.findByRole("button", { name: /Neon Nights/ });
    ui.rerender(
      <OpenStemsDialog
        open={false}
        onOpenChange={vi.fn()}
        onPickComputer={vi.fn()}
        onOpenStem={vi.fn()}
        onSetupCloud={vi.fn()}
      />,
    );
    ui.rerender(
      <OpenStemsDialog
        open
        onOpenChange={vi.fn()}
        onPickComputer={vi.fn()}
        onOpenStem={vi.fn()}
        onSetupCloud={vi.fn()}
      />,
    );
    expect(computer()).toBeInTheDocument();
  });
});
