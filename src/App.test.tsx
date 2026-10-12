/**
 * Integration tests: the whole UI with the Tauri IPC layer mocked to behave
 * like the Rust core (commands + menu events).
 */
import { act, screen, waitFor, within } from "@testing-library/react";

import { App } from "@/App";
import { fileKey } from "@/lib/score/format";
import { mixFromScore } from "@/lib/score/mixer";
import type { MenuAction } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { FakeScorePlayer } from "@/test/fake-score-player";
import { renderWithProviders } from "@/test/render";
import { fixtureBytes, SUMMARY } from "@/test/score";
import {
  APP_INFO,
  backend,
  emitFileDrag,
  emitMenuAction,
  emitOpenRecent,
  mockTauri,
} from "@/test/tauri";

// alphaTab needs a real browser to render and play: see e2e/score.spec.ts.
vi.mock("@/lib/score/player", async () => ({
  ScorePlayer: (await import("@/test/fake-score-player")).FakeScorePlayer,
}));

// Import from Audio is behind the audio-2-tab flag, which is off in src/lib/features.json.
const flags = vi.hoisted(() => ({ audio: true }));
vi.mock("@/lib/features", () => ({
  isEnabled: (id: string) => id === "audio-2-tab" && flags.audio,
}));

const SONG = "/Users/me/Songs/practice-song.gp";
const OTHER_SONG = "/Users/me/Songs/structure-song.gp";

async function renderApp() {
  const calls = mockTauri();
  const utils = renderWithProviders(<App />);
  // Wait until the menu listener is registered.
  await waitFor(async () => {
    await act(() => emitMenuAction("shortcuts"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  await utils.user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  return { ...utils, calls };
}

/** The tabs of the open songs. */
const openTabs = () =>
  within(screen.getByRole("navigation", { name: "Open songs" })).getAllByRole("listitem");

async function menu(action: MenuAction) {
  await act(() => emitMenuAction(action));
}

describe("App", () => {
  it("hides Import from Audio while the audio-2-tab feature is off", async () => {
    flags.audio = false;
    try {
      await renderApp();
      expect(screen.queryByRole("button", { name: "Import from Audio…" })).not.toBeInTheDocument();
      await menu("import-audio");
      expect(screen.queryByRole("dialog", { name: "Import from Audio" })).not.toBeInTheDocument();
    } finally {
      flags.audio = true;
    }
  });

  it("launches transcription from welcome, the native menu and the open song's File menu", async () => {
    const { user } = await renderApp();
    await user.click(screen.getByRole("button", { name: "Import from Audio…" }));
    expect(await screen.findByRole("dialog", { name: "Import from Audio" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await menu("import-audio");
    expect(await screen.findByRole("dialog", { name: "Import from Audio" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    backend.dialogResult = SONG;
    await menu("open");
    await screen.findByRole("heading", { name: "Practice Song" }, { timeout: 5_000 });
    // Beside Open, in the File menu.
    const fileButtons = screen.getAllByRole("button", { name: "File" });
    await user.click(fileButtons[fileButtons.length - 1]!);
    await user.click(await screen.findByRole("menuitem", { name: "Import from Audio…" }));
    expect(await screen.findByRole("dialog", { name: "Import from Audio" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(openTabs()).toHaveLength(1);
  });

  it("renders the app shell with landmarks", async () => {
    await renderApp();

    // The title is the wordmark image.
    expect(
      within(screen.getByRole("banner")).getByRole("img", { name: "Smart Beat" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    await expectNoA11yViolations(document.body, { page: true });
  });

  it("starts keyboard navigation with a skip link to the main content", async () => {
    const { user } = await renderApp();

    await user.tab();
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute("href", "#main");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");

    // The logo is a button now: back to the start screen.
    await user.tab();
    expect(screen.getByRole("button", { name: "Smart Beat" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Theme" })).toHaveFocus();
  });

  it("Help → About shows version details from the Rust core", async () => {
    const { calls } = await renderApp();

    await menu("about");

    const dialog = await screen.findByRole("dialog", { name: "Smart Beat" });
    expect(await within(dialog).findByText(APP_INFO.version)).toBeInTheDocument();
    expect(calls.some((c) => c.cmd === "app_info")).toBe(true);
  });

  it("Help → Keyboard Shortcuts lists shortcuts from the Rust core", async () => {
    await renderApp();

    await menu("shortcuts");

    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(await within(dialog).findByText("Toggle Dark Mode")).toBeInTheDocument();
  });

  it("Smart Beat → Settings… opens the settings", async () => {
    await renderApp();

    await menu("settings");

    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("Help → Open-Source Licenses shows the notices", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("tauri — MIT OR Apache-2.0")));
    await renderApp();

    await menu("licenses");

    const dialog = await screen.findByRole("dialog", { name: "Open-source licenses" });
    expect(await within(dialog).findByText(/tauri — MIT OR Apache-2.0/)).toBeInTheDocument();
  });

  it("Help → Check for Updates… says when this is the latest version", async () => {
    await renderApp();

    await menu("check-for-updates");

    const dialog = await screen.findByRole("dialog", { name: "You're up to date" });
    expect(dialog).toHaveTextContent(`Smart Beat ${APP_INFO.version} is the latest version.`);
  });

  it("Help → Check for Updates… offers a new version and installs it only when asked", async () => {
    const { calls, user } = await renderApp();
    backend.update = { version: "0.2.0", body: "- Update dialog." };

    await menu("check-for-updates");

    const dialog = await screen.findByRole("dialog", { name: "Update available" });
    expect(within(dialog).getByText("0.2.0")).toBeInTheDocument();
    expect(within(dialog).getByRole("region", { name: "Release notes" })).toHaveTextContent(
      "- Update dialog.",
    );
    expect(calls.some((c) => c.cmd === "plugin:updater|download_and_install")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Download & Install" }));

    await waitFor(() => expect(calls.some((c) => c.cmd === "plugin:process|restart")).toBe(true));
    expect(calls.map((c) => c.cmd)).toContain("plugin:updater|download_and_install");
  });

  it("Help → Check for Updates… reports a failed check", async () => {
    await renderApp();
    backend.updateError = { during: "check", message: "Could not fetch a valid release JSON." };

    await menu("check-for-updates");

    const dialog = await screen.findByRole("dialog", { name: "Couldn't update Smart Beat" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Could not fetch a valid release JSON.",
    );
  });

  it("the in-window Help menu has Check for Updates… in the desktop app", async () => {
    const { user } = await renderApp();

    await user.click(screen.getByRole("button", { name: "Help" }));
    await user.click(await screen.findByRole("menuitem", { name: "Check for Updates…" }));

    expect(await screen.findByRole("dialog", { name: "You're up to date" })).toBeInTheDocument();
  });

  it("View → Toggle Dark Mode switches the theme and the native title bar", async () => {
    const { calls } = await renderApp();

    await menu("toggle-theme");

    await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
    expect(calls).toContainEqual(
      expect.objectContaining({
        cmd: "plugin:window|set_theme",
        args: expect.objectContaining({ value: "dark" }),
      }),
    );
  });

  it("File → Open… opens a Guitar Pro file picked in the native dialog", async () => {
    const { calls } = await renderApp();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    backend.dialogResult = SONG;

    await menu("open");

    expect(
      // Opening parses the file and builds the workspace: slower when the suite runs in parallel.
      await screen.findByRole("heading", { level: 1, name: "Practice Song" }, { timeout: 5_000 }),
    ).toBeInTheDocument();
    expect(calls).toContainEqual(expect.objectContaining({ cmd: "plugin:dialog|open" }));
    expect(calls).toContainEqual({ cmd: "read_score_file", args: { path: SONG } });
    expect(calls).toContainEqual(
      expect.objectContaining({
        cmd: "plugin:window|set_title",
        args: expect.objectContaining({ value: "Practice Song — Smart Beat" }),
      }),
    );
    expect(screen.getByRole("region", { name: "Score: Guitar" })).toBeInTheDocument();
    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument(); // room for the score
    expect(FakeScorePlayer.last.options.score.title).toBe("Practice Song");

    FakeScorePlayer.last.becomeReady();
    await expectNoA11yViolations(document.body, { page: true });
  });

  it("does nothing when the Open dialog is cancelled", async () => {
    const { calls, user } = await renderApp();

    await user.click(screen.getByRole("button", { name: "Open a file…" }));

    await waitFor(() =>
      expect(calls).toContainEqual(expect.objectContaining({ cmd: "plugin:dialog|open" })),
    );
    expect(calls.some((c) => c.cmd === "read_score_file")).toBe(false);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/Write, play/);
  });

  it("opens a file dropped onto the window", async () => {
    await renderApp();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));

    const overlay = document.querySelector("[data-slot=drop-overlay]");
    expect(overlay).toHaveAttribute("data-visible", "false");
    await act(() => emitFileDrag({ type: "enter", paths: [SONG] }));
    expect(overlay).toHaveAttribute("data-visible", "true");
    expect(overlay).toHaveTextContent("Drop a song to open it");
    await act(() => emitFileDrag({ type: "drop", paths: ["/Users/me/notes.pdf", SONG] }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Practice Song" }),
    ).toBeInTheDocument();
    expect(overlay).toHaveAttribute("data-visible", "false");
  });

  it("explains why a damaged file can't be opened", async () => {
    await renderApp();
    backend.files.set("/songs/corrupt.gp5", fixtureBytes("corrupt.gp5"));

    await act(() => emitFileDrag({ type: "drop", paths: ["/songs/corrupt.gp5"] }));

    expect(await screen.findByText("Couldn't open “corrupt.gp5”")).toBeInTheDocument();
    expect(screen.getByText(/damaged or is in a format Smart Beat can't read/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/Write, play/);
  });

  it("explains which files it opens", async () => {
    await renderApp();

    await act(() => emitFileDrag({ type: "drop", paths: ["/Users/me/scan.pdf"] }));

    expect(await screen.findByText("Couldn't open “scan.pdf”")).toBeInTheDocument();
    expect(screen.getByText(/opens Guitar Pro, MusicXML, MIDI, MuseScore/)).toBeInTheDocument();
  });

  it("restores the mix saved for a song and saves changes", async () => {
    const { calls, user } = await renderApp();
    const bytes = fixtureBytes("practice-song.gp");
    const key = await fileKey(bytes);
    const saved = mixFromScore(SUMMARY);
    saved.tracks[2] = { ...saved.tracks[2]!, solo: true };
    backend.mixes.set(key, saved);
    backend.files.set(SONG, bytes);
    backend.dialogResult = SONG;

    await menu("open");
    expect(await screen.findByRole("button", { name: "Solo Drums" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(FakeScorePlayer.last.options.mix).toEqual(saved);

    await user.click(screen.getByRole("button", { name: "Solo Drums" }));

    await waitFor(() => expect(backend.mixes.get(key)?.tracks[2]?.solo).toBe(false));
    expect(calls).toContainEqual(expect.objectContaining({ cmd: "load_mixer_settings" }));
  });

  it("opens another song from the workspace in a new tab and keeps the first one", async () => {
    const { user } = await renderApp();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    backend.files.set(OTHER_SONG, fixtureBytes("structure-song.gp"));
    backend.dialogResult = SONG;
    await menu("open");
    await screen.findByRole("heading", { level: 1, name: "Practice Song" });
    const first = FakeScorePlayer.last;

    backend.dialogResult = OTHER_SONG;
    await user.click(screen.getByRole("button", { name: "Open…" }));

    await waitFor(() => expect(FakeScorePlayer.last).not.toBe(first));
    expect(first.destroy).not.toHaveBeenCalled();
    const tabs = within(screen.getByRole("navigation", { name: "Open songs" }));
    expect(tabs.getAllByRole("listitem")).toHaveLength(2);
    expect(tabs.getByRole("button", { name: "Structure Song" })).toHaveAttribute(
      "aria-current",
      "true",
    );

    // Back to the first song: still loaded, and it stops playing while hidden.
    await user.click(tabs.getByRole("button", { name: "Practice Song" }));
    expect(first.pause).toHaveBeenCalled(); // paused when the second song came forward
    expect(FakeScorePlayer.last.pause).toHaveBeenCalled(); // and the second when the first returned
    expect(
      await screen.findByRole("heading", { level: 1, name: "Practice Song" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("region", { name: /^Score:/ })).toHaveLength(1);
  });

  it("reports a failing Open dialog", async () => {
    mockTauri({
      "plugin:dialog|open": () => {
        throw new Error("Dialog unavailable");
      },
    });
    const { user } = renderWithProviders(<App />);

    await user.click(screen.getByRole("button", { name: "Open a file…" }));

    expect(await screen.findByText("Couldn't show the Open dialog")).toBeInTheDocument();
  });

  it("File → New starts an empty song in edit mode", async () => {
    const { calls } = await renderApp();

    await menu("new-song");

    expect(await screen.findByRole("heading", { level: 1, name: "Untitled" })).toBeInTheDocument();
    expect(await screen.findByRole("toolbar", { name: "Edit" })).toBeInTheDocument();
    expect(FakeScorePlayer.last.options.score.masterBars).toHaveLength(4);
    expect(calls).toContainEqual(
      expect.objectContaining({
        cmd: "plugin:window|set_title",
        args: expect.objectContaining({ value: "Untitled — Smart Beat" }),
      }),
    );
    // A new song has no file, so its mix isn't saved.
    expect(calls.some((c) => c.cmd === "load_mixer_settings")).toBe(false);
    await waitFor(() => expect(backend.menuState?.songOpen).toBe(true));
  });

  it("starts a new song from the welcome screen", async () => {
    const { user } = renderWithProviders(<App />);
    await user.click(screen.getByRole("button", { name: "New song" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Untitled" })).toBeInTheDocument();
  });

  it("opens songs in tabs and asks before closing one with changes", async () => {
    const { user } = await renderApp();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    backend.dialogResult = SONG;
    await menu("new-song");
    await screen.findByRole("toolbar", { name: "Edit" });
    const score = screen.getByRole("region", { name: /^Score:/ });
    await waitFor(() => expect(score).toHaveFocus());
    await user.keyboard("5");
    expect(await screen.findByText("Edited")).toBeInTheDocument();

    // Opening another song does not touch the edited one.
    await menu("open");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Practice Song" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Untitled \(edited\)$/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close Untitled" }));
    const confirm = await screen.findByRole("alertdialog", {
      name: "Discard your changes to “Untitled”?",
    });
    expect(confirm).toHaveTextContent("Your unsaved changes will be lost");
    await expectNoA11yViolations();
    await user.click(within(confirm).getByRole("button", { name: "Keep editing" }));
    expect(openTabs()).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Close Untitled" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Discard changes",
      }),
    );
    expect(openTabs()).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Practice Song" })).toBeInTheDocument();

    // A song without changes closes without a question; the last close shows the welcome screen.
    await user.click(screen.getByRole("button", { name: "Close Practice Song" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open a file…" })).toBeInTheDocument();
  }, 60_000); // Opens, edits and closes tabs and runs an axe scan: over 20 s on a slow CI runner.

  it("ignores actions the Rust core handles natively", async () => {
    await renderApp();

    await menu("zoom-in");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens dialogs from the in-window Help menu and restores focus on close", async () => {
    const { user } = await renderApp();
    const help = screen.getByRole("button", { name: "Help" });

    await user.click(help);
    await user.click(await screen.findByRole("menuitem", { name: "About Smart Beat" }));
    expect(await screen.findByRole("dialog", { name: "Smart Beat" })).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(help).toHaveFocus();
  });

  it("opens files with a file picker in a plain browser", async () => {
    const { user } = renderWithProviders(<App />);
    const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
    const click = vi.spyOn(input, "click");
    expect(input).toHaveAttribute(
      "accept",
      ".gp3,.gp4,.gp5,.gpx,.gp,.mid,.midi,.musicxml,.mxl,.xml,.mscx,.mscz,.atex,.capx,.txt",
    );

    await user.click(screen.getByRole("button", { name: "Open a file…" }));
    expect(click).toHaveBeenCalled();
    await user.upload(input, new File([fixtureBytes("practice-song.gp").slice()], "song.gp"));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Practice Song" }),
    ).toBeInTheDocument();
    expect(document.title).toBe("Practice Song — Smart Beat");
    expect(input.value).toBe(""); // the same file can be picked again
  });

  it("keeps working in a plain browser without the Rust core", async () => {
    const { user } = renderWithProviders(<App />);

    await user.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Shortcuts are unavailable.");
  });
});

describe("App: recent songs and saving", () => {
  const OTHER = "/Users/me/Songs/structure-song.gp";

  async function renderWithRecent() {
    mockTauri();
    backend.recent = [SONG, OTHER];
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    backend.files.set(OTHER, fixtureBytes("structure-song.gp"));
    const utils = renderWithProviders(<App />);
    await screen.findByRole("heading", { level: 2, name: "Recent songs" });
    return utils;
  }

  it("lists the recent songs on the welcome screen and opens one", async () => {
    const { user } = await renderWithRecent();
    const list = screen.getByRole("heading", { name: "Recent songs" }).closest("section")!;
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["practice-song.gpSongs", "structure-song.gpSongs"]);

    await user.click(within(list).getByRole("button", { name: /structure-song\.gp/ }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Structure Song" }),
    ).toBeInTheDocument();
    // The opened song moves to the top of the list.
    expect(backend.recent).toEqual([OTHER, SONG]);
  });

  it("opens the song File › Open Recent names", async () => {
    await renderWithRecent();
    await waitFor(async () => {
      await act(() => emitOpenRecent(SONG));
      expect(
        await screen.findByRole("heading", { level: 1, name: "Practice Song" }),
      ).toBeInTheDocument();
    });
  });

  it("File › Open Recent opens the song in a new tab, leaving an edited song alone", async () => {
    const { user } = await renderApp();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    await menu("new-song");
    await screen.findByRole("toolbar", { name: "Edit" });
    const score = screen.getByRole("region", { name: /^Score:/ });
    await waitFor(() => expect(score).toHaveFocus());
    await user.keyboard("5");
    await screen.findByText("Edited");

    await act(() => emitOpenRecent(SONG));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Practice Song" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(openTabs()).toHaveLength(2);
  });

  it("drops a recent song that is gone from the list", async () => {
    const { user } = await renderWithRecent();
    backend.files.delete(OTHER);
    // A file the Rust core can no longer read answers not-found.
    const list = screen.getByRole("heading", { name: "Recent songs" }).closest("section")!;

    await user.click(within(list).getByRole("button", { name: /structure-song\.gp/ }));

    await waitFor(() => expect(backend.recent).toEqual([SONG]));
    await waitFor(() =>
      expect(
        within(list).queryByRole("button", { name: /structure-song\.gp/ }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Write, play and arrange guitar music",
    );
  });

  it("saves the open song to a new file and stops calling it edited", async () => {
    const { user } = await renderWithRecent();
    await user.click(screen.getByRole("button", { name: /practice-song\.gp/ }));
    await screen.findByRole("heading", { level: 1, name: "Practice Song" });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const score = screen.getByRole("region", { name: /^Score:/ });
    await waitFor(() => expect(score).toHaveFocus());
    await user.keyboard("{Delete}");
    await screen.findByText("Edited");
    backend.saveResult = "/Users/me/Songs/renamed.gp";

    await menu("save-as");

    await waitFor(() => expect(backend.written.has("/Users/me/Songs/renamed.gp")).toBe(true));
    await waitFor(() => expect(screen.queryByText("Edited")).not.toBeInTheDocument());
    // Saved: replacing the song needs no question.
    await menu("new-song");
    expect(await screen.findByRole("heading", { level: 1, name: "Untitled" })).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("Save replaces the file it came from, and the next Save writes there again", async () => {
    const { user } = await renderWithRecent();
    await user.click(screen.getByRole("button", { name: /practice-song\.gp/ }));
    await screen.findByRole("heading", { level: 1, name: "Practice Song" });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const score = screen.getByRole("region", { name: /^Score:/ });
    await waitFor(() => expect(score).toHaveFocus());
    await user.keyboard("{Delete}");
    await screen.findByText("Edited");

    await menu("save");
    await waitFor(() => expect(backend.written.has(SONG)).toBe(true));
    await waitFor(() => expect(screen.queryByText("Edited")).not.toBeInTheDocument());

    backend.written.clear();
    await user.keyboard("{ArrowRight}{Delete}");
    await screen.findByText("Edited");
    await menu("save");
    await waitFor(() => expect(backend.written.has(SONG)).toBe(true));
  });
});
