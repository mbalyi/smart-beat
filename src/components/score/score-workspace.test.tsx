import { fireEvent, screen, waitFor } from "@testing-library/react";

import { ScoreWorkspace } from "@/components/score/score-workspace";
import { Toaster } from "@/components/ui/sonner";
import type { ScoreDocument } from "@/hooks/use-score-document";
import { fileKey } from "@/lib/score/format";
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
      <ScoreWorkspace song={song} onOpen={onOpen} />
      <Toaster />
    </>,
  );
  const player = FakeScorePlayer.last;
  const saves = () => calls.filter((c) => c.cmd === "save_mixer_settings");
  return { ...utils, song, onOpen, player, calls, saves };
}

async function openMixer(user: Awaited<ReturnType<typeof setup>>["user"]) {
  await user.click(screen.getByRole("button", { name: "Mixer" }));
  return screen.findByRole("dialog", { name: "Mixer" });
}

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
    expect(screen.getByText("120 BPM")).toBeInTheDocument();
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

  it("toggles the mixer and returns focus to its button when it closes", async () => {
    const { user } = await setup();
    const button = screen.getByRole("button", { name: "Mixer" });

    await openMixer(user);
    expect(button).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-expanded", "false");

    await user.click(button);
    await user.click(button);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("sends mixer changes to the player", async () => {
    const { user, player } = await setup();
    await openMixer(user);

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

    await user.click(screen.getByRole("button", { name: "Reset to the file's mix" }));
    expect(player.setMix).toHaveBeenLastCalledWith(mixFromScore(SUMMARY));
  });

  it("applies pan when a slider is released, not while it is dragged", async () => {
    const { user, player } = await setup();
    await openMixer(user);
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
    await openMixer(user);
    expect(screen.getByText("Changes are saved for this song.")).toBeInTheDocument();

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
    await openMixer(user);

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
    await openMixer(user);

    await user.click(screen.getByRole("button", { name: "Mute Guitar" }));

    expect(await screen.findByText("Couldn't save the mix")).toBeInTheDocument();
    expect(screen.getByText("Disk full")).toBeInTheDocument();
  });

  it("does not save outside the desktop app", async () => {
    const { user } = await setup();
    await openMixer(user);
    expect(screen.getByText("Changes last until you open another song.")).toBeInTheDocument();
  });

  it("switches instrument sounds and remembers the choice", async () => {
    const { user, player } = await setup();
    await openMixer(user);

    await user.click(screen.getByRole("combobox", { name: "Instrument sounds" }));
    await user.click(await screen.findByRole("option", { name: /High quality/ }));

    expect(player.setSoundFont).toHaveBeenCalledWith("/soundfont/FluidR3Mono_GM.sf3");
    expect(localStorage.getItem(SOUNDFONT_STORAGE_KEY)).toBe("fluidr3");
  });

  it("falls back to the standard sounds if the others fail to load", async () => {
    localStorage.setItem(SOUNDFONT_STORAGE_KEY, "fluidr3");
    const { user, player } = await setup();
    expect(player.options.soundFontUrl).toBe("/soundfont/FluidR3Mono_GM.sf3");

    player.emit("onSoundFontError", new Error("404"));

    expect(await screen.findByText("High quality sounds are not available")).toBeInTheDocument();
    expect(player.setSoundFont).toHaveBeenCalledWith("/soundfont/sonivox.sf3");
    expect(localStorage.getItem(SOUNDFONT_STORAGE_KEY)).toBe("sonivox");
    await openMixer(user);
    expect(screen.getByRole("combobox", { name: "Instrument sounds" })).toHaveTextContent(
      "Standard",
    );
  });

  it("reports when no sounds can be loaded", async () => {
    const { player } = await setup();

    player.emit("onSoundFontError", new Error("offline"));

    expect(await screen.findByText("Instrument sounds could not be loaded")).toBeInTheDocument();
    expect(player.setSoundFont).not.toHaveBeenCalled();
  });

  it("reports other score problems", async () => {
    const { player } = await setup();

    player.emit("onError", new Error("Render failed"));

    expect(await screen.findByText("Something went wrong with the score")).toBeInTheDocument();
    expect(screen.getByText("Render failed")).toBeInTheDocument();
  });
});
