/**
 * Integration tests: the whole UI with the Tauri IPC layer mocked to behave
 * like the Rust core (commands + menu events).
 */
import { closeInstaller, openInstaller } from "@/lib/ai/ai-store";
import { act, screen, waitFor, within } from "@testing-library/react";

import { App } from "@/App";
import { APP_VERSION } from "@/lib/project-info";
import { fileKey } from "@/lib/score/format";
import { mixFromScore } from "@/lib/score/mixer";
import type { MenuAction } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { FakeScorePlayer } from "@/test/fake-score-player";
import { TOUR_STORAGE_KEY } from "@/lib/tour/tour-store";
import { renderWithProviders } from "@/test/render";
import { fixtureBytes, SUMMARY } from "@/test/score";
import {
  APP_INFO,
  backend,
  emitFileDrag,
  emitMenuAction,
  emitOpenRecent,
  emitStemBundleOpened,
  mockTauri,
  STEM_SONG,
} from "@/test/tauri";

// alphaTab needs a real browser to render and play: see e2e/score.spec.ts.
vi.mock("@/lib/score/player", async () => ({
  ScorePlayer: (await import("@/test/fake-score-player")).FakeScorePlayer,
}));

// The drive's song list has its own tests: here it only reports what is picked.
vi.mock("@/components/cloud-open-dialog", () => ({
  CloudOpenDialog: ({
    label,
    onPick,
    onSetupCloud,
  }: {
    label: string;
    onPick: (item: string) => void;
    onSetupCloud?: () => void;
  }) => (
    <div role="dialog" aria-label={`Tabs in ${label}`}>
      <button onClick={() => onPick("drive:abc")}>Pick drive tab</button>
      <button onClick={onSetupCloud}>Picker setup link</button>
    </div>
  ),
}));

// The real dialog lists the saved stems of every place; here it only offers its three ways out.
vi.mock("@/components/stems/open-stems-dialog", () => ({
  OpenStemsDialog: ({
    open,
    onPickComputer,
    onOpenStem,
    onSetupCloud,
    onOpenedSong,
  }: {
    open: boolean;
    onPickComputer: () => void;
    onOpenStem: (path: string) => void;
    onSetupCloud: () => void;
    onOpenedSong?: (song: typeof STEM_SONG) => void;
  }) =>
    open ? (
      <div role="dialog" aria-label="Open stems dialog">
        <button onClick={onPickComputer}>Computer</button>
        <button onClick={() => onOpenStem("/Cloud/Picked.sbstems")}>Pick a cloud stem</button>
        <button
          onClick={() =>
            onOpenedSong?.({ ...STEM_SONG, id: "cccccccccccccccc", name: "From Drive" })
          }
        >
          Pick an account stem
        </button>
        <button onClick={onSetupCloud}>Stems cloud setup</button>
      </div>
    ) : null,
}));

// Import from Audio is behind the audio-2-tab flag, which is off in src/lib/features.json.
const flags = vi.hoisted(() => ({ audio: true, stems: false }));
vi.mock("@/lib/features", () => ({
  isEnabled: (id: string) =>
    (id === "audio-2-tab" && flags.audio) || (id === "stem-separation" && flags.stems),
}));

const SONG = "/Users/me/Songs/practice-song.gp";
const OTHER_SONG = "/Users/me/Songs/structure-song.gp";

// Someone who has already seen What's new for this version: the dialog an update opens once
// would otherwise sit over every test.
beforeEach(() => {
  backend.driveStems = {};
  backend.driveTabs = {};
  localStorage.setItem(
    TOUR_STORAGE_KEY,
    JSON.stringify({ tours: { main: "skipped" }, hints: {}, lastSeenVersion: APP_VERSION }),
  );
});

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
      expect(screen.queryByRole("button", { name: "Import from Audio" })).not.toBeInTheDocument();
      await menu("import-audio");
      expect(screen.queryByRole("dialog", { name: "Import from Audio" })).not.toBeInTheDocument();
    } finally {
      flags.audio = true;
    }
  });

  it("launches transcription from welcome and from the AI menu, also with a song open", async () => {
    const { user } = await renderApp();
    await user.click(screen.getByRole("button", { name: "Import from Audio" }));
    expect(await screen.findByRole("dialog", { name: "Import from Audio" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await menu("import-audio");
    expect(await screen.findByRole("dialog", { name: "Import from Audio" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    backend.dialogResult = SONG;
    await menu("open");
    await screen.findByRole("heading", { name: "Practice Song" }, { timeout: 5_000 });
    // With a song open the AI menu's item still opens it.
    await menu("import-audio");
    expect(await screen.findByRole("dialog", { name: "Import from Audio" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(openTabs()).toHaveLength(1);
  });

  it("opens Record to Tab Models and Stem Separation Models from the AI menu", async () => {
    const { user } = await renderApp();
    await menu("record-models");
    expect(await screen.findByTestId("record-models-dialog")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Record to Tab Models" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("record-models-dialog")).toBeNull());
    await menu("stem-models");
    expect(await screen.findByTestId("stem-models-dialog")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Stem Separation Models" })).toBeInTheDocument();
  });

  it("comes back to Record to Tab Models when the installer it opened closes", async () => {
    await renderApp();
    await menu("record-models");
    await screen.findByTestId("record-models-dialog");
    act(() => {
      openInstaller("models");
    });
    expect(await screen.findByTestId("ai-installer")).toBeInTheDocument();
    act(() => closeInstaller());
    expect(await screen.findByTestId("record-models-dialog")).toBeInTheDocument();
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

  it("Smart Beat → Settings opens the settings", async () => {
    await renderApp();

    await menu("settings");

    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("Help → Cloud Storage Settings opens the settings on the cloud storage section", async () => {
    await renderApp();

    await menu("cloud-settings");

    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const cloud = await within(dialog).findByRole("region", { name: "Cloud storage" });
    await waitFor(() => expect(cloud).toHaveFocus());
  });

  describe("Open with an online drive", () => {
    const DRIVE = { provider: "drive", label: "Google Drive", account: "me@example.com" };
    const OTHER = { provider: "onedrive", label: "OneDrive", account: "me@example.com" };

    it("opens the native dialog straight away when the drives cannot be listed", async () => {
      await renderApp();
      backend.files.set(SONG, fixtureBytes("practice-song.gp"));
      backend.dialogResult = SONG;
      await menu("open");
      await screen.findByRole("heading", { name: "Practice Song" }, { timeout: 5_000 });
      expect(screen.queryByTestId("save-target-dialog")).not.toBeInTheDocument();
    });

    it("asks where first even when no drive is set up, with all of them disabled", async () => {
      const { user } = await renderApp();
      backend.files.set(SONG, fixtureBytes("practice-song.gp"));
      backend.cloudAccounts = [
        { ...DRIVE, account: null },
        { ...OTHER, account: null },
      ];
      backend.dialogResult = SONG;
      await menu("open");
      const chooser = await screen.findByRole("dialog", { name: "Where is the song?" });
      expect(within(chooser).getByRole("button", { name: /Google Drive/ })).toBeDisabled();
      expect(within(chooser).getByRole("button", { name: /OneDrive/ })).toBeDisabled();
      // This computer and the set-up link stay available.
      await user.click(within(chooser).getByRole("button", { name: /Open from this computer/ }));
      await screen.findByRole("heading", { name: "Practice Song" }, { timeout: 5_000 });
    });

    it("asks where first and 'This computer' shows the native dialog", async () => {
      const { user } = await renderApp();
      backend.files.set(SONG, fixtureBytes("practice-song.gp"));
      backend.cloudAccounts = [DRIVE, { ...OTHER, account: null }];
      backend.dialogResult = SONG;
      await menu("open");
      const chooser = await screen.findByRole("dialog", { name: "Where is the song?" });
      expect(within(chooser).getByRole("button", { name: /OneDrive/ })).toBeDisabled();
      await user.click(within(chooser).getByRole("button", { name: /Open from this computer/ }));
      await screen.findByRole("heading", { name: "Practice Song" }, { timeout: 5_000 });
    });

    it("choosing the drive lists its tabs, and picking one opens it", async () => {
      const { user, calls } = await renderApp();
      backend.cloudAccounts = [DRIVE];
      await menu("open");
      await user.click(await screen.findByRole("button", { name: "Open from Google Drive" }));
      await user.click(await screen.findByRole("button", { name: "Pick drive tab" }));
      await waitFor(() =>
        expect(calls.some((c) => JSON.stringify(c.args ?? {}).includes("drive:abc"))).toBe(true),
      );
    });

    it("lists every provider, disabling the unavailable ones with a hint", async () => {
      await renderApp();
      backend.cloudAccounts = [
        DRIVE,
        { ...OTHER, account: null },
        { provider: "dropbox", label: "Dropbox", configured: false, account: null },
      ];
      await menu("open");
      const chooser = await screen.findByRole("dialog", { name: "Where is the song?" });
      expect(within(chooser).getByRole("button", { name: /Google Drive/ })).toBeEnabled();
      const oneDrive = within(chooser).getByRole("button", { name: /OneDrive/ });
      expect(oneDrive).toBeDisabled();
      expect(oneDrive).toHaveTextContent("Not connected");
      const dropbox = within(chooser).getByRole("button", { name: /Dropbox/ });
      expect(dropbox).toBeDisabled();
      expect(dropbox).toHaveTextContent("Not available in this build");
    });

    it("'Set up cloud storage' closes the chooser and opens the settings on the cloud section", async () => {
      const { user } = await renderApp();
      backend.cloudAccounts = [DRIVE, { ...OTHER, account: null }];
      await menu("open");
      await screen.findByRole("dialog", { name: "Where is the song?" });
      await user.click(screen.getByTestId("save-target-setup"));
      const dialog = await screen.findByRole("dialog", { name: "Settings" });
      const cloud = await within(dialog).findByRole("region", { name: "Cloud storage" });
      await waitFor(() => expect(cloud).toHaveFocus());
      expect(screen.queryByRole("dialog", { name: "Where is the song?" })).not.toBeInTheDocument();
    });

    it("the picker's 'Set up cloud storage' closes it and opens the settings", async () => {
      const { user } = await renderApp();
      backend.cloudAccounts = [DRIVE];
      await menu("open-cloud");
      await user.click(await screen.findByRole("button", { name: "Picker setup link" }));
      const dialog = await screen.findByRole("dialog", { name: "Settings" });
      expect(
        await within(dialog).findByRole("region", { name: "Cloud storage" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("dialog", { name: "Tabs in Google Drive" }),
      ).not.toBeInTheDocument();
    });

    it("Open from Cloud goes straight to the only drive", async () => {
      await renderApp();
      backend.cloudAccounts = [DRIVE];
      await menu("open-cloud");
      expect(
        await screen.findByRole("dialog", { name: "Tabs in Google Drive" }),
      ).toBeInTheDocument();
      expect(screen.queryByTestId("save-target-dialog")).not.toBeInTheDocument();
    });

    it("Open from Cloud asks which drive when several are connected", async () => {
      await renderApp();
      backend.cloudAccounts = [DRIVE, OTHER];
      await menu("open-cloud");
      expect(await screen.findByRole("button", { name: "Open from OneDrive" })).toBeInTheDocument();
    });

    it("Cloud Library lists the tabs and stems of the connected drives", async () => {
      await renderApp();
      backend.cloudAccounts = [DRIVE, { ...OTHER, account: null }];
      backend.driveStems = {
        drive: [
          { id: "drive:s1", name: "Neon Nights.sbstems", revision: "r", size: 1, modified_ms: 2 },
        ],
      };
      await menu("cloud-library");
      const dialog = await screen.findByRole("dialog", { name: "Cloud library" });
      expect(await within(dialog).findByText("Neon Nights")).toBeInTheDocument();
      expect(within(dialog).getByText("Not connected")).toBeInTheDocument();
    });

    it("a library tab opens like any cloud tab, and its dialog closes", async () => {
      const { user, calls } = await renderApp();
      backend.cloudAccounts = [DRIVE];
      backend.driveTabs = {
        drive: [{ id: "abc", name: "riff.gp", revision: "r", size: 1, modified_ms: 1 }],
      };
      await menu("cloud-library");
      const dialog = await screen.findByRole("dialog", { name: "Cloud library" });
      await user.click(await within(dialog).findByRole("button", { name: "Open riff.gp" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Cloud library" })).not.toBeInTheDocument(),
      );
      await waitFor(() =>
        expect(calls.find((c) => c.cmd === "cloud_read")?.args).toEqual({ item: "drive:abc" }),
      );
    });

    it("a library stems file is downloaded and opened as a stem page", async () => {
      const { user } = await renderApp();
      backend.cloudAccounts = [DRIVE];
      backend.driveStems = {
        drive: [
          { id: "drive:s1", name: "Opened Song.sbstems", revision: "r", size: 1, modified_ms: 2 },
        ],
      };
      await menu("cloud-library");
      const dialog = await screen.findByRole("dialog", { name: "Cloud library" });
      await user.click(await within(dialog).findByRole("button", { name: /^Open Opened Song/ }));
      expect(
        await screen.findByRole("heading", { level: 1, name: "Opened Song" }),
      ).toBeInTheDocument();
    });

    it("Cloud Library without a connected drive points to the settings", async () => {
      const { user } = await renderApp();
      backend.cloudAccounts = [{ ...OTHER, account: null }];
      await menu("cloud-library");
      const dialog = await screen.findByRole("dialog", { name: "Cloud library" });
      await user.click(await within(dialog).findByRole("button", { name: "Connect OneDrive" }));
      expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Cloud library" })).not.toBeInTheDocument();
    });

    it("Open from Cloud without an account points to the settings", async () => {
      await renderApp();
      await menu("open-cloud");
      expect(
        await screen.findByText("Connect a cloud account in Settings first"),
      ).toBeInTheDocument();
      const dialog = await screen.findByRole("dialog", { name: "Settings" });
      expect(
        await within(dialog).findByRole("region", { name: "Cloud storage" }),
      ).toBeInTheDocument();
    });
  });

  it("Help → Open-Source Licenses shows the notices", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("tauri — MIT OR Apache-2.0")));
    await renderApp();

    await menu("licenses");

    const dialog = await screen.findByRole("dialog", { name: "Open-source licenses" });
    expect(await within(dialog).findByText(/tauri — MIT OR Apache-2.0/)).toBeInTheDocument();
  });

  it("Help → Check for Updates says when this is the latest version", async () => {
    await renderApp();

    await menu("check-for-updates");

    const dialog = await screen.findByRole("dialog", { name: "You're up to date" });
    expect(dialog).toHaveTextContent(`Smart Beat ${APP_INFO.version} is the latest version.`);
  });

  it("Help → Check for Updates offers a new version and installs it only when asked", async () => {
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

  it("Help → Check for Updates reports a failed check", async () => {
    await renderApp();
    backend.updateError = { during: "check", message: "Could not fetch a valid release JSON." };

    await menu("check-for-updates");

    const dialog = await screen.findByRole("dialog", { name: "Couldn't update Smart Beat" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Could not fetch a valid release JSON.",
    );
  });

  it("the in-window Help menu has Check for Updates in the desktop app", async () => {
    const { user } = await renderApp();

    await user.click(screen.getByRole("button", { name: "Help" }));
    await user.click(await screen.findByRole("menuitem", { name: "Check for Updates" }));

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

  it("File → Open opens a Guitar Pro file picked in the native dialog", async () => {
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

  it("Practice together from the start screen: pick a tab for a new session, then its dialog goes on", async () => {
    const { user } = await renderApp();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    backend.dialogResult = SONG;

    await user.click(screen.getByRole("button", { name: "Practice together" }));
    const choice = await screen.findByTestId("practice-together-launcher");
    expect(within(choice).getByRole("radio", { name: "Start a new session" })).toBeChecked();
    await user.click(within(choice).getByRole("button", { name: "Pick a tab" }));
    await user.click(within(choice).getByRole("button", { name: "Open a file…" }));

    // The tab opens and its own dialog is already up, on starting the session.
    const dialog = await screen.findByTestId("practice-together-dialog", {}, { timeout: 5_000 });
    expect(within(dialog).getByRole("radio", { name: "Start a new session" })).toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Start a session" })).toBeInTheDocument();
  });

  it("Practice together from the start screen: joining opens a blank tab on the join form", async () => {
    const { user } = await renderApp();
    await user.click(screen.getByRole("button", { name: "Practice together" }));
    const choice = await screen.findByTestId("practice-together-launcher");
    await user.click(within(choice).getByRole("radio", { name: "Join an existing session" }));
    await user.click(within(choice).getByRole("button", { name: "Join a session" }));

    const dialog = await screen.findByTestId("practice-together-dialog", {}, { timeout: 5_000 });
    expect(within(dialog).getByRole("radio", { name: "Join an existing session" })).toBeChecked();
    expect(within(dialog).getByLabelText("Room code")).toBeInTheDocument();
  });

  it("does nothing when the Open dialog is cancelled", async () => {
    const { calls, user } = await renderApp();

    await user.click(screen.getByRole("button", { name: "Open a tab" }));

    await waitFor(() =>
      expect(calls).toContainEqual(expect.objectContaining({ cmd: "plugin:dialog|open" })),
    );
    expect(calls.some((c) => c.cmd === "read_score_file")).toBe(false);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/Practice, create/);
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
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/Practice, create/);
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
    await user.click(screen.getByRole("button", { name: "Open" }));

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

  it("the logo goes home without closing the song; the next song opens beside it", async () => {
    const { user } = await renderApp();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    backend.files.set(OTHER_SONG, fixtureBytes("structure-song.gp"));
    backend.dialogResult = SONG;
    await menu("open");
    await screen.findByRole("heading", { level: 1, name: "Practice Song" });
    const first = FakeScorePlayer.last;

    await user.click(screen.getByRole("button", { name: "Smart Beat" }));

    // The start screen, with the song still open: paused, not destroyed, its tab kept.
    expect(await screen.findByRole("button", { name: "Open a tab" })).toBeInTheDocument();
    expect(first.destroy).not.toHaveBeenCalled();
    expect(first.pause).toHaveBeenCalled();
    // The tabs are not shown on the start screen.
    expect(screen.queryByRole("navigation", { name: "Open songs" })).not.toBeInTheDocument();

    // Opening another song adds a tab next to the first and shows it.
    backend.dialogResult = OTHER_SONG;
    await user.click(screen.getByRole("button", { name: "Open a tab" }));
    await screen.findByRole("heading", { level: 1, name: "Structure Song" });
    const tabs = within(screen.getByRole("navigation", { name: "Open songs" }));
    expect(tabs.getAllByRole("listitem")).toHaveLength(2);
    expect(tabs.getByRole("button", { name: "Structure Song" })).toHaveAttribute(
      "aria-current",
      "true",
    );

    // Home again keeps both open but hides the tabs; opening the first song again goes back to
    // its tab: the same song, never reloaded.
    await user.click(screen.getByRole("button", { name: "Smart Beat" }));
    expect(await screen.findByRole("button", { name: "Open a tab" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Open songs" })).not.toBeInTheDocument();
    backend.dialogResult = SONG;
    await user.click(screen.getByRole("button", { name: "Open a tab" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Practice Song" }),
    ).toBeInTheDocument();
    expect(first.destroy).not.toHaveBeenCalled();
    expect(openTabs()).toHaveLength(2);
  });

  it("keeps an unsaved song and its edit marker when going home and opening another", async () => {
    const { user } = await renderApp();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    await menu("new-song");
    await screen.findByRole("heading", { level: 1, name: "Untitled" });
    await user.click(screen.getByRole("button", { name: "Smart Beat" }));
    // No "leave" question: nothing is closed.
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    backend.dialogResult = SONG;
    await menu("open");
    await screen.findByRole("heading", { level: 1, name: "Practice Song" });
    const tabs = within(screen.getByRole("navigation", { name: "Open songs" }));
    expect(tabs.getAllByRole("listitem")).toHaveLength(2);
    expect(tabs.getByRole("button", { name: "Untitled" })).toBeInTheDocument();
  });

  describe("the logo with unsaved changes", () => {
    /** A song with a file, edited. */
    async function editOpenSong(user: ReturnType<typeof renderWithProviders>["user"]) {
      backend.files.set(SONG, fixtureBytes("practice-song.gp"));
      backend.dialogResult = SONG;
      await menu("open");
      await screen.findByRole("heading", { level: 1, name: "Practice Song" });
      await menu("toggle-edit-mode");
      await screen.findByRole("toolbar", { name: "Edit" });
      const score = screen.getByRole("region", { name: /^Score:/ });
      await waitFor(() => expect(score).toHaveFocus());
      await user.keyboard("5");
      await screen.findByText("Edited");
    }
    const logo = () => screen.getByRole("button", { name: "Smart Beat" });

    it("goes straight home when nothing was edited", async () => {
      const { user } = await renderApp();
      backend.files.set(SONG, fixtureBytes("practice-song.gp"));
      backend.dialogResult = SONG;
      await menu("open");
      await screen.findByRole("heading", { level: 1, name: "Practice Song" });
      await user.click(logo());
      expect(await screen.findByRole("button", { name: "Open a tab" })).toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("asks first; Cancel stays on the song", async () => {
      const { user } = await renderApp();
      await editOpenSong(user);
      await user.click(logo());
      const ask = await screen.findByRole("alertdialog", { name: "Save your changes?" });
      await user.click(within(ask).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Open a tab" })).not.toBeInTheDocument();
      expect(screen.getByText("Edited")).toBeInTheDocument();
    });

    it("Not now goes home; the tab keeps its edits and marker", async () => {
      const { user } = await renderApp();
      await editOpenSong(user);
      await user.click(logo());
      const ask = await screen.findByRole("alertdialog", { name: "Save your changes?" });
      await user.click(within(ask).getByRole("button", { name: "Not now" }));
      expect(await screen.findByRole("button", { name: "Open a tab" })).toBeInTheDocument();
      // The tabs are hidden on the start screen, but the edited song is still open: opening it
      // again returns to its tab with the edits.
      expect(screen.queryByRole("navigation", { name: "Open songs" })).not.toBeInTheDocument();
      backend.dialogResult = SONG;
      await user.click(screen.getByRole("button", { name: "Open a tab" }));
      expect(await screen.findByText("Edited")).toBeInTheDocument();
      expect(openTabs()).toHaveLength(1);
    });

    it("Save writes the song, then shows the start screen", async () => {
      const { user, calls } = await renderApp();
      await editOpenSong(user);
      await user.click(logo());
      const ask = await screen.findByRole("alertdialog", { name: "Save your changes?" });
      await user.click(within(ask).getByRole("button", { name: "Save" }));
      expect(await screen.findByRole("button", { name: "Open a tab" })).toBeInTheDocument();
      expect(calls.some((c) => c.cmd === "write_score_file")).toBe(true);
      expect(backend.written.has(SONG)).toBe(true);
      expect(screen.queryByRole("navigation", { name: "Open songs" })).not.toBeInTheDocument();
    });

    it("Save on a new song opens Save As; cancelling it keeps you on that tab", async () => {
      const { user, calls } = await renderApp();
      await menu("new-song");
      await screen.findByRole("toolbar", { name: "Edit" });
      const score = screen.getByRole("region", { name: /^Score:/ });
      await waitFor(() => expect(score).toHaveFocus());
      await user.keyboard("5");
      await screen.findByText("Edited");
      backend.saveResult = null; // the user cancels Save As
      await user.click(logo());
      const ask = await screen.findByRole("alertdialog", { name: "Save your changes?" });
      await user.click(within(ask).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(calls.some((c) => c.cmd === "plugin:dialog|save")).toBe(true));
      await new Promise((r) => setTimeout(r, 300));
      expect(screen.queryByRole("button", { name: "Open a tab" })).not.toBeInTheDocument();
      expect(screen.getByText("Edited")).toBeInTheDocument();
      expect(calls.some((c) => c.cmd === "write_score_file")).toBe(false);
    });
  });

  it("opening a file that is already open shows its tab, also from the start screen", async () => {
    const { user } = await renderApp();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    backend.dialogResult = SONG;
    await menu("open");
    await screen.findByRole("heading", { level: 1, name: "Practice Song" });
    await user.click(screen.getByRole("button", { name: "Smart Beat" }));
    await screen.findByRole("button", { name: "Open a tab" });

    await menu("open");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Practice Song" }),
    ).toBeInTheDocument();
    expect(openTabs()).toHaveLength(1);
  });

  it("reports a failing Open dialog", async () => {
    mockTauri({
      "plugin:dialog|open": () => {
        throw new Error("Dialog unavailable");
      },
    });
    const { user } = renderWithProviders(<App />);

    await user.click(screen.getByRole("button", { name: "Open a tab" }));

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
    await user.click(screen.getByRole("button", { name: "New tab" }));
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
    expect(screen.getByRole("button", { name: "Open a tab" })).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "Open a tab" }));
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
        .getAllByRole("button", { name: /^[\w-]+\.gp/ })
        .map((b) => b.textContent),
    ).toEqual(["practice-song.gpSongs", "structure-song.gpSongs"]);
    // Each recent song has a share icon next to it (#201).
    expect(within(list).getAllByRole("button", { name: /^Share a link to/ })).toHaveLength(2);

    await user.click(within(list).getByRole("button", { name: /^structure-song\.gp/ }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Structure Song" }),
    ).toBeInTheDocument();
    // The opened song moves to the top of the list.
    expect(backend.recent).toEqual([OTHER, SONG]);
  });

  it("opens the song File › Open Recent names", async () => {
    await renderWithRecent();
    // The menu listener is added after the first render: ask again until it answers (a slow
    // runner needs more than the default second for each try and for all of them).
    await waitFor(
      async () => {
        await act(() => emitOpenRecent(SONG));
        expect(
          await screen.findByRole(
            "heading",
            { level: 1, name: "Practice Song" },
            { timeout: 3000 },
          ),
        ).toBeInTheDocument();
      },
      { timeout: 12_000 },
    );
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

    await user.click(within(list).getByRole("button", { name: /^structure-song\.gp/ }));

    await waitFor(() => expect(backend.recent).toEqual([SONG]));
    await waitFor(() =>
      expect(
        within(list).queryByRole("button", { name: /^structure-song\.gp/ }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Practice, create and break the era",
    );
  });

  it("saves the open song to a new file and stops calling it edited", async () => {
    const { user } = await renderWithRecent();
    await user.click(screen.getByRole("button", { name: /^practice-song\.gp/ }));
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
    await user.click(screen.getByRole("button", { name: /^practice-song\.gp/ }));
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

describe("App: saved stems (#186)", () => {
  beforeEach(() => {
    flags.stems = true;
  });
  afterEach(() => {
    flags.stems = false;
  });

  it("opens a .sbstems file picked with Open saved stems on the stem page", async () => {
    const { user, calls } = await renderApp();
    backend.dialogResult = "/Music/Opened.sbstems";
    await user.click(screen.getByRole("button", { name: "Open saved stems" }));
    await user.click(screen.getByRole("button", { name: "Computer" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Opened Song" }),
    ).toBeInTheDocument();
    expect(calls).toContainEqual({
      cmd: "stems_open_bundle",
      args: { path: "/Music/Opened.sbstems" },
    });
    // It came from a file, so the page says it is saved.
    expect(screen.getByTestId("stems-saved")).toBeInTheDocument();
    // The page has no Back button: closing its tab, the last one, is the way to the start screen.
    expect(screen.queryByRole("button", { name: "Back to start" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close Opened Song" }));
    expect(await screen.findByRole("button", { name: /^Opened Song/ })).toBeInTheDocument();
  });

  it("does nothing when the Open dialog is cancelled", async () => {
    const { user, calls } = await renderApp();
    backend.dialogResult = null;
    await user.click(screen.getByRole("button", { name: "Open saved stems" }));
    await user.click(screen.getByRole("button", { name: "Computer" }));
    expect(calls.some((call) => call.cmd === "stems_open_bundle")).toBe(false);
    expect(screen.getByRole("heading", { level: 1, name: /Practice, create/ })).toBeInTheDocument();
  });

  it("reports a file that cannot be opened and stays on the start screen", async () => {
    const { user } = await renderApp();
    mockTauri({
      stems_open_bundle: () => {
        throw { kind: "io", message: "This file is not a Smart Beat stems file." };
      },
    });
    backend.dialogResult = "/Music/Broken.sbstems";
    await user.click(screen.getByRole("button", { name: "Open saved stems" }));
    await user.click(screen.getByRole("button", { name: "Computer" }));
    expect(await screen.findByText("Couldn't open the saved stems")).toBeInTheDocument();
    expect(screen.getByText(/not a Smart Beat stems file/)).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { level: 1, name: "Opened Song" }),
    ).not.toBeInTheDocument();
  });

  it("opens the file the system hands over, also from an open song", async () => {
    const { calls } = await renderApp();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    backend.dialogResult = SONG;
    await menu("open");
    await screen.findByRole("heading", { name: "Practice Song" }, { timeout: 5_000 });

    await act(() => emitStemBundleOpened("/Downloads/Shared.sbstems"));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Opened Song" }),
    ).toBeInTheDocument();
    expect(calls).toContainEqual({
      cmd: "stems_open_bundle",
      args: { path: "/Downloads/Shared.sbstems" },
    });
    expect(
      screen.queryByRole("heading", { level: 1, name: "Practice Song" }),
    ).not.toBeInTheDocument();
  });

  it("marks a card as used when it is opened", async () => {
    const calls = mockTauri();
    backend.stemSongs = [STEM_SONG];
    renderWithProviders(<App />);
    const card = await screen.findByRole("button", { name: /^Neon Nights/ });
    await act(async () => card.click());
    expect(
      await screen.findByRole("heading", { level: 1, name: "Neon Nights" }),
    ).toBeInTheDocument();
    expect(calls).toContainEqual({ cmd: "stems_touch", args: { id: STEM_SONG.id } });
  });

  it("leaves the Open saved stems button out while the feature is off", async () => {
    flags.stems = false;
    await renderApp();
    expect(screen.queryByRole("button", { name: "Open saved stems" })).not.toBeInTheDocument();
  });
});

describe("App: the stem page looks like a song (#186)", () => {
  beforeEach(() => {
    flags.stems = true;
  });
  afterEach(() => {
    flags.stems = false;
  });

  const openStem = async (name: string, id: string) => {
    backend.bundleSong = { ...STEM_SONG, id, name };
    await act(() => emitStemBundleOpened(`/Music/${name}.sbstems`));
    await screen.findByRole("heading", { level: 1, name });
  };
  const stemTabs = () => screen.getByRole("navigation", { name: "Open songs and stems" });

  it("keeps the stem separations open as tabs, next to the songs", async () => {
    const { user } = await renderApp();
    await openStem("First", "aaaaaaaaaaaaaaaa");
    await openStem("Second", "bbbbbbbbbbbbbbbb");

    expect(within(stemTabs()).getAllByRole("listitem")).toHaveLength(2);
    expect(within(stemTabs()).getByRole("button", { name: "Second" })).toHaveAttribute(
      "aria-current",
      "true",
    );

    await user.click(within(stemTabs()).getByRole("button", { name: "First" }));
    expect(screen.getByRole("heading", { level: 1, name: "First" })).toBeInTheDocument();
    expect(within(stemTabs()).getByRole("button", { name: "First" })).toHaveAttribute(
      "aria-current",
      "true",
    );

    // Closing the shown one shows its neighbour; closing the last goes to the start screen.
    await user.click(screen.getByRole("button", { name: "Close First" }));
    expect(screen.getByRole("heading", { level: 1, name: "Second" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close Second" }));
    expect(screen.getByRole("heading", { level: 1, name: /Practice, create/ })).toBeInTheDocument();
  });

  it("shows the open songs on the stem page, and goes between a song and a stem tab", async () => {
    const { user } = await renderApp();
    backend.files.set(SONG, fixtureBytes("practice-song.gp"));
    backend.dialogResult = SONG;
    await menu("open");
    await screen.findByRole("heading", { name: "Practice Song" }, { timeout: 5_000 });
    await openStem("Stemmed", "cccccccccccccccc");

    const tabs = stemTabs();
    expect(within(tabs).getByRole("button", { name: "Practice Song" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(within(tabs).getByRole("button", { name: "Stemmed" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    // The + here starts a stem separation, not a song.
    expect(within(tabs).getByRole("button", { name: "New stem separation" })).toBeInTheDocument();

    await user.click(within(tabs).getByRole("button", { name: "Practice Song" }));
    expect(screen.getByRole("heading", { name: "Practice Song" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Stemmed" })).not.toBeInTheDocument();
    expect(within(stemTabs()).getByRole("button", { name: "New song" })).toBeInTheDocument();
    await user.click(within(stemTabs()).getByRole("button", { name: "Stemmed" }));
    expect(screen.getByRole("heading", { level: 1, name: "Stemmed" })).toBeInTheDocument();
  });

  it("starts a new stem separation from the + button in the tab bar", async () => {
    const { user } = await renderApp();
    await openStem("First", "aaaaaaaaaaaaaaaa");
    const tabBar = screen.getByRole("navigation", { name: "Open songs and stems" });
    await user.click(within(tabBar).getByRole("button", { name: "New stem separation" }));
    expect(await screen.findByRole("dialog", { name: /Stem separation/ })).toBeInTheDocument();
  });

  it("starts a new stem separation from the header's New button", async () => {
    const { user } = await renderApp();
    await openStem("First", "aaaaaaaaaaaaaaaa");
    const header = screen.getAllByRole("banner")[0]!;
    await user.click(within(header).getByRole("button", { name: "New stem separation" }));
    expect(await screen.findByRole("dialog", { name: /Stem separation/ })).toBeInTheDocument();
  });

  it("opens saved stems from the header's Open stems button", async () => {
    const { user, calls } = await renderApp();
    await openStem("First", "aaaaaaaaaaaaaaaa");
    await user.click(screen.getByRole("button", { name: "Open stems" }));
    await user.click(screen.getByRole("button", { name: "Pick a cloud stem" }));
    expect(calls).toContainEqual({
      cmd: "stems_open_bundle",
      args: { path: "/Cloud/Picked.sbstems" },
    });
    expect(screen.queryByRole("dialog", { name: "Open stems dialog" })).not.toBeInTheDocument();
  });

  it("shows the stems opened from a connected account as a new tab and closes the dialog", async () => {
    const { user } = await renderApp();
    await openStem("First", "aaaaaaaaaaaaaaaa");
    await user.click(screen.getByRole("button", { name: "Open stems" }));
    await user.click(screen.getByRole("button", { name: "Pick an account stem" }));
    expect(await within(stemTabs()).findByRole("button", { name: "From Drive" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.queryByRole("dialog", { name: "Open stems dialog" })).not.toBeInTheDocument();
  });

  it("keeps the buttons, the play control and the details in the app header's centre", async () => {
    await renderApp();
    await openStem("First", "aaaaaaaaaaaaaaaa");
    const header = screen.getAllByRole("banner")[0]!;
    expect(within(header).queryByRole("img", { name: "Stem separation" })).not.toBeInTheDocument();
    expect(within(header).getByRole("group", { name: "Playback" })).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Save stems" })).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Open stems" })).toBeInTheDocument();
    expect(within(header).getByText(/engine · 5 parts/)).toBeInTheDocument();
  });
});
