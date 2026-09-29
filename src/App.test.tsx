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
import { APP_INFO, backend, emitFileDrag, emitMenuAction, mockTauri } from "@/test/tauri";

// alphaTab needs a real browser to render and play: see e2e/score.spec.ts.
vi.mock("@/lib/score/player", async () => ({
  ScorePlayer: (await import("@/test/fake-score-player")).FakeScorePlayer,
}));

const SONG = "/Users/me/Songs/practice-song.gp";

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

async function menu(action: MenuAction) {
  await act(() => emitMenuAction(action));
}

describe("App", () => {
  it("renders the app shell with landmarks", async () => {
    await renderApp();

    expect(screen.getByRole("banner")).toHaveTextContent("Smart Beat");
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

  it("Help → Open-Source Licenses shows the notices", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("tauri — MIT OR Apache-2.0")));
    await renderApp();

    await menu("licenses");

    const dialog = await screen.findByRole("dialog", { name: "Open-source licenses" });
    expect(await within(dialog).findByText(/tauri — MIT OR Apache-2.0/)).toBeInTheDocument();
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
      await screen.findByRole("heading", { level: 1, name: "Practice Song" }),
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
    expect(overlay).toHaveTextContent("Drop a Guitar Pro file to open it");
    await act(() => emitFileDrag({ type: "drop", paths: ["/Users/me/notes.txt", SONG] }));

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
    expect(screen.getByText(/damaged or uses a Guitar Pro version/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/Write, play/);
  });

  it("explains which files it opens", async () => {
    await renderApp();

    await act(() => emitFileDrag({ type: "drop", paths: ["/Users/me/scan.pdf"] }));

    expect(await screen.findByText("Couldn't open “scan.pdf”")).toBeInTheDocument();
    expect(screen.getByText(/opens Guitar Pro files/)).toBeInTheDocument();
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
    await user.click(await screen.findByRole("button", { name: "Mixer" }));

    expect(screen.getByRole("button", { name: "Solo Drums" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(FakeScorePlayer.last.options.mix).toEqual(saved);

    await user.click(screen.getByRole("button", { name: "Solo Drums" }));

    await waitFor(() => expect(backend.mixes.get(key)?.tracks[2]?.solo).toBe(false));
    expect(calls).toContainEqual(expect.objectContaining({ cmd: "load_mixer_settings" }));
  });

  it("opens another song from the workspace", async () => {
    const { user } = await renderApp();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    backend.dialogResult = SONG;
    await menu("open");
    await screen.findByRole("heading", { level: 1, name: "Practice Song" });
    const first = FakeScorePlayer.last;

    await user.click(screen.getByRole("button", { name: "Open…" }));

    await waitFor(() => expect(FakeScorePlayer.last).not.toBe(first));
    expect(first.destroy).toHaveBeenCalled();
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

  it("asks before replacing a song with changes, and keeps it if asked to", async () => {
    const { user } = await renderApp();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    backend.dialogResult = SONG;
    await menu("new-song");
    await screen.findByRole("toolbar", { name: "Edit" });
    const score = screen.getByRole("region", { name: /^Score:/ });
    await waitFor(() => expect(score).toHaveFocus());
    await user.keyboard("5");
    expect(await screen.findByText("Edited")).toBeInTheDocument();

    await menu("open");
    const confirm = await screen.findByRole("alertdialog", {
      name: "Discard your changes to “Untitled”?",
    });
    expect(confirm).toHaveTextContent("Smart Beat can't save songs yet");
    await expectNoA11yViolations();
    await user.click(within(confirm).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("heading", { level: 1, name: "Untitled" })).toBeInTheDocument();

    await act(() => emitFileDrag({ type: "drop", paths: [SONG] }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Discard changes",
      }),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Practice Song" }),
    ).toBeInTheDocument();

    // The opened song has no changes: no question.
    await menu("new-song");
    expect(await screen.findByRole("heading", { level: 1, name: "Untitled" })).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

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
    expect(input).toHaveAttribute("accept", ".gp3,.gp4,.gp5,.gpx,.gp");

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
