import { LayoutMode, synth, TabRhythmMode } from "@coderline/alphatab";

import { mixFromScore } from "@/lib/score/mixer";
import {
  ScorePlayer,
  type ScorePlayerCallbacks,
  type ScorePlayerOptions,
} from "@/lib/score/player";
import { parseScore } from "@/lib/score/score";
import { FakeAlphaTabApi } from "@/test/fake-alphatab";
import { fixtureBytes } from "@/test/score";

const { PlayerState } = synth;

vi.mock(import("@coderline/alphatab"), async (importOriginal) => ({
  ...(await importOriginal()),
  AlphaTabApi: (await import("@/test/fake-alphatab")).FakeAlphaTabApi as never,
}));

type Callback<K extends keyof ScorePlayerCallbacks> = NonNullable<ScorePlayerCallbacks[K]>;

function setup(overrides: Partial<ScorePlayerOptions> = {}) {
  const { score, summary } = parseScore(fixtureBytes("practice-song.gp"));
  const callbacks = {
    onRenderingChange: vi.fn<Callback<"onRenderingChange">>(),
    onReadyChange: vi.fn<Callback<"onReadyChange">>(),
    onPlayingChange: vi.fn<Callback<"onPlayingChange">>(),
    onPositionChange: vi.fn<Callback<"onPositionChange">>(),
    onBarChange: vi.fn<Callback<"onBarChange">>(),
    onSoundFontError: vi.fn<Callback<"onSoundFontError">>(),
    onError: vi.fn<Callback<"onError">>(),
  } satisfies ScorePlayerCallbacks;
  const mix = mixFromScore(summary);
  const player = new ScorePlayer(
    {
      element: document.createElement("div"),
      scrollElement: document.createElement("div"),
      score,
      trackIndex: 0,
      view: { notation: "score-tab", rhythm: false },
      layout: "page",
      mix,
      soundFontUrl: "/soundfont/sonivox.sf3",
      ...overrides,
    },
    callbacks,
  );
  const api = FakeAlphaTabApi.last;
  const becomeReady = () => api.player.readyForPlayback.trigger();
  return { player, api, score, mix, callbacks, becomeReady };
}

describe("ScorePlayer", () => {
  it("configures alphaTab for rendering and playback", () => {
    const { api, score } = setup({ layout: "horizontal", reducedMotion: true });
    const { settings } = api;

    expect(settings.display.layoutMode).toBe(LayoutMode.Horizontal);
    expect(settings.player.soundFont).toBe("/soundfont/sonivox.sf3");
    expect(settings.core.fontDirectory).toBe("/font/");
    expect(settings.player.enableCursor).toBe(true);
    expect(settings.player.enableUserInteraction).toBe(true);
    expect(settings.player.enableAnimatedBeatCursor).toBe(false);
    expect(api.renderScore).toHaveBeenCalledWith(score, [0]);
  });

  it("writes pan into the model before the MIDI is generated", () => {
    const { score } = setup();
    expect(score.tracks[1]!.playbackInfo.balance).toBe(4); // pan -0.5
  });

  it("reports rendering, playing, tempo and bar changes", () => {
    const { api, callbacks } = setup();

    api.renderStarted.trigger(false);
    api.renderFinished.trigger({});
    api.playerStateChanged.trigger({ state: PlayerState.Playing, stopped: false });
    api.playerPositionChanged.trigger({
      currentTime: 0,
      endTime: 12_000,
      originalTempo: 60,
      modifiedTempo: 0,
    });
    api.playedBeatChanged.trigger({ voice: { bar: { index: 2 } } });

    expect(callbacks.onRenderingChange.mock.calls).toEqual([[true], [false]]);
    expect(callbacks.onPlayingChange).toHaveBeenCalledWith(true);
    expect(callbacks.onPositionChange).toHaveBeenCalledWith({
      currentMs: 0,
      endMs: 12_000,
      bpm: 60,
    });
    expect(callbacks.onBarChange).toHaveBeenCalledWith(2);
  });

  it("reports the position at most once per second, and every tempo change", () => {
    const { api, callbacks } = setup();
    const position = (currentTime: number, modifiedTempo = 60) =>
      api.playerPositionChanged.trigger({
        currentTime,
        endTime: 12_000,
        originalTempo: 60,
        modifiedTempo,
      });

    position(100);
    position(400);
    position(1_100);
    position(1_200, 120);

    expect(callbacks.onPositionChange.mock.calls.map(([p]) => [p.currentMs, p.bpm])).toEqual([
      [100, 60],
      [1_100, 60],
      [1_200, 120],
    ]);
  });

  it("reports the bar clicked in the score, even while paused", () => {
    const { api, callbacks } = setup();

    api.beatMouseDown.trigger({ voice: { bar: { index: 3 } } });

    expect(callbacks.onBarChange).toHaveBeenCalledWith(3);
  });

  it("ignores repeated beats in the same bar", () => {
    const { api, callbacks } = setup();
    api.playedBeatChanged.trigger({ voice: { bar: { index: 1 } } });
    api.playedBeatChanged.trigger({ voice: { bar: { index: 1 } } });
    expect(callbacks.onBarChange).toHaveBeenCalledTimes(1);
  });

  it("applies the whole mix whenever playback becomes ready", () => {
    const { api, score, mix, callbacks, becomeReady } = setup();

    becomeReady();

    expect(callbacks.onReadyChange).toHaveBeenCalledWith(true);
    expect(api.masterVolume).toBe(1);
    expect(api.changeTrackVolume).toHaveBeenCalledWith([score.tracks[1]], mix.tracks[1]!.volume);
    expect(api.changeTrackMute).toHaveBeenCalledWith([score.tracks[3]], true);
    expect(api.changeTrackSolo).toHaveBeenCalledTimes(4);
  });

  it("only sends mixer changes that differ", () => {
    const { player, api, score, mix, becomeReady } = setup();
    becomeReady();
    vi.clearAllMocks();

    player.setMix({
      ...mix,
      master: 0.5,
      tracks: mix.tracks.map((t, i) => (i === 2 ? { ...t, volume: 0.2, solo: true } : t)),
    });

    expect(api.masterVolume).toBe(0.5);
    expect(api.changeTrackVolume).toHaveBeenCalledExactlyOnceWith([score.tracks[2]], 0.2);
    expect(api.changeTrackSolo).toHaveBeenCalledExactlyOnceWith([score.tracks[2]], true);
    expect(api.changeTrackMute).not.toHaveBeenCalled();
    expect(api.loadMidiForScore).not.toHaveBeenCalled();
  });

  it("keeps mixer changes made before playback is ready for later", () => {
    const { player, api, score, mix, becomeReady } = setup();

    player.setMix({ ...mix, tracks: mix.tracks.map((t) => ({ ...t, mute: true })) });
    expect(api.changeTrackMute).not.toHaveBeenCalled();

    becomeReady();
    expect(api.changeTrackMute).toHaveBeenCalledWith([score.tracks[0]], true);
  });

  it("regenerates the MIDI for pan changes and resumes where it was", () => {
    const { player, api, score, mix, becomeReady } = setup();
    becomeReady();
    api.playerState = PlayerState.Playing;
    api.tickPosition = 1920;
    api.loadMidiForScore.mockImplementation(() => {
      api.tickPosition = 0; // alphaTab rewinds when a MIDI file is loaded
    });

    player.setMix({ ...mix, tracks: mix.tracks.map((t, i) => (i === 0 ? { ...t, pan: 1 } : t)) });

    expect(score.tracks[0]!.playbackInfo.balance).toBe(16);
    expect(api.loadMidiForScore).toHaveBeenCalledOnce();
    expect(api.tickPosition).toBe(1920);
    expect(api.play).toHaveBeenCalledOnce();
  });

  it("does not start playback after a pan change while paused", () => {
    const { player, api, mix } = setup();

    player.setMix({ ...mix, tracks: mix.tracks.map((t) => ({ ...t, pan: -1 })) });

    expect(api.loadMidiForScore).toHaveBeenCalledOnce();
    expect(api.play).not.toHaveBeenCalled();
  });

  it("switches tracks with that track's notation", () => {
    const { player, api, score } = setup();

    player.showTrack(1, { notation: "tab", rhythm: true });

    expect(api.renderTracks).toHaveBeenCalledWith([score.tracks[1]]);
    expect(score.tracks[1]!.staves[0]!.showStandardNotation).toBe(false);
    expect(api.settings.notation.rhythmMode).toBe(TabRhythmMode.ShowWithBars);
    expect(api.render).not.toHaveBeenCalled(); // renderTracks renders

    player.showTrack(42, { notation: "tab", rhythm: true });
    expect(api.renderTracks).toHaveBeenCalledOnce();
  });

  it("re-renders for notation and layout changes", () => {
    const { player, api, score } = setup();

    player.setView({ notation: "score", rhythm: false });
    expect(score.tracks[0]!.staves[0]!.showTablature).toBe(false);
    expect(api.settings.notation.rhythmMode).toBe(TabRhythmMode.Hidden);

    player.setLayout("horizontal");
    expect(api.settings.display.layoutMode).toBe(LayoutMode.Horizontal);
    expect(api.updateSettings).toHaveBeenCalledTimes(2);
    expect(api.render).toHaveBeenCalledTimes(2);
  });

  it("only plays once playback is ready", () => {
    const { player, api, becomeReady } = setup();

    player.playPause();
    expect(api.playPause).not.toHaveBeenCalled();

    becomeReady();
    player.playPause();
    player.stop();
    expect(api.playPause).toHaveBeenCalledOnce();
    expect(api.stop).toHaveBeenCalledOnce();
  });

  it("seeks to the start of a bar", () => {
    const { player, api, score, callbacks } = setup();

    player.seekToBar(2);

    expect(api.tickCache.getMasterBarStart).toHaveBeenCalledWith(score.masterBars[2]);
    expect(api.tickPosition).toBe(3840);
    expect(callbacks.onBarChange).toHaveBeenCalledWith(2);

    player.seekToBar(99);
    expect(callbacks.onBarChange).toHaveBeenCalledOnce();
  });

  it("switches SoundFonts and returns to the same position when ready", () => {
    const { player, api, callbacks, becomeReady } = setup();
    becomeReady();
    api.tickPosition = 7680;

    player.setSoundFont("/soundfont/FluidR3Mono_GM.sf3");

    expect(api.pause).toHaveBeenCalled();
    expect(api.resetSoundFonts).toHaveBeenCalled();
    expect(api.loadSoundFont).toHaveBeenCalledWith("/soundfont/FluidR3Mono_GM.sf3", false);
    expect(callbacks.onReadyChange.mock.calls).toEqual([[true], [false]]);

    api.tickPosition = 0; // alphaTab reloads the song with the new sounds
    becomeReady();
    expect(api.tickPosition).toBe(7680);
    expect(callbacks.onReadyChange.mock.calls).toEqual([[true], [false], [true]]);

    api.tickPosition = 960;
    becomeReady(); // later reloads (e.g. pan changes) keep their own position
    expect(api.tickPosition).toBe(960);
  });

  it("reports SoundFont failures separately from other errors", async () => {
    const { api, callbacks } = setup();
    const soundFontError = new Error("404");
    const renderError = new Error("render");

    // alphaTab forwards SoundFont failures to `error` first.
    api.error.trigger(soundFontError);
    api.player.soundFontLoadFailed.trigger(soundFontError);
    api.error.trigger(renderError);
    await Promise.resolve();

    expect(callbacks.onSoundFontError).toHaveBeenCalledExactlyOnceWith(soundFontError);
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(renderError);
  });

  it("releases alphaTab when destroyed", () => {
    const { player, api } = setup();
    player.destroy();
    expect(api.destroy).toHaveBeenCalled();
  });
});
