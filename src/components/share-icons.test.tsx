import { screen, within } from "@testing-library/react";

import { CloudOpenDialog } from "@/components/cloud-open-dialog";
import { CloudScores } from "@/components/cloud-scores";
import { StemRecentCard } from "@/components/stems/stem-songs";
import { Welcome } from "@/components/welcome";
import { ShareProvider } from "@/providers/share-provider";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { backend, mockTauri, STEM_SONG } from "@/test/tauri";

const ACCOUNT = {
  provider: "drive",
  label: "Google Drive",
  account: "me@gmail.test",
  shareLevels: ["view", "edit"],
};

const withShare = (ui: React.ReactElement) =>
  renderWithProviders(<ShareProvider>{ui}</ShareProvider>);

/** The share icon of a row is next to the row's own button, never inside it. */
function expectSibling(share: HTMLElement, row: HTMLElement) {
  expect(row.contains(share)).toBe(false);
  expect(share.parentElement).toBe(row.parentElement);
}

describe("share icons on file rows", () => {
  it("cloud tabs on the start screen: shared as they are, no upload", async () => {
    mockTauri({
      get_cloud_folder: () => null,
      cloud_list: () => [{ id: "f1", name: "riff.gp", revision: "r", size: 1, modified_ms: 1 }],
    });
    backend.cloudAccounts = [ACCOUNT];
    const { user, container } = withShare(<CloudScores onOpen={vi.fn()} />);

    const share = await screen.findByRole("button", { name: "Share a link to riff.gp" });
    expectSibling(share, screen.getByRole("button", { name: /^riff\.gp/ }));
    await user.click(share);
    // Straight to what the link allows: the file is in the drive already.
    expect(
      await screen.findByRole("dialog", { name: "Who can use the link?" }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("files in the cloud folder get an icon, but an online-only one does not", async () => {
    mockTauri({
      get_cloud_folder: () => "/cloud",
      list_cloud_scores: () => [
        { name: "here.gp5", path: "/cloud/here.gp5", size: 1, modified_ms: 1, placeholder: false },
        { name: "far.gp5", path: "/cloud/far.gp5", size: 1, modified_ms: 1, placeholder: true },
      ],
    });
    const { user } = withShare(<CloudScores onOpen={vi.fn()} />);

    const share = await screen.findByRole("button", { name: "Share a link to here.gp5" });
    expect(
      screen.queryByRole("button", { name: "Share a link to far.gp5" }),
    ).not.toBeInTheDocument();
    await user.click(share);
    // On this computer: it asks where the copy goes first.
    expect(await screen.findByRole("dialog", { name: "Where should it go?" })).toBeInTheDocument();
  });

  it("recent songs: a local file is uploaded first, a cloud tab is not", async () => {
    mockTauri();
    backend.cloudAccounts = [ACCOUNT];
    const { user } = withShare(
      <Welcome
        onOpenFile={vi.fn()}
        onNewSong={vi.fn()}
        onShowShortcuts={vi.fn()}
        recent={["/Users/me/Songs/riff.gp5", "drive:abc"]}
        onOpenRecent={vi.fn()}
      />,
    );

    const local = await screen.findByRole("button", { name: "Share a link to riff.gp5" });
    expectSibling(local, screen.getByRole("button", { name: /^riff\.gp5/ }));
    await user.click(local);
    expect(await screen.findByRole("dialog", { name: "Where should it go?" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Share a link to Cloud tab" }));
    expect(
      await screen.findByRole("dialog", { name: "Who can use the link?" }),
    ).toBeInTheDocument();
  });

  it("recent stems: one saved in a drive is shared as that file, others are saved first", async () => {
    mockTauri();
    backend.cloudAccounts = [ACCOUNT];
    const onOpen = vi.fn();
    const onDelete = vi.fn();
    const { user, rerender } = withShare(
      <StemRecentCard
        song={{ ...STEM_SONG, savedPath: "drive:s1" }}
        index={0}
        onOpen={onOpen}
        onDelete={onDelete}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: `Share a link to ${STEM_SONG.name}.sbstems` }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Who can use the link?" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");

    rerender(
      <ShareProvider>
        <StemRecentCard
          song={{ ...STEM_SONG, savedPath: null }}
          index={0}
          onOpen={onOpen}
          onDelete={onDelete}
        />
      </ShareProvider>,
    );
    await user.click(screen.getByRole("button", { name: `Share a link to ${STEM_SONG.name}` }));
    expect(await screen.findByRole("dialog", { name: "Where should it go?" })).toBeInTheDocument();
  });

  it("the Open from drive list has an icon on every tab", async () => {
    mockTauri({
      cloud_list: () => [
        { id: "drive:1", name: "a.gp", revision: "r", size: 1, modified_ms: 2 },
        { id: "drive:2", name: "b.gp", revision: "r", size: 1, modified_ms: 1 },
      ],
    });
    backend.cloudAccounts = [ACCOUNT];
    withShare(
      <CloudOpenDialog
        provider="drive"
        label="Google Drive"
        open
        onOpenChange={vi.fn()}
        onPick={vi.fn()}
      />,
    );

    const list = await screen.findByRole("list", { name: "Tabs in Google Drive" });
    expect(within(list).getAllByTestId("share-button")).toHaveLength(2);
  });

  it("shows no icon where sharing is not set up", async () => {
    mockTauri({ get_cloud_folder: () => "/cloud", list_cloud_scores: () => [] });
    renderWithProviders(
      <Welcome
        onOpenFile={vi.fn()}
        onNewSong={vi.fn()}
        onShowShortcuts={vi.fn()}
        recent={["/Users/me/Songs/riff.gp5"]}
        onOpenRecent={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: /riff\.gp5/ });
    expect(screen.queryByTestId("share-button")).not.toBeInTheDocument();
  });
});
