import { emit } from "@tauri-apps/api/event";
import { act, screen, waitFor, within } from "@testing-library/react";

import { SaveStemsDialog } from "@/components/stems/save-stems-dialog";
import type { SaveBundleRequest, StemSong } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { backend, mockTauri, STEM_SONG, type IpcCall } from "@/test/tauri";

const DEST = "/Users/me/Music/Neon Nights.sbstems";

function setup(song: StemSong = STEM_SONG, overrides: Parameters<typeof mockTauri>[0] = {}) {
  const calls = mockTauri(overrides);
  backend.saveResult = DEST;
  const onOpenChange = vi.fn();
  const onSaved = vi.fn();
  const ui = renderWithProviders(
    <SaveStemsDialog song={song} open onOpenChange={onOpenChange} onSaved={onSaved} />,
  );
  return { ...ui, calls, onOpenChange, onSaved };
}

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
