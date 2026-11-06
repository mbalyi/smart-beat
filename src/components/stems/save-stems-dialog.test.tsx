import { emit } from "@tauri-apps/api/event";
import { act, screen, waitFor, within } from "@testing-library/react";

import { SaveStemsDialog } from "@/components/stems/save-stems-dialog";
import type { SaveBundleRequest, StemSong } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { backend, mockTauri, STEM_SONG, type IpcCall } from "@/test/tauri";

const DEST = "/Users/me/Music/Neon Nights.sbstems";

function setup(
  song: StemSong = STEM_SONG,
  overrides: Parameters<typeof mockTauri>[0] = {},
  {
    cloudFolder = null,
    openSettings = false,
    cloudAccounts = [],
  }: {
    cloudFolder?: string | null;
    openSettings?: boolean;
    cloudAccounts?: typeof backend.cloudAccounts;
  } = {},
) {
  const calls = mockTauri(overrides);
  backend.saveResult = DEST;
  backend.cloudFolder = cloudFolder;
  backend.cloudAccounts = cloudAccounts;
  const onOpenChange = vi.fn();
  const onSaved = vi.fn();
  const onOpenCloudSettings = vi.fn();
  const ui = renderWithProviders(
    <SaveStemsDialog
      song={song}
      open
      onOpenChange={onOpenChange}
      onSaved={onSaved}
      onOpenCloudSettings={openSettings ? onOpenCloudSettings : undefined}
    />,
  );
  return { ...ui, calls, onOpenChange, onSaved, onOpenCloudSettings };
}

const CLOUD = "/Users/me/Dropbox";
const CLOUD_DEST = `${CLOUD}/Neon Nights.sbstems`;

const dialog = () => screen.getByRole("dialog", { name: "Save stems" });
const request = (calls: IpcCall[]) =>
  (calls.find((call) => call.cmd === "stems_save_bundle")!.args as { request: SaveBundleRequest })
    .request;

/** A `stems_save_bundle` that finishes when the test says so. */
function heldSave() {
  let finish!: (result: unknown) => void;
  let fail!: (error: unknown) => void;
  const handler = () =>
    new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
  return {
    handler,
    finish: (result: unknown) => act(async () => finish(result)),
    fail: (error: unknown) => act(async () => fail(error)),
  };
}

const computer = () => screen.getByRole("button", { name: /^Save to this computer/ });
const cloud = () => screen.findByRole("button", { name: /^Save to Cloud folder · Dropbox/ });

describe("Save stems dialog", () => {
  it("shows the original-song option first, then the computer card, with no footer buttons", async () => {
    setup();
    const box = screen.getByRole("checkbox", { name: "Include the original song" });
    expect(box).toBeChecked();
    expect(box).toBeEnabled();
    expect(box).toHaveAccessibleDescription(/about 5 to 25 MB/);
    expect(computer()).toBeEnabled();
    // The visible hint is part of the name (WCAG 2.5.3, label in name).
    expect(computer()).toHaveAccessibleName(/Nothing is uploaded\./);
    // The option comes before the cards in reading order.
    expect(box.compareDocumentPosition(computer()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Only the corner X closes it: no Save button, no footer.
    expect(within(dialog()).queryByRole("button", { name: "Save" })).toBeNull();
    expect(dialog().querySelector('[data-slot="dialog-footer"]')).toBeNull();
    expect(dialog().querySelectorAll('[data-slot="dialog-close"]')).toHaveLength(1);
    await expectNoA11yViolations(dialog());
  });

  it("opens the native save dialog named after the song and saves with the original", async () => {
    const held = heldSave();
    const { user, calls, onSaved } = setup(STEM_SONG, { stems_save_bundle: held.handler });
    await user.click(computer());

    expect(calls).toContainEqual({
      cmd: "plugin:dialog|save",
      args: {
        options: expect.objectContaining({
          defaultPath: "Neon Nights.sbstems",
          filters: [{ name: "Smart Beat stems", extensions: ["sbstems"] }],
        }),
      },
    });
    await waitFor(() => expect(request(calls)).toBeDefined());
    expect(request(calls)).toEqual({ id: STEM_SONG.id, dest: DEST, includeOriginal: true });

    await held.finish({ path: DEST, bytes: 1, originalIncluded: true });
    expect(onSaved).toHaveBeenCalledWith(DEST);
  });

  it("saves only the stems when the checkbox is cleared", async () => {
    const { user, calls } = setup();
    await user.click(screen.getByRole("checkbox", { name: "Include the original song" }));
    await user.click(computer());
    await screen.findByText(DEST);
    expect(request(calls).includeOriginal).toBe(false);
  });

  it("does nothing when the native dialog is cancelled", async () => {
    const { user, calls } = setup();
    backend.saveResult = null;
    await user.click(computer());
    expect(calls.some((call) => call.cmd === "stems_save_bundle")).toBe(false);
    expect(computer()).toBeEnabled();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("disables and unticks the checkbox when the original is not available", async () => {
    const { user, calls } = setup({ ...STEM_SONG, hasOriginal: false });
    const box = screen.getByRole("checkbox", { name: "Include the original song" });
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(box).toHaveAccessibleDescription(/original song is not on this computer/);
    await expectNoA11yViolations(dialog());
    await user.click(computer());
    await screen.findByText(DEST);
    expect(request(calls).includeOriginal).toBe(false);
  });

  it("shows the progress while writing, then the path and Show in folder", async () => {
    const held = heldSave();
    const { user, calls } = setup(STEM_SONG, {
      stems_save_bundle: async () => {
        await emit("stems-bundle-progress", { stage: "writing", fraction: 0.25 });
        return held.handler();
      },
    });
    await user.click(computer());

    const bar = await screen.findByRole("progressbar", { name: "Save progress" });
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "25"));
    // The cards are gone while writing, and the corner X is hidden.
    expect(screen.queryByRole("button", { name: /^Save to this computer/ })).toBeNull();
    expect(within(dialog()).queryByRole("button")).toBeNull();
    await expectNoA11yViolations(dialog());

    await held.finish({ path: DEST, bytes: 5, originalIncluded: true });
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByTestId("save-stems-path")).toHaveTextContent(DEST);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await expectNoA11yViolations(dialog());

    await user.click(screen.getByRole("button", { name: "Show in folder" }));
    expect(calls).toContainEqual({
      cmd: "plugin:opener|reveal_item_in_dir",
      args: { paths: [DEST] },
    });
  });

  it("says when the original could not be added", async () => {
    const { user } = setup(STEM_SONG, {
      stems_save_bundle: () => ({ path: DEST, bytes: 1, originalIncluded: false }),
    });
    await user.click(computer());
    expect(await screen.findByText(/original song could not be added/)).toBeInTheDocument();
  });

  it("closes with the corner button once saved, and with Escape", async () => {
    const { user, onOpenChange } = setup();
    await user.click(computer());
    await screen.findByText(DEST);
    await user.click(within(dialog()).getByRole("button", { name: /close/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows an error as an alert and offers the cards again", async () => {
    const held = heldSave();
    const { user } = setup(STEM_SONG, { stems_save_bundle: held.handler });
    await user.click(computer());
    await screen.findByRole("progressbar", { name: "Save progress" });
    await held.fail({ kind: "io", message: "There is not enough space on the disk." });

    expect(await screen.findByRole("alert")).toHaveTextContent("not enough space");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(computer()).toBeEnabled();
    await expectNoA11yViolations(dialog());
  });

  it("does not close while the file is being written", async () => {
    const held = heldSave();
    const { user, onOpenChange } = setup(STEM_SONG, { stems_save_bundle: held.handler });
    await user.click(computer());
    await screen.findByRole("progressbar", { name: "Save progress" });
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    await held.finish({ path: DEST, bytes: 1, originalIncluded: true });
  });
});

describe("Save stems dialog: where to save (#186)", () => {
  it("offers a Set up cloud storage card, disabled without a settings helper", async () => {
    setup();
    const card = await screen.findByRole("button", { name: /^Set up Cloud storage/ });
    expect(card).toBeDisabled();
    expect(card).toHaveAccessibleName(/Connect an account or link a cloud folder in Settings\./);
    expect(screen.queryByRole("button", { name: /^Save to Cloud folder/ })).toBeNull();
    await expectNoA11yViolations(dialog());
  });

  it("opens Settings from the Set up card and closes itself", async () => {
    const { user, onOpenChange, onOpenCloudSettings } = setup(
      STEM_SONG,
      {},
      { openSettings: true },
    );
    await user.click(await screen.findByRole("button", { name: /^Set up Cloud storage/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenCloudSettings).toHaveBeenCalledOnce();
  });

  it("offers this computer first and the cloud folder second when one is linked", async () => {
    setup(STEM_SONG, {}, { cloudFolder: CLOUD });
    const folder = await cloud();
    expect(folder).toHaveAccessibleName(/Smart Beat does not upload anything/);
    expect(screen.queryByRole("button", { name: /^Set up Cloud storage/ })).toBeNull();
    expect(
      computer().compareDocumentPosition(folder) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await expectNoA11yViolations(dialog());
  });

  it("saves into the cloud folder as soon as its card is clicked, without the native dialog", async () => {
    const { user, calls, onSaved } = setup(STEM_SONG, {}, { cloudFolder: CLOUD });
    await user.click(await cloud());

    expect(await screen.findByTestId("save-stems-path")).toHaveTextContent(CLOUD_DEST);
    expect(calls).toContainEqual({ cmd: "stems_cloud_save_path", args: { name: "Neon Nights" } });
    expect(calls.some((call) => call.cmd === "plugin:dialog|save")).toBe(false);
    expect(request(calls)).toEqual({ id: STEM_SONG.id, dest: CLOUD_DEST, includeOriginal: true });
    expect(onSaved).toHaveBeenCalledWith(CLOUD_DEST);
    expect(dialog()).toHaveTextContent(
      "Saved in your cloud folder. Your drive app uploads it; Smart Beat does not upload anything.",
    );
    expect(screen.getByRole("button", { name: "Show in folder" })).toBeInTheDocument();
    await expectNoA11yViolations(dialog());
  });

  it("uses the native dialog for this computer, with no cloud text afterwards", async () => {
    const { user, calls } = setup(STEM_SONG, {}, { cloudFolder: CLOUD });
    await cloud();
    await user.click(computer());

    expect(await screen.findByTestId("save-stems-path")).toHaveTextContent(DEST);
    expect(calls.some((call) => call.cmd === "stems_cloud_save_path")).toBe(false);
    expect(calls.some((call) => call.cmd === "plugin:dialog|save")).toBe(true);
    expect(request(calls).dest).toBe(DEST);
    expect(dialog()).not.toHaveTextContent("Saved in your cloud folder");
  });

  it("keeps the dialog as it was when the native dialog is cancelled", async () => {
    const { user, calls } = setup(STEM_SONG, {}, { cloudFolder: CLOUD });
    await cloud();
    backend.saveResult = null;
    await user.click(computer());
    expect(calls.some((call) => call.cmd === "stems_save_bundle")).toBe(false);
    expect(computer()).toBeEnabled();
  });

  it("shows the estimate next to the option and updates it when the original is switched off and on", async () => {
    const { user, calls } = setup(STEM_SONG, {}, { cloudFolder: CLOUD });
    const estimate = await screen.findByTestId("save-stems-estimate");
    await waitFor(() => expect(estimate).toHaveTextContent("About 80 MB"));
    expect(calls).toContainEqual({
      cmd: "stems_estimate_bundle",
      args: { id: STEM_SONG.id, includeOriginal: true },
    });
    // It sits in the option's row, not in a footer.
    expect(estimate.parentElement).toContainElement(
      screen.getByRole("checkbox", { name: "Include the original song" }),
    );

    await user.click(screen.getByRole("checkbox", { name: "Include the original song" }));
    expect(await screen.findByText("About 55 MB")).toBeInTheDocument();
    expect(calls).toContainEqual({
      cmd: "stems_estimate_bundle",
      args: { id: STEM_SONG.id, includeOriginal: false },
    });

    await user.click(screen.getByRole("checkbox", { name: "Include the original song" }));
    expect(await screen.findByText("About 80 MB")).toBeInTheDocument();
  });

  it("estimates without the original when it is not available", async () => {
    const { calls } = setup({ ...STEM_SONG, hasOriginal: false });
    expect(await screen.findByText("About 55 MB")).toBeInTheDocument();
    expect(calls).toContainEqual({
      cmd: "stems_estimate_bundle",
      args: { id: STEM_SONG.id, includeOriginal: false },
    });
  });

  it("shows no estimate when it cannot be made, and saving still works", async () => {
    const { user, calls } = setup(STEM_SONG, {
      stems_estimate_bundle: () => {
        throw { kind: "io", message: "no" };
      },
    });
    await waitFor(() =>
      expect(calls.some((call) => call.cmd === "stems_estimate_bundle")).toBe(true),
    );
    expect(screen.queryByText(/^About /)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(computer());
    await screen.findByText(DEST);
  });

  it("explains a cloud folder that is gone and keeps the cards", async () => {
    const { user, calls } = setup(
      STEM_SONG,
      {
        stems_cloud_save_path: () => {
          throw { kind: "not-found", message: "gone" };
        },
      },
      { cloudFolder: CLOUD },
    );
    await user.click(await cloud());

    expect(await screen.findByRole("alert")).toHaveTextContent(/Is the drive offline/);
    expect(calls.some((call) => call.cmd === "stems_save_bundle")).toBe(false);
    expect(computer()).toBeEnabled();
    expect(await cloud()).toBeEnabled();
    await expectNoA11yViolations(dialog());
  });

  it("shows another failure of the cloud path as an alert", async () => {
    const { user } = setup(
      STEM_SONG,
      {
        stems_cloud_save_path: () => {
          throw { kind: "io", message: "Could not read the folder." };
        },
      },
      { cloudFolder: CLOUD },
    );
    await user.click(await cloud());
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not read the folder.");
  });

  it("shows a write error in the cloud folder as an alert and offers the cards again", async () => {
    const held = heldSave();
    const { user } = setup(STEM_SONG, { stems_save_bundle: held.handler }, { cloudFolder: CLOUD });
    await user.click(await cloud());
    await screen.findByRole("progressbar", { name: "Save progress" });
    await held.fail({ kind: "io", message: "There is not enough space on the disk." });

    expect(await screen.findByRole("alert")).toHaveTextContent("not enough space");
    expect(await cloud()).toBeEnabled();
  });

  it("does not close while saving into the cloud folder", async () => {
    const held = heldSave();
    const { user, onOpenChange } = setup(
      STEM_SONG,
      { stems_save_bundle: held.handler },
      { cloudFolder: CLOUD },
    );
    await user.click(await cloud());
    await screen.findByRole("progressbar", { name: "Save progress" });
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    await held.finish({ path: CLOUD_DEST, bytes: 1, originalIncluded: true });
  });
});

const ACCOUNTS = [
  { provider: "drive", label: "Google Drive", account: "me@example.com" },
  { provider: "onedrive", label: "OneDrive", account: "smart-beat@outlook.com" },
  { provider: "dropbox", label: "Dropbox", account: null },
];
const toDrive = () => screen.findByRole("button", { name: /^Save to Google Drive/ });

describe("Save stems dialog: connected accounts", () => {
  it("offers a card for each connected account between this computer and the cloud folder", async () => {
    setup(STEM_SONG, {}, { cloudAccounts: ACCOUNTS, cloudFolder: CLOUD });
    const drive = await toDrive();
    const onedrive = screen.getByRole("button", { name: /^Save to OneDrive/ });
    const folder = await cloud();
    expect(drive).toHaveAccessibleName(/me@example\.com/);
    expect(onedrive).toHaveAccessibleName(/smart-beat@outlook\.com/);
    // Dropbox is not connected: no card for it, and no Set up card either.
    expect(screen.queryByRole("button", { name: /^Save to Dropbox/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Set up Cloud storage/ })).toBeNull();
    const before = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(computer(), drive)).toBe(true);
    expect(before(drive, onedrive)).toBe(true);
    expect(before(onedrive, folder)).toBe(true);
    await expectNoA11yViolations(dialog());
  });

  it("shows the account cards without a Set up card when no folder is linked", async () => {
    setup(STEM_SONG, {}, { cloudAccounts: ACCOUNTS });
    await toDrive();
    expect(screen.queryByRole("button", { name: /^Set up Cloud storage/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Save to Cloud folder/ })).toBeNull();
  });

  it("keeps the Set up card when no account is connected and no folder is linked", async () => {
    setup(STEM_SONG, {}, { cloudAccounts: [{ ...ACCOUNTS[2]!, label: "Dropbox" }] });
    expect(await screen.findByRole("button", { name: /^Set up Cloud storage/ })).toBeDisabled();
  });

  it("leaves out an account this build cannot use", async () => {
    setup(STEM_SONG, {}, { cloudAccounts: [{ ...ACCOUNTS[0]!, configured: false }, ACCOUNTS[1]!] });
    await screen.findByRole("button", { name: /^Save to OneDrive/ });
    expect(screen.queryByRole("button", { name: /^Save to Google Drive/ })).toBeNull();
  });

  it("writes the file, uploads it with progress, and says where it is", async () => {
    const held = heldSave();
    const { user, calls, onSaved } = setup(
      STEM_SONG,
      {
        stems_cloud_save: async () => {
          await emit("stems-bundle-progress", { stage: "writing", fraction: 0.5 });
          return held.handler();
        },
      },
      { cloudAccounts: ACCOUNTS },
    );
    await user.click(await toDrive());

    expect(
      calls.find((call) => call.cmd === "stems_cloud_save")?.args as { request: unknown },
    ).toEqual({
      request: { id: STEM_SONG.id, provider: "drive", includeOriginal: true },
    });
    expect(await screen.findByText("Preparing the file…")).toBeInTheDocument();

    await act(() => emit("stems-bundle-progress", { stage: "uploading", fraction: 0.4 }));
    expect(await screen.findByText("Uploading to Google Drive…")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Save progress" });
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "40"));
    // The cards are gone; Cancel is the only button, and the dialog cannot be closed.
    expect(screen.queryByRole("button", { name: /^Save to Google Drive/ })).toBeNull();
    expect(
      within(dialog())
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Cancel"]);
    await expectNoA11yViolations(dialog());

    await held.finish({
      item: "drive:1",
      name: "Neon Nights.sbstems",
      provider: "drive",
      bytes: 5,
      originalIncluded: true,
    });
    expect(screen.getByText("Saved in Google Drive")).toBeInTheDocument();
    expect(screen.getByTestId("save-stems-path")).toHaveTextContent("Neon Nights.sbstems");
    expect(screen.queryByRole("button", { name: "Show in folder" })).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(onSaved).toHaveBeenCalledWith("drive:1");
    await expectNoA11yViolations(dialog());
  });

  it("saves only the stems to an account when the checkbox is cleared", async () => {
    const { user, calls } = setup(STEM_SONG, {}, { cloudAccounts: ACCOUNTS });
    await user.click(screen.getByRole("checkbox", { name: "Include the original song" }));
    await user.click(await screen.findByRole("button", { name: /^Save to OneDrive/ }));
    await screen.findByText("Saved in OneDrive");
    expect(
      (calls.find((call) => call.cmd === "stems_cloud_save")!.args as { request: unknown }).request,
    ).toEqual({ id: STEM_SONG.id, provider: "onedrive", includeOriginal: false });
  });

  it("stops with Cancel, without an error, and offers the cards again", async () => {
    const held = heldSave();
    const { user, calls } = setup(
      STEM_SONG,
      { stems_cloud_save: held.handler },
      { cloudAccounts: ACCOUNTS },
    );
    await user.click(await toDrive());
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(calls.some((call) => call.cmd === "stems_cancel")).toBe(true);

    await held.fail({ kind: "io", message: "Stem file stopped." });
    expect(await toDrive()).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("tells the person to reconnect when the sign-in ran out", async () => {
    const held = heldSave();
    const { user } = setup(
      STEM_SONG,
      { stems_cloud_save: held.handler },
      { cloudAccounts: ACCOUNTS },
    );
    await user.click(await toDrive());
    await screen.findByRole("progressbar", { name: "Save progress" });
    await held.fail({ kind: "auth-expired", message: "The sign-in expired." });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Reconnect Google Drive in Settings",
    );
    expect(await toDrive()).toBeEnabled();
    await expectNoA11yViolations(dialog());
  });

  it("shows any other failure as an alert and keeps working", async () => {
    const held = heldSave();
    const { user, onSaved } = setup(
      STEM_SONG,
      { stems_cloud_save: held.handler },
      { cloudAccounts: ACCOUNTS },
    );
    await user.click(await toDrive());
    await screen.findByRole("progressbar", { name: "Save progress" });
    await held.fail({ kind: "network", message: "The cloud service could not be reached." });
    expect(await screen.findByRole("alert")).toHaveTextContent("can't be reached");
    expect(onSaved).not.toHaveBeenCalled();
    // The other cards still work.
    expect(computer()).toBeEnabled();
  });

  it("does not close while the file is uploading", async () => {
    const held = heldSave();
    const { user, onOpenChange } = setup(
      STEM_SONG,
      { stems_cloud_save: held.handler },
      { cloudAccounts: ACCOUNTS },
    );
    await user.click(await toDrive());
    await screen.findByRole("progressbar", { name: "Save progress" });
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    await held.finish({
      item: "drive:1",
      name: "Neon Nights.sbstems",
      provider: "drive",
      bytes: 1,
      originalIncluded: true,
    });
  });
});
