import { emit } from "@tauri-apps/api/event";
import { act, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";

import { ExportStemsDialog, type StemTabTarget } from "@/components/stems/export-stems-dialog";
import type {
  StemExportBatchRequest,
  StemExportMixedRequest,
  StemKindId,
  StemSong,
} from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { backend, mockTauri, STEM_SONG, type IpcCall } from "@/test/tauri";

const FILE = "/Users/me/Music/Neon Nights (mix).wav";
const FOLDER = "/Users/me/Music";

const SIX_PART: StemSong = {
  ...STEM_SONG,
  engine: "htdemucs-6s",
  stems: (["drums", "bass", "vocals", "guitar", "piano", "other"] as const).map((kind) => ({
    kind,
    bytes: 38_000_000,
  })),
};

type AddToTab = NonNullable<ComponentProps<typeof ExportStemsDialog>["onAddToTab"]>;

const TABS: StemTabTarget[] = [
  { id: 1, name: "Neon Nights.gp" },
  { id: 2, name: "Other song.gp" },
];

function setup({
  song = STEM_SONG,
  overrides = {},
  tabs = TABS,
  onAddToTab = vi.fn<AddToTab>(async () => ({ tab: "Neon Nights.gp", count: 3 })),
  withTabs = true,
  initialKinds,
}: {
  song?: StemSong;
  overrides?: Parameters<typeof mockTauri>[0];
  tabs?: StemTabTarget[];
  onAddToTab?: AddToTab;
  withTabs?: boolean;
  initialKinds?: StemKindId[];
} = {}) {
  const calls = mockTauri(overrides);
  backend.saveResult = FILE;
  backend.dialogResult = FOLDER;
  const onOpenChange = vi.fn();
  const ui = renderWithProviders(
    <ExportStemsDialog
      song={song}
      open
      onOpenChange={onOpenChange}
      tabs={tabs}
      initialKinds={initialKinds}
      onAddToTab={withTabs ? onAddToTab : undefined}
    />,
  );
  return { ...ui, calls, onOpenChange, onAddToTab };
}

const dialog = () => screen.getByRole("dialog", { name: "Export stems" });
const run = () => screen.getByTestId("export-stems-run");
const stem = (kind: string) => screen.getByTestId(`export-stem-${kind}`);
const choose = (name: string) => screen.getByRole("radio", { name });

const mixedRequest = (calls: IpcCall[]) =>
  (calls.find((c) => c.cmd === "stems_export_mixed")!.args as { request: StemExportMixedRequest })
    .request;
const batchRequest = (calls: IpcCall[]) =>
  (calls.find((c) => c.cmd === "stems_export_batch")!.args as { request: StemExportBatchRequest })
    .request;

/** An export command that finishes when the test says so. */
function held() {
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

describe("Export stems dialog", () => {
  it.each([
    ["the fast engine", STEM_SONG, ["drums", "bass", "vocals", "panned", "other"]],
    ["the six-part model", SIX_PART, ["drums", "bass", "vocals", "guitar", "piano", "other"]],
  ] as const)("offers every stem of %s, all ticked, with the same choices", (_, song, kinds) => {
    setup({ song });
    for (const kind of kinds) expect(stem(kind)).toBeChecked();
    expect(screen.getAllByRole("checkbox")).toHaveLength(kinds.length);
    expect(choose("One mixed file")).toBeChecked();
    expect(choose("One file per stem")).not.toBeChecked();
    expect(choose("Add to a tab")).not.toBeChecked();
    expect(choose("WAV")).toBeChecked();
    expect(choose("FLAC")).not.toBeChecked();
    expect(run()).toBeEnabled();
    expect(run()).toHaveTextContent("Export mix");
  });

  it("has the Export stems logo in the header, a picture on every card and the pink Export button", () => {
    setup();
    const header = screen.getByTestId("export-stems-logo");
    expect(header).toHaveAttribute("alt", "");
    expect(header).toHaveAttribute("aria-hidden", "true");
    // The title stays for screen readers, and the description is next to the logo.
    expect(dialog()).toBeInTheDocument();
    expect(screen.getByText(/Take “Neon Nights” into your music software/)).toBeInTheDocument();
    for (const kind of ["drums", "bass", "vocals", "panned", "other"]) {
      expect(stem(kind).closest("li")!.querySelector("svg")).not.toBeNull();
    }
    expect(run().querySelector("svg")).not.toBeNull();
  });

  it("opens with only the stem a row's button was on, and offers the others to tick", async () => {
    const { user } = setup({ initialKinds: ["bass"] });
    expect(stem("bass")).toBeChecked();
    for (const kind of ["drums", "vocals", "panned", "other"]) expect(stem(kind)).not.toBeChecked();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(stem("drums")).toBeChecked();
  });

  it("falls back to every stem when the stem asked for is not in the song", () => {
    setup({ initialKinds: ["piano"] });
    expect(stem("drums")).toBeChecked();
    expect(
      screen.getAllByRole("checkbox").filter((box) => box.getAttribute("data-state") === "checked"),
    ).toHaveLength(5);
  });

  it("disables Export with a clear message when no stem is chosen, and brings it back", async () => {
    const { user, calls } = setup();
    await user.click(screen.getByRole("button", { name: "None" }));
    expect(run()).toBeDisabled();
    expect(screen.getByTestId("export-stems-none")).toHaveTextContent(
      "Choose at least one stem to export.",
    );
    // The state of the choice is shown on All and None.
    expect(screen.getByRole("button", { name: "None" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");
    // Every mode is held back the same way, even when the form is submitted with Enter.
    await user.click(choose("One file per stem"));
    expect(run()).toBeDisabled();
    await user.click(choose("Add to a tab"));
    expect(run()).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(
      calls.some((c) => c.cmd.startsWith("stems_export") || c.cmd === "plugin:dialog|save"),
    ).toBe(false);

    await user.click(stem("vocals"));
    expect(run()).toBeEnabled();
    expect(screen.queryByTestId("export-stems-none")).toBeNull();
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(stem("drums")).toBeChecked();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "None" })).toHaveAttribute("aria-pressed", "false");
  });

  it("passes the axe scan with the options and the tab choices", async () => {
    const { user } = setup();
    await expectNoA11yViolations(dialog());
    await user.click(choose("Add to a tab"));
    await expectNoA11yViolations(dialog());
  });

  it("asks for a file named after the song, then exports the chosen stems mixed", async () => {
    const exportHeld = held();
    const { user, calls } = setup({ overrides: { stems_export_mixed: exportHeld.handler } });
    await user.click(stem("panned"));
    await user.click(stem("other"));
    await user.click(run());

    expect(calls).toContainEqual({
      cmd: "plugin:dialog|save",
      args: {
        options: expect.objectContaining({
          defaultPath: "Neon Nights (mix).wav",
          filters: [{ name: "WAV audio", extensions: ["wav"] }],
        }),
      },
    });
    await waitFor(() => expect(mixedRequest(calls)).toBeDefined());
    expect(mixedRequest(calls)).toEqual({
      id: STEM_SONG.id,
      kinds: ["drums", "bass", "vocals"],
      format: "wav",
      dest: FILE,
    });
    await exportHeld.finish({ paths: [FILE], folder: null, clipped: false });
    expect(screen.getByTestId("export-stems-path")).toHaveTextContent(FILE);
    expect(screen.getByText("Exported the mix")).toBeInTheDocument();
    expect(screen.queryByText(/louder than the highest level/)).toBeNull();
    await expectNoA11yViolations(dialog());

    await user.click(screen.getByRole("button", { name: "Show in folder" }));
    expect(calls).toContainEqual({
      cmd: "plugin:opener|reveal_item_in_dir",
      args: { paths: [FILE] },
    });
  });

  it("exports FLAC when it is chosen, and says when the mix was limited", async () => {
    const { user, calls } = setup({
      overrides: {
        stems_export_mixed: () => ({ paths: ["/x/mix.flac"], folder: null, clipped: true }),
      },
    });
    await user.click(choose("FLAC"));
    await user.click(run());
    expect(calls).toContainEqual({
      cmd: "plugin:dialog|save",
      args: {
        options: expect.objectContaining({
          defaultPath: "Neon Nights (mix).flac",
          filters: [{ name: "FLAC audio", extensions: ["flac"] }],
        }),
      },
    });
    expect(await screen.findByText(/louder than the highest level/)).toBeInTheDocument();
    expect(mixedRequest(calls).format).toBe("flac");
  });

  it("exports one file per stem into a folder it asks for", async () => {
    const { user, calls } = setup();
    await user.click(choose("One file per stem"));
    expect(run()).toHaveTextContent("Export files");
    expect(screen.queryByRole("radio", { name: "Neon Nights.gp" })).toBeNull();
    await user.click(stem("bass"));
    await user.click(run());

    expect(calls).toContainEqual({
      cmd: "plugin:dialog|open",
      args: { options: expect.objectContaining({ directory: true, multiple: false }) },
    });
    expect(await screen.findByText("Exported 4 files")).toBeInTheDocument();
    expect(batchRequest(calls)).toEqual({
      id: STEM_SONG.id,
      kinds: ["drums", "vocals", "panned", "other"],
      format: "wav",
      dir: FOLDER,
    });
    expect(screen.getByTestId("export-stems-path")).toHaveTextContent(
      `${FOLDER}/Neon Nights stems`,
    );
    await user.click(screen.getByRole("button", { name: "Show in folder" }));
    expect(calls).toContainEqual({
      cmd: "plugin:opener|reveal_item_in_dir",
      args: { paths: [expect.stringContaining("Neon Nights stems/drums - Neon Nights.wav")] },
    });
  });

  it("does nothing when the native dialog is cancelled", async () => {
    const { user, calls } = setup();
    backend.saveResult = null;
    await user.click(run());
    expect(calls.some((c) => c.cmd === "stems_export_mixed")).toBe(false);
    expect(run()).toBeEnabled();
    expect(screen.queryByRole("progressbar")).toBeNull();
    backend.dialogResult = null;
    await user.click(choose("One file per stem"));
    await user.click(run());
    expect(calls.some((c) => c.cmd === "stems_export_batch")).toBe(false);
  });

  it("shows the progress, can be cancelled, and holds the dialog open while it writes", async () => {
    const exportHeld = held();
    const { user, calls, onOpenChange } = setup({
      overrides: {
        stems_export_mixed: async () => {
          await emit("stems-export-progress", { stage: "mixing", fraction: 0.4 });
          return exportHeld.handler();
        },
      },
    });
    await user.click(run());
    const bar = await screen.findByRole("progressbar", { name: "Export progress" });
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "40"));
    // Neither Escape nor the corner X (hidden) can close it; the footer Close is off.
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      within(dialog())
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Cancel", "Close", "Export mix"]);
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(run()).toBeDisabled();
    await expectNoA11yViolations(dialog());

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls).toContainEqual({ cmd: "stems_cancel", args: {} });
    // Rust answers a stopped export with its stopped message: back to the options, no error.
    await exportHeld.fail({ kind: "audio", message: "Stem file stopped." });
    expect(await screen.findByTestId("export-stems-run")).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("shows an error as an alert and offers the options again", async () => {
    const exportHeld = held();
    const { user } = setup({ overrides: { stems_export_mixed: exportHeld.handler } });
    await user.click(run());
    await screen.findByRole("progressbar", { name: "Export progress" });
    await exportHeld.fail({ kind: "io", message: "There is not enough free space to export." });
    expect(await screen.findByRole("alert")).toHaveTextContent("not enough free space");
    expect(run()).toBeEnabled();
    expect(stem("drums")).toBeChecked();
    await expectNoA11yViolations(dialog());
  });

  it("goes back from the result to the options, with the choices kept", async () => {
    const { user } = setup();
    await user.click(stem("drums"));
    await user.click(choose("FLAC"));
    await user.click(run());
    await screen.findByText("Exported the mix");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(stem("drums")).not.toBeChecked();
    expect(choose("FLAC")).toBeChecked();
  });

  describe("add to a tab", () => {
    it("hides the option when the page cannot add stems", () => {
      setup({ withTabs: false });
      expect(screen.queryByRole("radio", { name: "Add to a tab" })).toBeNull();
      expect(choose("One mixed file")).toBeInTheDocument();
    });

    it("lists the open tabs and a new tab, and adds the chosen stems to the picked tab", async () => {
      const { user, onAddToTab, calls } = setup();
      await user.click(choose("Add to a tab"));
      expect(run()).toHaveTextContent("Add to tab");
      // The first open tab is the default.
      expect(screen.getByTestId("export-tab-1")).toBeChecked();
      expect(screen.getByTestId("export-tab-2")).not.toBeChecked();
      expect(screen.getByTestId("export-tab-new")).not.toBeChecked();
      expect(screen.queryByRole("radio", { name: "WAV" })).toBeNull();
      await user.click(screen.getByTestId("export-tab-2"));
      await user.click(stem("panned"));
      await user.click(stem("other"));
      await user.click(run());

      expect(onAddToTab).toHaveBeenCalledWith(2, STEM_SONG, ["drums", "bass", "vocals"]);
      expect(await screen.findByText("Added 3 audio tracks")).toBeInTheDocument();
      expect(screen.getByTestId("export-stems-added")).toHaveTextContent("Neon Nights.gp");
      // Nothing is written and no file dialog opens for a tab.
      expect(calls.some((c) => c.cmd.startsWith("plugin:dialog"))).toBe(false);
      await expectNoA11yViolations(dialog());
    });

    it("adds to a new tab, which is the default when no tab is open", async () => {
      const added = vi.fn(
        async (_target: number | "new", _song: StemSong, kinds: readonly StemKindId[]) => ({
          tab: "Neon Nights stems",
          count: kinds.length,
        }),
      );
      const { user } = setup({ tabs: [], onAddToTab: added });
      await user.click(choose("Add to a tab"));
      expect(screen.getByTestId("export-tab-new")).toBeChecked();
      await user.click(run());
      expect(added).toHaveBeenCalledWith("new", STEM_SONG, [
        "drums",
        "bass",
        "vocals",
        "panned",
        "other",
      ]);
      expect(await screen.findByText("Added 5 audio tracks")).toBeInTheDocument();
    });

    it("says 1 track for one stem", async () => {
      const added = vi.fn(async () => ({ tab: "Neon Nights.gp", count: 1 }));
      const { user } = setup({ onAddToTab: added });
      await user.click(choose("Add to a tab"));
      await user.click(screen.getByRole("button", { name: "None" }));
      await user.click(stem("bass"));
      await user.click(run());
      expect(await screen.findByText("Added 1 audio track")).toBeInTheDocument();
    });

    it("shows why the tab could not take the stems", async () => {
      const failing = vi.fn(async () => {
        throw new Error("This tab has room for 2 more audio tracks (up to 16), and 5 were chosen.");
      });
      const { user } = setup({ onAddToTab: failing });
      await user.click(choose("Add to a tab"));
      await user.click(run());
      expect(await screen.findByRole("alert")).toHaveTextContent("room for 2 more audio tracks");
      expect(run()).toBeEnabled();
    });
  });
});
