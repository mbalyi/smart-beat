import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { ScoreWorkspace } from "@/components/score/score-workspace";
import { Toaster } from "@/components/ui/sonner";
import type { ScoreDocument } from "@/hooks/use-score-document";
import { fileKey } from "@/lib/score/format";
import { LAYOUT_STORAGE_KEY } from "@/lib/score/layout";
import { mixFromScore } from "@/lib/score/mixer";
import { parseScore } from "@/lib/score/score";
import { SOUNDFONT_STORAGE_KEY } from "@/lib/score/soundfonts";
import { expectNoA11yViolations } from "@/test/axe";
import { FakeScorePlayer } from "@/test/fake-score-player";
import { renderWithProviders } from "@/test/render";
import { fixtureBytes, SUMMARY } from "@/test/score";
import { mockTauri, type IpcCall } from "@/test/tauri";

vi.mock("@/lib/score/player", async () => ({
  ScorePlayer: (await import("@/test/fake-score-player")).FakeScorePlayer,
}));

async function makeSong(): Promise<ScoreDocument> {
  const bytes = fixtureBytes("practice-song.gp");
  const { score, summary } = parseScore(bytes);
  return {
    id: 1,
    name: "practice-song.gp",
    path: null,
    fileKey: await fileKey(bytes),
    score,
    summary,
    mix: mixFromScore(summary),
  };
}

async function setup({
  desktop = false,
  overrides = {},
}: { desktop?: boolean; overrides?: Parameters<typeof mockTauri>[0] } = {}) {
  const calls: IpcCall[] = desktop ? mockTauri(overrides) : [];
  const song = await makeSong();
  const onOpen = vi.fn();
  const utils = renderWithProviders(
    <>
      <ScoreWorkspace onImportAudio={vi.fn()} song={song} onOpen={onOpen} />
      <Toaster />
    </>,
  );
  const player = FakeScorePlayer.last;
  const saves = () => calls.filter((c) => c.cmd === "save_mixer_settings");
  return { ...utils, song, onOpen, player, calls, saves };
}

/** The track list at the bottom holds the mixer (shown from the start). */
const mixerRegion = () => screen.getByRole("region", { name: "Tracks and mixer" });

describe("ScoreWorkspace", () => {
  it("creates a player for the song's first track", async () => {
    const { song, player } = await setup();

    expect(player.options).toMatchObject({
      score: song.score,
      trackIndex: 0,
      view: { notation: "score-tab", rhythm: false },
      layout: "page",
      mix: song.mix,
      soundFontUrl: "/soundfont/sonivox.sf3",
      reducedMotion: false,
    });
    const region = screen.getByRole("region", { name: "Score: Guitar" });
    expect(region).toBe(player.options.scrollElement);
    expect(region).toContainElement(player.options.element);
  });

  it("shows progress until the score is rendered and playable", async () => {
    const { player } = await setup();

    expect(screen.getByText("Rendering score…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();

    player.becomeReady();

    expect(screen.queryByText("Rendering score…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play" })).toBeEnabled();
    expect(screen.getByRole("timer")).toHaveTextContent("0:00 / 0:12");
    await expectNoA11yViolations();
  });

  it("follows playback", async () => {
    const { player } = await setup();
    player.becomeReady();

    player.emit("onPlayingChange", true);
    player.emit("onPositionChange", { currentMs: 9_000, endMs: 12_000, bpm: 120 });
    player.emit("onBarChange", 2);

    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("timer")).toHaveTextContent("0:09 / 0:12");
    expect(screen.getByText(/120 BPM/)).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Bar" })).toHaveValue(3);
  });

  it("controls playback from the transport and the Space key", async () => {
    const { user, player } = await setup();

    fireEvent.keyDown(document.body, { key: " " });
    expect(player.playPause).not.toHaveBeenCalled(); // not ready yet

    player.becomeReady();
    await user.click(screen.getByRole("button", { name: "Play" }));
    fireEvent.keyDown(document.body, { key: " " });
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await user.clear(screen.getByRole("spinbutton", { name: "Bar" }));
    await user.keyboard("3{Enter}");

    expect(player.playPause).toHaveBeenCalledTimes(2);
    expect(player.stop).toHaveBeenCalledOnce();
    expect(player.seekToBar).toHaveBeenCalledWith(2);
  });

  it("remembers the notation of each track", async () => {
    const { user, player } = await setup();

    await user.click(screen.getByRole("radio", { name: "Tab" }));
    expect(player.setView).toHaveBeenLastCalledWith({ notation: "tab", rhythm: false });

    await user.click(screen.getByRole("combobox", { name: "Track" }));
    await user.click(await screen.findByRole("option", { name: "Bass" }));
    expect(player.showTrack).toHaveBeenLastCalledWith(1, { notation: "tab", rhythm: false });
    expect(screen.getByRole("region", { name: "Score: Bass" })).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Track" }));
    await user.click(await screen.findByRole("option", { name: "Guitar" }));
    expect(player.showTrack).toHaveBeenLastCalledWith(0, { notation: "tab", rhythm: false });
  });

  it("switches the layout", async () => {
    const { user, player } = await setup();

    await user.click(screen.getByRole("radio", { name: "Continuous" }));

    expect(player.setLayout).toHaveBeenCalledWith("horizontal");
    expect(screen.getByRole("region", { name: /^Score:/ })).toHaveAttribute(
      "data-layout",
      "horizontal",
    );
  });

  it("opens another file", async () => {
    const { user, onOpen } = await setup();
    await user.click(screen.getByRole("button", { name: "Open…" }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("shows and hides the track list and the inspector", async () => {
    const { user } = await setup();
    const mixer = screen.getByRole("button", { name: "Mixer" });
    const inspector = screen.getByRole("button", { name: "Inspector" });
    expect(mixerRegion()).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeInTheDocument();

    await user.click(mixer);
    await user.click(inspector);

    expect(screen.queryByRole("region", { name: "Tracks and mixer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Inspector" })).not.toBeInTheDocument();
    expect(mixer).toHaveAttribute("aria-pressed", "false");

    await user.click(mixer);
    expect(mixerRegion()).toBeInTheDocument();
  });

  it("remembers which panels the user left open (#83)", async () => {
    const { user, unmount } = await setup();
    await user.click(screen.getByRole("button", { name: "Mixer" }));
    expect(JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY)!)).toEqual({
      mixer: false,
      inspector: true,
    });
    unmount();
    await setup();
    expect(screen.queryByRole("region", { name: "Tracks and mixer" })).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeInTheDocument();
  });

  it("starts a new install with only the score and the playback controls (#83)", async () => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ mixer: false, inspector: false }));
    await setup();
    expect(screen.queryByRole("region", { name: "Tracks and mixer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Inspector" })).not.toBeInTheDocument();
    // Still one click away.
    expect(screen.getByRole("button", { name: "Mixer" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Inspector" })).toBeInTheDocument();
  });

  it("Practice View hides the panels, focuses the shown track and puts it all back (#83)", async () => {
    const { user, player } = await setup();
    const practiceView = screen.getByRole("button", { name: "Practice View" });
    await user.click(practiceView);

    expect(practiceView).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("region", { name: "Tracks and mixer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Inspector" })).not.toBeInTheDocument();
    // Playback and practice stay.
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Practice" })).toBeInTheDocument();
    expect(player.setMix).toHaveBeenLastCalledWith(expect.objectContaining({ focus: 0 }));
    // Not remembered as the user's layout.
    expect(JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY)!)).toEqual({
      mixer: true,
      inspector: true,
    });

    await user.click(practiceView);
    expect(mixerRegion()).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeInTheDocument();
    expect(player.setMix.mock.lastCall![0].focus).toBeUndefined();
  });

  it("a panel switch ends Practice View and shows that panel (#83)", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Practice View" }));
    await user.click(screen.getByRole("button", { name: "Mixer" }));
    expect(screen.getByRole("button", { name: "Practice View" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(mixerRegion()).toBeInTheDocument();
  });

  it("switches practice mixes without touching the saved faders (#83)", async () => {
    const { user, player } = await setup();
    await user.click(screen.getByRole("button", { name: /^Practice mix/ }));
    const popover = await screen.findByRole("dialog", { name: "Practice mix" });
    await user.click(within(popover).getByRole("radio", { name: /Hear only me/ }));
    expect(player.setMix).toHaveBeenLastCalledWith(
      expect.objectContaining({ focus: 0, focusMode: "onlyMe" }),
    );
    expect(
      screen.getByRole("button", { name: /^Practice mix: Hear only me, Guitar/ }),
    ).toBeInTheDocument();
    await user.click(within(popover).getByRole("radio", { name: /Others turned down/ }));
    await user.click(within(popover).getByRole("radio", { name: "Strong" }));
    expect(player.setFocusCut).toHaveBeenLastCalledWith(-24);
    await user.click(within(popover).getByRole("radio", { name: /Normal mix/ }));
    const last = player.setMix.mock.lastCall![0];
    expect(last.focus).toBeUndefined();
    expect(last.tracks).toEqual(mixFromScore(SUMMARY).tracks);
    await expectNoA11yViolations();
  });

  it("sends mixer changes to the player", async () => {
    const { user, player } = await setup();

    await user.click(screen.getByRole("button", { name: "Solo Bass" }));

    expect(player.setMix).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tracks: expect.arrayContaining([expect.objectContaining({ solo: true })]),
      }),
    );
    expect(screen.getByRole("button", { name: "Solo Bass" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Reset the mix" }));
    expect(player.setMix).toHaveBeenLastCalledWith(mixFromScore(SUMMARY));
  });

  it("applies pan when a slider is released, not while it is dragged", async () => {
    const { player } = await setup();
    const thumb = screen.getByRole("slider", { name: "Pan, Guitar" });
    const track = thumb.closest<HTMLElement>("[data-slot=slider]")!;
    // jsdom has no layout: give the slider a 100 px track.
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 20));
    Object.assign(track, { setPointerCapture: () => {}, hasPointerCapture: () => true });
    player.setMix.mockClear();

    fireEvent.pointerDown(track, { clientX: 25, pointerId: 1 });
    expect(thumb).toHaveAttribute("aria-valuetext", "50% left");
    fireEvent.pointerMove(track, { clientX: 0, pointerId: 1 });

    expect(thumb).toHaveAttribute("aria-valuetext", "100% left");
    expect(player.setMix).not.toHaveBeenCalled();

    fireEvent.pointerUp(track, { clientX: 0, pointerId: 1 });

    expect(player.setMix).toHaveBeenCalledOnce();
    expect(player.setMix.mock.calls[0]![0].tracks[0].pan).toBe(-1);
  });

  it("saves the mix shortly after it changes (desktop app)", async () => {
    const { user, song, saves } = await setup({ desktop: true });
    expect(screen.getByText("Mix changes are saved for this song.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Mute Guitar" }));
    await user.click(screen.getByRole("button", { name: "Mute Bass" }));
    expect(saves()).toHaveLength(0);

    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0]!.args).toEqual({
      fileKey: song.fileKey,
      settings: expect.objectContaining({
        tracks: expect.arrayContaining([
          expect.objectContaining({ mute: true }),
          expect.objectContaining({ mute: true }),
        ]),
      }),
    });
  });

  it("saves a pending change when the song is closed", async () => {
    const { user, unmount, saves, player } = await setup({ desktop: true });

    await user.click(screen.getByRole("button", { name: "Solo Drums" }));
    unmount();

    expect(saves()).toHaveLength(1);
    expect(player.destroy).toHaveBeenCalled();
  });

  it("reports a failed save", async () => {
    const { user } = await setup({
      desktop: true,
      overrides: {
        save_mixer_settings: () => {
          throw { kind: "io", message: "Disk full" };
        },
      },
    });

    await user.click(screen.getByRole("button", { name: "Mute Guitar" }));

    expect(await screen.findByText("Couldn't save the mix")).toBeInTheDocument();
    expect(screen.getByText("Disk full")).toBeInTheDocument();
  });

  it("does not save outside the desktop app", async () => {
    await setup();
    expect(screen.getByText("Mix changes last until you close this song.")).toBeInTheDocument();
  });

  it("switches instrument sounds and remembers the choice", async () => {
    const { user, player } = await setup();
    player.becomeReady();

    await user.click(screen.getByRole("combobox", { name: "Instrument sounds" }));
    await user.click(await screen.findByRole("option", { name: /High quality/ }));

    expect(player.setSoundFont).toHaveBeenCalledWith("/soundfont/FluidR3Mono_GM.sf3");
    expect(localStorage.getItem(SOUNDFONT_STORAGE_KEY)).toBe("fluidr3");
  });

  it("falls back to the standard sounds if the others fail to load", async () => {
    localStorage.setItem(SOUNDFONT_STORAGE_KEY, "fluidr3");
    const { player } = await setup();
    expect(player.options.soundFontUrl).toBe("/soundfont/FluidR3Mono_GM.sf3");

    player.emit("onSoundFontError", new Error("404"), { previousKept: false });

    expect(await screen.findByText("High quality sounds are not available")).toBeInTheDocument();
    expect(player.setSoundFont).toHaveBeenCalledWith("/soundfont/sonivox.sf3");
    expect(localStorage.getItem(SOUNDFONT_STORAGE_KEY)).toBe("sonivox");
    expect(screen.getByRole("combobox", { name: "Instrument sounds" })).toHaveTextContent(
      "Standard",
    );
  });

  it("keeps playing the standard sounds when the others fail to download", async () => {
    const { user, player } = await setup();
    player.becomeReady();
    await user.click(screen.getByRole("combobox", { name: "Instrument sounds" }));
    await user.click(await screen.findByRole("option", { name: /High quality/ }));
    player.setSoundFont.mockClear();

    player.emit("onSoundFontError", new Error("404"), { previousKept: true });

    expect(await screen.findByText("High quality sounds are not available")).toBeInTheDocument();
    expect(player.setSoundFont).not.toHaveBeenCalled(); // no reload, no pause
    expect(screen.getByRole("combobox", { name: "Instrument sounds" })).toHaveTextContent(
      "Standard",
    );
  });

  it("disables switching sounds while they load, and explains pan during playback", async () => {
    const { player } = await setup();
    expect(screen.getByRole("combobox", { name: "Instrument sounds" })).toBeDisabled();
    expect(screen.queryByText(/Pan changes are applied when you pause/)).not.toBeInTheDocument();

    player.becomeReady();
    player.emit("onPlayingChange", true);

    expect(screen.getByRole("combobox", { name: "Instrument sounds" })).toBeEnabled();
    expect(screen.getByText(/Pan changes are applied when you pause/)).toBeInTheDocument();
  });

  it("reports when no sounds can be loaded", async () => {
    const { player } = await setup();

    player.emit("onSoundFontError", new Error("offline"), { previousKept: false });

    expect(await screen.findByText("Instrument sounds could not be loaded")).toBeInTheDocument();
    expect(player.setSoundFont).not.toHaveBeenCalled();
  });

  it("reports other score problems", async () => {
    const { player } = await setup();

    player.emit("onError", new Error("Render failed"));

    expect(await screen.findByText("Something went wrong with the score")).toBeInTheDocument();
    expect(screen.getByText("Render failed")).toBeInTheDocument();
  });

  describe("printing", () => {
    /** What alphaTab draws into the score's element. */
    const draw = (element: HTMLElement) => {
      const part = document.createElement("div");
      part.innerHTML = '<svg width="1000" height="300"></svg>';
      element.append(part);
    };

    async function openPrintDialog(user: Awaited<ReturnType<typeof setup>>["user"]) {
      await user.click(screen.getByRole("button", { name: "File" }));
      await user.click(await screen.findByRole("menuitem", { name: "Print / PDF…" }));
      return screen.findByRole("dialog", { name: "Print or save as PDF" });
    }

    afterEach(() => {
      vi.restoreAllMocks();
      document.getElementById("print-root")?.remove();
      document.getElementById("print-page-style")?.remove();
    });

    it("prints the drawn score with the chosen page settings, then removes the print copy", async () => {
      const print = vi.spyOn(window, "print").mockImplementation(() => {
        expect(document.querySelectorAll("#print-root svg")).toHaveLength(1);
        expect(document.getElementById("print-page-style")!.textContent).toContain("A4 portrait");
      });
      const { user, player } = await setup();
      draw(player.options.element);

      const dialog = await openPrintDialog(user);
      expect(dialog).toHaveTextContent("“Guitar”");
      await user.click(within(dialog).getByRole("button", { name: "Print…" }));

      // The shown track at the print size, then the print once it is drawn.
      expect(player.showForPrint).toHaveBeenCalledWith([0], 0.9);
      expect(print).not.toHaveBeenCalled();
      player.emit("onRendered");
      await waitFor(() => expect(print).toHaveBeenCalledOnce());
      fireEvent(window, new Event("afterprint"));
      expect(document.getElementById("print-root")).toBeNull();
      expect(player.restoreAfterPrint).toHaveBeenCalledOnce();
      expect(JSON.parse(localStorage.getItem("smart-beat:print")!)).toMatchObject({ paper: "a4" });
    });

    it("prints all tracks together at the chosen size, and puts the view back afterwards", async () => {
      const print = vi.spyOn(window, "print").mockImplementation(() => {});
      const { user, player } = await setup();
      draw(player.options.element);

      const dialog = await openPrintDialog(user);
      await user.click(within(dialog).getByRole("radio", { name: /^All \d+ tracks/ }));
      await user.click(within(dialog).getByRole("combobox", { name: "Notation size" }));
      await user.click(await screen.findByRole("option", { name: "70%" }));
      await user.click(within(dialog).getByRole("button", { name: "Print…" }));

      const [tracks, scale] = player.showForPrint.mock.calls[0]!;
      expect(tracks.length).toBeGreaterThan(1);
      expect(scale).toBe(0.7);
      player.emit("onRendered");
      await waitFor(() => expect(print).toHaveBeenCalledOnce());
      fireEvent(window, new Event("afterprint"));
      expect(player.restoreAfterPrint).toHaveBeenCalledOnce();
    });

    it("says when nothing is drawn yet", async () => {
      const print = vi.spyOn(window, "print").mockImplementation(() => {});
      const { user } = await setup();

      const dialog = await openPrintDialog(user);
      await user.click(within(dialog).getByRole("button", { name: "Print…" }));
      FakeScorePlayer.last.emit("onRendered");

      expect(
        await screen.findByText("There is nothing to print yet", {}, { timeout: 5_000 }),
      ).toBeInTheDocument();
      expect(print).not.toHaveBeenCalled();
      expect(FakeScorePlayer.last.restoreAfterPrint).toHaveBeenCalled();
    });

    it("reports a print dialog that could not be opened", async () => {
      vi.spyOn(window, "print").mockImplementation(() => {
        throw new Error("No printer is available");
      });
      const { user, player } = await setup();
      draw(player.options.element);

      const dialog = await openPrintDialog(user);
      await user.click(within(dialog).getByRole("button", { name: "Print…" }));
      player.emit("onRendered");

      expect(await screen.findByText("Couldn't print")).toBeInTheDocument();
      expect(screen.getByText("No printer is available")).toBeInTheDocument();
      expect(document.getElementById("print-root")).toBeNull();
    });

    it("opens with Ctrl+P, or ⌘P on a Mac", async () => {
      const { user } = await setup();
      vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");

      await user.keyboard("{Meta>}p{/Meta}");

      expect(
        await screen.findByRole("dialog", { name: "Print or save as PDF" }),
      ).toBeInTheDocument();
    });
  });
});
