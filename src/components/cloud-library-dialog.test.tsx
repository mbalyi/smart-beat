import { screen, waitFor, within } from "@testing-library/react";

import { CloudLibraryDialog } from "@/components/cloud-library-dialog";
import { Toaster } from "@/components/ui/sonner";
import { ShareProvider } from "@/providers/share-provider";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { backend, mockTauri } from "@/test/tauri";

const tab = (id: string, name: string, modified_ms: number, size = 2048) => ({
  id,
  name,
  revision: "r",
  size,
  modified_ms,
});

const ACCOUNTS: typeof backend.cloudAccounts = [
  {
    provider: "drive",
    label: "Google Drive",
    account: "me@gmail.test",
    shareLevels: ["view", "edit"],
  },
  {
    provider: "onedrive",
    label: "OneDrive",
    account: "me@outlook.test",
    shareLevels: ["view", "edit"],
  },
  { provider: "dropbox", label: "Dropbox", account: null, shareLevels: ["view"] },
];

function setup(overrides: Parameters<typeof mockTauri>[0] = {}, accounts = ACCOUNTS) {
  const calls = mockTauri(overrides);
  backend.cloudAccounts = accounts;
  const handlers = {
    onOpenChange: vi.fn(),
    onSetUpCloud: vi.fn(),
    onOpenTab: vi.fn(),
    onOpenStems: vi.fn(),
  };
  const ui = renderWithProviders(
    <ShareProvider>
      <CloudLibraryDialog open {...handlers} />
      <Toaster />
    </ShareProvider>,
  );
  return { ...ui, calls, ...handlers };
}

const section = async (name: RegExp) => {
  const heading = await screen.findByRole("heading", { name });
  return within(heading.closest("section") as HTMLElement);
};

describe("CloudLibraryDialog", () => {
  beforeEach(() => {
    backend.driveStems = {};
  });

  it("lists the tabs and stems of each drive in its own group, newest first", async () => {
    backend.driveStems = {
      drive: [
        {
          id: "drive:s1",
          name: "Neon Nights.sbstems",
          revision: "r",
          size: 50_000_000,
          modified_ms: 300,
        },
      ],
    };
    setup({
      cloud_list: (args) =>
        (args as { provider: string }).provider === "drive"
          ? [tab("drive:t1", "riff.gp", 100), tab("drive:t2", "solo.gp5", 400)]
          : [tab("onedrive:t3", "intro.gp", 50)],
    });

    const drive = await section(/Google Drive/);
    const rows = await drive.findAllByTestId("library-entry");
    expect(rows.map((row) => within(row).getByText(/\.gp5?$|Neon Nights/).textContent)).toEqual([
      "solo.gp5",
      "Neon Nights",
      "riff.gp",
    ]);
    // Stems are marked, and sizes are readable for a small tab and a large file.
    expect(within(rows[1]!).getByText("Stems")).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/48 MB/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Tab")).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/2 KB/)).toBeInTheDocument();

    const oneDrive = await section(/OneDrive/);
    expect(await oneDrive.findAllByTestId("library-entry")).toHaveLength(1);
    // The files of one drive never show under another.
    expect(oneDrive.queryByText("riff.gp")).not.toBeInTheDocument();
  });

  it("says so when a drive has nothing, is not connected or is not in this build", async () => {
    setup({ cloud_list: () => [] }, [
      ACCOUNTS[0]!,
      { provider: "onedrive", label: "OneDrive", account: null },
      { provider: "dropbox", label: "Dropbox", account: null, configured: false } as never,
    ]);

    expect(await (await section(/Google Drive/)).findByTestId("library-empty")).toHaveTextContent(
      /Nothing here yet/,
    );
    expect((await section(/OneDrive/)).getByText("Not connected")).toBeInTheDocument();
    const dropbox = await section(/Dropbox/);
    expect(dropbox.getByText("Not available in this build")).toBeInTheDocument();
    expect(dropbox.queryByRole("button", { name: /Connect/ })).not.toBeInTheDocument();
  });

  it("sends a drive that is not connected to the settings", async () => {
    const { user, onSetUpCloud } = setup({ cloud_list: () => [] });

    const dropbox = await section(/Dropbox/);
    await user.click(dropbox.getByRole("button", { name: "Connect Dropbox" }));
    expect(onSetUpCloud).toHaveBeenCalledOnce();
  });

  it("explains one drive that fails and lists the others", async () => {
    let healthy = false;
    const { user } = setup({
      cloud_list: (args) => {
        if ((args as { provider: string }).provider === "drive" && !healthy)
          throw { kind: "network", message: "offline" };
        return [tab("x:1", "riff.gp", 1)];
      },
    });

    const drive = await section(/Google Drive/);
    expect(await drive.findByRole("alert")).toHaveTextContent(/can't be reached/);
    expect(await (await section(/OneDrive/)).findAllByTestId("library-entry")).toHaveLength(1);

    healthy = true;
    await user.click(drive.getByRole("button", { name: "Try again" }));
    expect(await drive.findAllByTestId("library-entry")).toHaveLength(1);
    expect(drive.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("opens a tab and opens stems", async () => {
    backend.driveStems = {
      drive: [
        { id: "drive:s1", name: "Neon Nights.sbstems", revision: "r", size: 1, modified_ms: 3 },
      ],
    };
    const { user, onOpenTab, onOpenStems } = setup({
      cloud_list: (args) =>
        (args as { provider: string }).provider === "drive" ? [tab("drive:t1", "riff.gp", 1)] : [],
    });

    const drive = await section(/Google Drive/);
    await user.click(await drive.findByRole("button", { name: "Open riff.gp" }));
    expect(onOpenTab).toHaveBeenCalledWith("drive:t1");
    await user.click(drive.getByRole("button", { name: "Open Neon Nights.sbstems" }));
    expect(onOpenStems).toHaveBeenCalledWith("drive:s1");
  });

  it("shares a tab and a stems file from the list with their own links", async () => {
    backend.driveStems = {
      drive: [
        { id: "drive:s1", name: "Neon Nights.sbstems", revision: "r", size: 1, modified_ms: 3 },
      ],
    };
    const { user, calls } = setup({
      cloud_list: (args) =>
        (args as { provider: string }).provider === "drive" ? [tab("drive:t1", "riff.gp", 1)] : [],
    });

    const drive = await section(/Google Drive/);
    await user.click(await drive.findByRole("button", { name: "Share a link to riff.gp" }));
    let dialog = await screen.findByRole("dialog", { name: "Who can use the link?" });
    await user.click(within(dialog).getByRole("button", { name: "Copy link" }));
    await within(dialog).findByRole("textbox", { name: "Share link" });
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Link copied" })).not.toBeInTheDocument(),
    );

    await user.click(drive.getByRole("button", { name: "Share a link to Neon Nights.sbstems" }));
    dialog = await screen.findByRole("dialog", { name: "Who can use the link?" });
    await user.click(within(dialog).getByRole("button", { name: "Copy link" }));
    await within(dialog).findByRole("textbox", { name: "Share link" });

    expect(calls.filter((c) => c.cmd === "cloud_share").map((c) => c.args)).toEqual([
      { item: "drive:t1", level: "view" },
      { item: "drive:s1", level: "view" },
    ]);
  });

  it("only lists what Smart Beat saved, and says so", async () => {
    setup({ cloud_list: () => [] });
    expect(await screen.findByText(/Only files Smart Beat saved are listed/)).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    backend.driveStems = {
      drive: [
        { id: "drive:s1", name: "Neon Nights.sbstems", revision: "r", size: 1, modified_ms: 3 },
      ],
    };
    setup({ cloud_list: () => [tab("drive:t1", "riff.gp", 1)] });
    const dialog = await screen.findByRole("dialog", { name: "Cloud library" });
    await screen.findAllByTestId("library-entry");
    await expectNoA11yViolations(dialog);
  });
});
