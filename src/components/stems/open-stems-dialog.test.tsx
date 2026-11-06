import { emit } from "@tauri-apps/api/event";
import { act, screen, waitFor, within } from "@testing-library/react";

import { OpenStemsDialog } from "@/components/stems/open-stems-dialog";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { backend, mockTauri, STEM_SONG } from "@/test/tauri";

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
  accounts = [] as typeof backend.cloudAccounts,
  driveStems = {} as typeof backend.driveStems,
  overrides = {} as Parameters<typeof mockTauri>[0],
  withAccounts = true,
} = {}) {
  const calls = mockTauri(overrides);
  backend.cloudFolder = cloudFolder;
  backend.cloudStems = files;
  backend.cloudAccounts = accounts;
  backend.driveStems = driveStems;
  const onOpenChange = vi.fn();
  const onPickComputer = vi.fn();
  const onOpenStem = vi.fn();
  const onSetupCloud = vi.fn();
  const onOpenedSong = vi.fn();
  const ui = renderWithProviders(
    <OpenStemsDialog
      open
      onOpenChange={onOpenChange}
      onPickComputer={onPickComputer}
      onOpenStem={onOpenStem}
      onSetupCloud={onSetupCloud}
      onOpenedSong={withAccounts ? onOpenedSong : undefined}
    />,
  );
  return { ...ui, calls, onOpenChange, onPickComputer, onOpenStem, onSetupCloud, onOpenedSong };
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

const ACCOUNTS = [
  { provider: "drive", label: "Google Drive", account: "me@example.com" },
  { provider: "onedrive", label: "OneDrive", account: "smart-beat@outlook.com" },
  { provider: "dropbox", label: "Dropbox", account: null },
];
const remote = (name: string, id: string, size = 80 * MB, modified_ms = 1_790_000_000_000) => ({
  id,
  name: `${name}.sbstems`,
  revision: "r1",
  size,
  modified_ms,
});
const fromDrive = () => screen.findByRole("button", { name: "Open from Google Drive" });

describe("Open stems dialog: connected accounts", () => {
  it("offers a card for each connected account after this computer, before the cloud folder", async () => {
    setup({ accounts: ACCOUNTS, cloudFolder: "/Users/me/Dropbox" });
    const drive = await fromDrive();
    const onedrive = screen.getByRole("button", { name: "Open from OneDrive" });
    const folder = await cloud();
    expect(drive).toHaveAccessibleDescription("me@example.com");
    expect(screen.queryByRole("button", { name: "Open from Dropbox" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Set up Cloud storage" })).toBeNull();
    const before = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(computer(), drive)).toBe(true);
    expect(before(drive, onedrive)).toBe(true);
    expect(before(onedrive, folder)).toBe(true);
    await expectNoA11yViolations(dialog());
  });

  it("has no Set up card when an account is connected, even with no folder", async () => {
    setup({ accounts: ACCOUNTS });
    await fromDrive();
    expect(screen.queryByRole("button", { name: "Set up Cloud storage" })).toBeNull();
  });

  it("keeps the Set up card with no account and no folder", async () => {
    setup({ accounts: [ACCOUNTS[2]!] });
    expect(await screen.findByRole("button", { name: "Set up Cloud storage" })).toBeEnabled();
  });

  it("does not offer accounts when the page cannot show a song that comes back", async () => {
    setup({ accounts: ACCOUNTS, withAccounts: false });
    expect(await screen.findByRole("button", { name: "Set up Cloud storage" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Open from Google Drive" })).toBeNull();
  });

  it("lists the .sbstems files of an account, newest first, and goes back", async () => {
    const { user, calls } = setup({
      accounts: ACCOUNTS,
      driveStems: {
        drive: [
          remote("Older", "drive:a", 50 * MB, 1_700_000_000_000),
          remote("Newer", "drive:b", 90 * MB, 1_790_000_000_000),
        ],
      },
    });
    await user.click(await fromDrive());
    expect(calls).toContainEqual({ cmd: "cloud_list_stems", args: { provider: "drive" } });
    const list = await screen.findByRole("list", { name: "Saved stems in Google Drive" });
    const rows = within(list).getAllByTestId("drive-stem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Newer"),
      expect.stringContaining("Older"),
    ]);
    expect(rows[0]).toHaveTextContent("90 MB");
    expect(screen.queryByText(/\.sbstems/)).toBeNull();
    await expectNoA11yViolations(dialog());

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await fromDrive()).toBeInTheDocument();
  });

  it("says when the account holds no saved stems", async () => {
    const { user } = setup({ accounts: ACCOUNTS });
    await user.click(await fromDrive());
    expect(await screen.findByText(/No saved stems in Google Drive yet/)).toBeInTheDocument();
  });

  it("shows loading, then a reconnect message as an alert, and retries", async () => {
    let fails = true;
    const { user } = setup({
      accounts: ACCOUNTS,
      overrides: {
        cloud_list_stems: () => {
          if (fails) throw { kind: "auth-expired", message: "The sign-in expired." };
          return [remote("Zeta", "drive:z")];
        },
      },
    });
    await user.click(await fromDrive());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Reconnect Google Drive in Settings",
    );
    await expectNoA11yViolations(dialog());

    fails = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: /Zeta/ })).toBeInTheDocument();
  });

  it("downloads and opens a file with progress, then hands the song over and closes", async () => {
    let finish!: (song: unknown) => void;
    const { user, calls, onOpenChange, onOpenedSong } = setup({
      accounts: ACCOUNTS,
      driveStems: { drive: [remote("Neon Nights", "drive:abc")] },
      overrides: {
        stems_cloud_open: async () => {
          await emit("stems-bundle-progress", { stage: "downloading", fraction: 0.3 });
          return new Promise((resolve) => (finish = resolve));
        },
      },
    });
    await user.click(await fromDrive());
    await user.click(await screen.findByTestId("drive-stem"));

    expect(calls).toContainEqual({
      cmd: "stems_cloud_open",
      args: { request: { item: "drive:abc" } },
    });
    expect(await screen.findByText("Downloading…")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Open progress" });
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "30"));
    // The list is replaced by the progress, Back is disabled and Cancel is offered.
    expect(screen.queryByTestId("drive-stem")).toBeNull();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await expectNoA11yViolations(dialog());

    await act(() => emit("stems-bundle-progress", { stage: "reading", fraction: 0.5 }));
    expect(await screen.findByText("Opening…")).toBeInTheDocument();

    await act(async () => finish({ ...STEM_SONG, savedPath: "drive:abc" }));
    expect(onOpenedSong).toHaveBeenCalledWith(expect.objectContaining({ id: STEM_SONG.id }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not close while a file is downloading", async () => {
    const { user, onOpenChange } = setup({
      accounts: ACCOUNTS,
      driveStems: { drive: [remote("Neon Nights", "drive:abc")] },
      overrides: { stems_cloud_open: () => new Promise(() => {}) },
    });
    await user.click(await fromDrive());
    await user.click(await screen.findByTestId("drive-stem"));
    await screen.findByRole("progressbar", { name: "Open progress" });
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("stops with Cancel, without an error, and shows the list again", async () => {
    let fail!: (error: unknown) => void;
    const { user, calls } = setup({
      accounts: ACCOUNTS,
      driveStems: { drive: [remote("Neon Nights", "drive:abc")] },
      overrides: { stems_cloud_open: () => new Promise((_, reject) => (fail = reject)) },
    });
    await user.click(await fromDrive());
    await user.click(await screen.findByTestId("drive-stem"));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(calls.some((call) => call.cmd === "stems_cancel")).toBe(true);

    await act(async () => fail({ kind: "io", message: "Stem file stopped." }));
    expect(await screen.findByTestId("drive-stem")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a failed download as an alert and keeps the list", async () => {
    const { user, onOpenedSong } = setup({
      accounts: ACCOUNTS,
      driveStems: { drive: [remote("Neon Nights", "drive:abc")] },
      overrides: {
        stems_cloud_open: () => {
          throw { kind: "network", message: "The cloud service could not be reached." };
        },
      },
    });
    await user.click(await fromDrive());
    await user.click(await screen.findByTestId("drive-stem"));
    expect(await screen.findByRole("alert")).toHaveTextContent("can't be reached");
    expect(screen.getByTestId("drive-stem")).toBeInTheDocument();
    expect(onOpenedSong).not.toHaveBeenCalled();
    await expectNoA11yViolations(dialog());
  });
});
