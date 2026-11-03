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
  }: { cloudFolder?: string | null; openSettings?: boolean } = {},
) {
  const calls = mockTauri(overrides);
  backend.saveResult = DEST;
  backend.cloudFolder = cloudFolder;
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
const place = () => screen.findByRole("radiogroup", { name: "Where to save" });

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

describe("Save stems dialog", () => {
  it("is a small dialog with the original song ticked, a privacy line and a Save button", async () => {
    setup();
    const box = screen.getByRole("checkbox", { name: "Include the original song" });
    expect(box).toBeChecked();
    expect(box).toBeEnabled();
    expect(box).toHaveAccessibleDescription(/about 5 to 25 MB/);
    expect(dialog()).toHaveTextContent("Saved on this computer. Nothing is uploaded.");
    expect(within(dialog()).getByRole("button", { name: "Save" })).toBeEnabled();
    await expectNoA11yViolations(dialog());
  });

  it("opens the native save dialog named after the song and saves with the original", async () => {
    const held = heldSave();
    const { user, calls, onSaved } = setup(STEM_SONG, { stems_save_bundle: held.handler });
    await user.click(screen.getByRole("button", { name: "Save" }));

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
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(DEST);
    expect(request(calls).includeOriginal).toBe(false);
  });

  it("does nothing when the native dialog is cancelled", async () => {
    const { user, calls } = setup();
    backend.saveResult = null;
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(calls.some((call) => call.cmd === "stems_save_bundle")).toBe(false);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("disables and unticks the checkbox when the original is not available", async () => {
    const { user, calls } = setup({ ...STEM_SONG, hasOriginal: false });
    const box = screen.getByRole("checkbox", { name: "Include the original song" });
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(box).toHaveAccessibleDescription(/original song is not on this computer/);
    await expectNoA11yViolations(dialog());
    await user.click(screen.getByRole("button", { name: "Save" }));
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
    await user.click(screen.getByRole("button", { name: "Save" }));

    const bar = await screen.findByRole("progressbar", { name: "Save progress" });
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "25"));
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
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
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/original song could not be added/)).toBeInTheDocument();
  });

  it("closes from the footer once saved", async () => {
    const { user, onOpenChange } = setup();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(DEST);
    await user.click(screen.getAllByRole("button", { name: "Close" })[0]!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows an error as an alert and lets the user try again", async () => {
    const held = heldSave();
    const { user } = setup(STEM_SONG, { stems_save_bundle: held.handler });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("progressbar", { name: "Save progress" });
    await held.fail({ kind: "io", message: "There is not enough space on the disk." });

    expect(await screen.findByRole("alert")).toHaveTextContent("not enough space");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await expectNoA11yViolations(dialog());
  });

  it("does not close while the file is being written", async () => {
    const held = heldSave();
    const { user, onOpenChange } = setup(STEM_SONG, { stems_save_bundle: held.handler });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("progressbar", { name: "Save progress" });
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    await held.finish({ path: DEST, bytes: 1, originalIncluded: true });
  });
});

describe("Save stems dialog: where to save (#186)", () => {
  it("shows no choice without a linked folder, but a hint to link one", async () => {
    setup();
    expect(await screen.findByText(/Link a cloud folder in Settings/)).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Where to save" })).toBeNull();
    expect(dialog()).toHaveTextContent(
      "Link a cloud folder in Settings to keep stems in your cloud.",
    );
    // Without a settings helper the hint is text only.
    expect(within(dialog()).queryByRole("button", { name: "Settings" })).toBeNull();
    await expectNoA11yViolations(dialog());
  });

  it("opens Settings from the hint and closes itself", async () => {
    const { user, onOpenChange, onOpenCloudSettings } = setup(
      STEM_SONG,
      {},
      { openSettings: true },
    );
    await user.click(await within(dialog()).findByRole("button", { name: "Settings" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenCloudSettings).toHaveBeenCalledOnce();
  });

  it("offers the cloud folder first and Another place second, with the cloud folder chosen", async () => {
    setup(STEM_SONG, {}, { cloudFolder: CLOUD });
    const group = await place();
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    const cloud = within(group).getByRole("radio", { name: "Cloud folder · Dropbox" });
    const other = within(group).getByRole("radio", { name: "Another place…" });
    expect(cloud).toBeChecked();
    expect(other).not.toBeChecked();
    expect(cloud).toHaveAccessibleDescription(/Smart Beat does not upload anything/);
    expect(screen.queryByText(/Link a cloud folder/)).toBeNull();
    await expectNoA11yViolations(dialog());
  });

  it("saves into the cloud folder without the native dialog", async () => {
    const { user, calls, onSaved } = setup(STEM_SONG, {}, { cloudFolder: CLOUD });
    await place();
    await user.click(screen.getByRole("button", { name: "Save" }));

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

  it("falls back to the native dialog for Another place, with no cloud text afterwards", async () => {
    const { user, calls } = setup(STEM_SONG, {}, { cloudFolder: CLOUD });
    await user.click(await screen.findByRole("radio", { name: "Another place…" }));
    expect(screen.getByRole("radio", { name: "Another place…" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByTestId("save-stems-path")).toHaveTextContent(DEST);
    expect(calls.some((call) => call.cmd === "stems_cloud_save_path")).toBe(false);
    expect(calls.some((call) => call.cmd === "plugin:dialog|save")).toBe(true);
    expect(request(calls).dest).toBe(DEST);
    expect(dialog()).not.toHaveTextContent("Saved in your cloud folder");
  });

  it("keeps the dialog as it was when the native dialog is cancelled from Another place", async () => {
    const { user, calls } = setup(STEM_SONG, {}, { cloudFolder: CLOUD });
    await user.click(await screen.findByRole("radio", { name: "Another place…" }));
    backend.saveResult = null;
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(calls.some((call) => call.cmd === "stems_save_bundle")).toBe(false);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("shows the estimate and updates it when the original is switched off and on", async () => {
    const { user, calls } = setup(STEM_SONG, {}, { cloudFolder: CLOUD });
    expect(await screen.findByText("About 80 MB")).toBeInTheDocument();
    expect(calls).toContainEqual({
      cmd: "stems_estimate_bundle",
      args: { id: STEM_SONG.id, includeOriginal: true },
    });

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
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(DEST);
  });

  it("explains a cloud folder that is gone and lets the user pick another place", async () => {
    const { user, calls } = setup(
      STEM_SONG,
      {
        stems_cloud_save_path: () => {
          throw { kind: "not-found", message: "gone" };
        },
      },
      { cloudFolder: CLOUD },
    );
    await place();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Is the drive offline/);
    expect(calls.some((call) => call.cmd === "stems_save_bundle")).toBe(false);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
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
    await place();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not read the folder.");
  });

  it("shows a write error in the cloud folder as an alert and keeps the choice", async () => {
    const held = heldSave();
    const { user } = setup(STEM_SONG, { stems_save_bundle: held.handler }, { cloudFolder: CLOUD });
    await place();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("progressbar", { name: "Save progress" });
    await held.fail({ kind: "io", message: "There is not enough space on the disk." });

    expect(await screen.findByRole("alert")).toHaveTextContent("not enough space");
    expect(screen.getByRole("radio", { name: "Cloud folder · Dropbox" })).toBeChecked();
  });

  it("does not close while saving into the cloud folder", async () => {
    const held = heldSave();
    const { user, onOpenChange } = setup(
      STEM_SONG,
      { stems_save_bundle: held.handler },
      { cloudFolder: CLOUD },
    );
    await place();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("progressbar", { name: "Save progress" });
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    await held.finish({ path: CLOUD_DEST, bytes: 1, originalIncluded: true });
  });
});
