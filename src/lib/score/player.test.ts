import { LayoutMode, PlayerOutputMode, synth, TabRhythmMode } from "@coderline/alphatab";

import { mixFromScore } from "@/lib/score/mixer";
import {
  isSoundFont,
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

const SONIVOX = "/soundfont/sonivox.sf3";
const FLUID = "/soundfont/FluidR3Mono_GM.sf3";
/** A minimal SoundFont header: RIFF, size, `sfbk`, then a marker byte. */
const soundFont = (marker: number) =>
  new Uint8Array([
    ...new TextEncoder().encode("RIFF"),
    0,
    0,
    0,
    0,
    ...new TextEncoder().encode("sfbk"),
    marker,
  ]);

/** Distinct bytes per SoundFont, so tests can tell which one was loaded. */
const BYTES: Record<string, Uint8Array> = {
  [SONIVOX]: soundFont(1),
  [FLUID]: soundFont(2),
};

/** `fetch` whose downloads finish when the test says so. */
function stubDownloads() {
  const pending = new Map<string, { resolve: (r: Response) => void; reject: (e: Error) => void }>();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string) =>
        new Promise<Response>((resolve, reject) => pending.set(url, { resolve, reject })),
    ),
  );
  const settle = async (
    url: string,
    how: (p: NonNullable<ReturnType<typeof pending.get>>) => void,
  ) => {
    const download = pending.get(url);
    if (!download) throw new Error(`${url} was not requested`);
    pending.delete(url);
    how(download);
    await flush();
  };
  return {
    finish: (url: string) => settle(url, (d) => d.resolve(new Response(BYTES[url]!.slice()))),
    fail: (url: string, status = 404) =>
      settle(url, (d) => d.resolve(new Response(null, { status }))),
    /** A server that answers with a web page (e.g. a dev server's fallback). */
    html: (url: string) =>
      settle(url, (d) => d.resolve(new Response("<!DOCTYPE html><html></html>"))),
    error: (url: string) => settle(url, (d) => d.reject(new TypeError("offline"))),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup(overrides: Partial<ScorePlayerOptions> = {}) {
  const downloads = stubDownloads();
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
      soundFontUrl: SONIVOX,
      ...overrides,
    },
    callbacks,
  );
  const api = FakeAlphaTabApi.last;
  /** alphaTab finished loading the SoundFont and the song. */
  const becomeReady = () => api.player.readyForPlayback.trigger();
  const setPlaying = (playing: boolean) => {
    api.playerState = playing ? PlayerState.Playing : PlayerState.Paused;
    api.playerStateChanged.trigger({ state: api.playerState, stopped: false });
  };
  return { player, api, score, mix, callbacks, downloads, becomeReady, setPlaying };
}

/** A player whose default sounds are loaded and which can play. */
async function readySetup(overrides: Partial<ScorePlayerOptions> = {}) {
  const context = await setup(overrides);
  context.api.player.ready.trigger();
  await context.downloads.finish(SONIVOX);
  context.becomeReady();
  vi.clearAllMocks();
  return context;
}

describe("isSoundFont", () => {
  it("recognises SF2/SF3 files by their RIFF header", () => {
    expect(isSoundFont(soundFont(0))).toBe(true);
    expect(isSoundFont(new TextEncoder().encode("<!DOCTYPE html><html>"))).toBe(false);
    expect(isSoundFont(new TextEncoder().encode("RIFF0000WAVEfmt "))).toBe(false); // audio, not sounds
    expect(isSoundFont(new Uint8Array([82, 73]))).toBe(false);
  });
});

describe("ScorePlayer", () => {
  it("configures alphaTab for glitch-free rendering and playback", async () => {
    const { api, score } = await setup({ layout: "horizontal", reducedMotion: true });
    const { settings } = api;

    expect(settings.display.layoutMode).toBe(LayoutMode.Horizontal);
    expect(settings.player.outputMode).toBe(PlayerOutputMode.WebAudioAudioWorklets);
    expect(settings.player.bufferTimeInMilliseconds).toBe(500);
    expect(settings.player.soundFont).toBeNull(); // loaded by the adapter
    expect(settings.core.fontDirectory).toBe("/font/");
    expect(settings.player.enableCursor).toBe(true);
    expect(settings.player.enableUserInteraction).toBe(true);
    expect(settings.player.enableAnimatedBeatCursor).toBe(false);
    expect(api.renderScore).toHaveBeenCalledWith(score, [0]);
  });

  it("loads the SoundFont once the synthesizer is ready", async () => {
    const { api, downloads } = await setup();

    await downloads.finish(SONIVOX);
    expect(api.loadSoundFont).not.toHaveBeenCalled();

    api.player.ready.trigger();
    await flush();
    expect(api.loadSoundFont).toHaveBeenCalledExactlyOnceWith(BYTES[SONIVOX], false);
  });

  it("writes pan into the model before the MIDI is generated", async () => {
    const { score } = await setup();
    expect(score.tracks[1]!.playbackInfo.balance).toBe(4); // pan -0.5
  });

  it("reports rendering, playing, tempo and bar changes", async () => {
    const { api, callbacks, setPlaying } = await setup();

    api.renderStarted.trigger(false);
    api.renderFinished.trigger({});
    setPlaying(true);
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

  it("reports the position at most once per second, and every tempo change", async () => {
    const { api, callbacks } = await setup();
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

  it("reports the bar clicked in the score, even while paused", async () => {
    const { api, callbacks } = await setup();

    api.beatMouseDown.trigger({ voice: { bar: { index: 3 } } });

    expect(callbacks.onBarChange).toHaveBeenCalledWith(3);
  });

  it("ignores repeated beats in the same bar", async () => {
    const { api, callbacks } = await setup();
    api.playedBeatChanged.trigger({ voice: { bar: { index: 1 } } });
    api.playedBeatChanged.trigger({ voice: { bar: { index: 1 } } });
    expect(callbacks.onBarChange).toHaveBeenCalledTimes(1);
  });

  it("applies the whole mix whenever playback becomes ready", async () => {
    const { api, score, mix, callbacks, becomeReady } = await setup();

    becomeReady();

    expect(callbacks.onReadyChange).toHaveBeenCalledWith(true);
    expect(api.masterVolume).toBe(1);
    expect(api.changeTrackVolume).toHaveBeenCalledWith([score.tracks[1]], mix.tracks[1]!.volume);
    expect(api.changeTrackMute).toHaveBeenCalledWith([score.tracks[3]], true);
    expect(api.changeTrackSolo).toHaveBeenCalledTimes(4);
  });

  it("only sends mixer changes that differ", async () => {
    const { player, api, score, mix } = await readySetup();

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

  it("applies volume, mute and solo instantly during playback, without reloading", async () => {
    const { player, api, mix, setPlaying } = await readySetup();
    setPlaying(true);

    player.setMix({ ...mix, tracks: mix.tracks.map((t) => ({ ...t, mute: true, volume: 0.5 })) });

    expect(api.changeTrackMute).toHaveBeenCalledTimes(3); // the piano was already muted
    expect(api.changeTrackVolume).toHaveBeenCalledTimes(4);
    expect(api.loadMidiForScore).not.toHaveBeenCalled();
    expect(api.pause).not.toHaveBeenCalled();
  });

  it("keeps mixer changes made before playback is ready for later", async () => {
    const { player, api, score, mix, becomeReady } = await setup();

    player.setMix({ ...mix, tracks: mix.tracks.map((t) => ({ ...t, mute: true })) });
    expect(api.changeTrackMute).not.toHaveBeenCalled();

    becomeReady();
    expect(api.changeTrackMute).toHaveBeenCalledWith([score.tracks[0]], true);
  });

  it("applies pan right away while paused", async () => {
    const { player, api, score, mix } = await readySetup();
    api.tickPosition = 1920;
    api.loadMidiForScore.mockImplementation(() => {
      api.tickPosition = 0; // alphaTab rewinds when a MIDI file is loaded
    });

    player.setMix({ ...mix, tracks: mix.tracks.map((t, i) => (i === 0 ? { ...t, pan: 1 } : t)) });

    expect(score.tracks[0]!.playbackInfo.balance).toBe(16);
    expect(api.loadMidiForScore).toHaveBeenCalledOnce();
    expect(api.tickPosition).toBe(1920);
    expect(api.play).not.toHaveBeenCalled();
  });

  it("hides alphaTab's rewind while the MIDI is regenerated", async () => {
    const { player, api, mix, callbacks, becomeReady } = await readySetup();
    const position = (currentTime: number) =>
      api.playerPositionChanged.trigger({
        currentTime,
        endTime: 12_000,
        originalTempo: 60,
        modifiedTempo: 60,
      });
    position(5_000);
    api.tickPosition = 4_800;
    api.loadMidiForScore.mockImplementation(() => {
      api.tickPosition = 0;
    });

    player.setMix({ ...mix, tracks: mix.tracks.map((t) => ({ ...t, pan: 1 })) });
    position(0); // reported while the new MIDI loads
    api.tickPosition = 0; // a late rewind from alphaTab
    becomeReady();
    position(5_000);

    expect(api.tickPosition).toBe(4_800);
    expect(api.play).not.toHaveBeenCalled();
    expect(callbacks.onPositionChange.mock.calls.map(([p]) => p.currentMs)).toEqual([5_000]);
  });

  it("never interrupts playback for pan: applies it at the next pause", async () => {
    const { player, api, mix, setPlaying } = await readySetup();
    setPlaying(true);
    api.tickPosition = 5760;

    player.setMix({ ...mix, tracks: mix.tracks.map((t, i) => (i === 1 ? { ...t, pan: 1 } : t)) });
    player.setMix({ ...mix, tracks: mix.tracks.map((t, i) => (i === 1 ? { ...t, pan: 0.5 } : t)) });
    expect(api.loadMidiForScore).not.toHaveBeenCalled();

    setPlaying(false);
    expect(api.loadMidiForScore).toHaveBeenCalledOnce();
    expect(api.tickPosition).toBe(5760);
    expect(api.play).not.toHaveBeenCalled();

    setPlaying(true);
    setPlaying(false);
    expect(api.loadMidiForScore).toHaveBeenCalledOnce(); // nothing left to apply
  });

  it("switches tracks with that track's notation", async () => {
    const { player, api, score } = await setup();

    player.showTrack(1, { notation: "tab", rhythm: true });

    expect(api.renderTracks).toHaveBeenCalledWith([score.tracks[1]]);
    expect(score.tracks[1]!.staves[0]!.showStandardNotation).toBe(false);
    expect(api.settings.notation.rhythmMode).toBe(TabRhythmMode.ShowWithBars);
    expect(api.render).not.toHaveBeenCalled(); // renderTracks renders

    player.showTrack(42, { notation: "tab", rhythm: true });
    expect(api.renderTracks).toHaveBeenCalledOnce();
  });

  it("re-renders for notation and layout changes without touching playback", async () => {
    const { player, api, score, setPlaying } = await readySetup();
    setPlaying(true);

    player.setView({ notation: "score", rhythm: false });
    expect(score.tracks[0]!.staves[0]!.showTablature).toBe(false);
    expect(api.settings.notation.rhythmMode).toBe(TabRhythmMode.Hidden);

    player.setLayout("horizontal");
    player.showTrack(2, { notation: "score", rhythm: false });

    expect(api.settings.display.layoutMode).toBe(LayoutMode.Horizontal);
    expect(api.render).toHaveBeenCalledTimes(2);
    expect(api.loadMidiForScore).not.toHaveBeenCalled();
    expect(api.pause).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
  });

  it("only plays once playback is ready", async () => {
    const { player, api, becomeReady } = await setup();

    player.playPause();
    expect(api.playPause).not.toHaveBeenCalled();

    becomeReady();
    player.playPause();
    player.stop();
    expect(api.playPause).toHaveBeenCalledOnce();
    expect(api.stop).toHaveBeenCalledOnce();
  });

  it("seeks to the start of a bar", async () => {
    const { player, api, score, callbacks } = await setup();

    player.seekToBar(2);

    expect(api.tickCache.getMasterBarStart).toHaveBeenCalledWith(score.masterBars[2]);
    expect(api.tickPosition).toBe(3840);
    expect(callbacks.onBarChange).toHaveBeenCalledWith(2);

    player.seekToBar(99);
    expect(callbacks.onBarChange).toHaveBeenCalledOnce();
  });

  describe("switching SoundFonts", () => {
    it("keeps playing while the new sounds download", async () => {
      const { player, api, setPlaying } = await readySetup();
      setPlaying(true);

      void player.setSoundFont(FLUID);
      await flush();

      expect(api.pause).not.toHaveBeenCalled();
      expect(api.resetSoundFonts).not.toHaveBeenCalled();
    });

    it("continues playing from the same position once they are loaded", async () => {
      const { player, api, callbacks, downloads, becomeReady, setPlaying } = await readySetup();
      setPlaying(true);
      api.tickPosition = 7680;

      void player.setSoundFont(FLUID);
      await downloads.finish(FLUID);

      expect(api.pause).toHaveBeenCalledOnce();
      expect(api.resetSoundFonts).toHaveBeenCalledOnce();
      expect(api.loadSoundFont).toHaveBeenCalledExactlyOnceWith(BYTES[FLUID], false);
      expect(callbacks.onReadyChange).toHaveBeenLastCalledWith(false);

      setPlaying(false);
      api.tickPosition = 0; // alphaTab reloads the song with the new sounds
      becomeReady();

      expect(api.tickPosition).toBe(7680);
      expect(callbacks.onReadyChange).toHaveBeenLastCalledWith(true);
      expect(api.play).toHaveBeenCalledOnce();

      api.tickPosition = 960;
      becomeReady(); // later reloads (e.g. pan) keep their own position and state
      expect(api.tickPosition).toBe(960);
      expect(api.play).toHaveBeenCalledOnce();
    });

    it("keeps showing the position while the new sounds load", async () => {
      const { player, api, callbacks, downloads, becomeReady } = await readySetup();
      const position = (currentTime: number) =>
        api.playerPositionChanged.trigger({
          currentTime,
          endTime: 12_000,
          originalTempo: 60,
          modifiedTempo: 60,
        });
      position(5_000);
      api.tickPosition = 4800;

      void player.setSoundFont(FLUID);
      await downloads.finish(FLUID);
      position(0); // alphaTab rewinds while it reloads
      becomeReady();
      position(5_000); // after the position is restored

      expect(callbacks.onPositionChange.mock.calls.map(([p]) => p.currentMs)).toEqual([5_000]);
    });

    it("stays paused after switching while paused", async () => {
      const { player, api, downloads, becomeReady } = await readySetup();
      api.tickPosition = 3840;

      void player.setSoundFont(FLUID);
      await downloads.finish(FLUID);
      api.tickPosition = 0;
      becomeReady();

      expect(api.tickPosition).toBe(3840);
      expect(api.play).not.toHaveBeenCalled();
    });

    it("loads only the latest choice when switching quickly", async () => {
      const { player, api, downloads, becomeReady, setPlaying } = await readySetup();
      setPlaying(true);
      api.tickPosition = 4800;

      void player.setSoundFont(FLUID);
      void player.setSoundFont(SONIVOX);
      await downloads.finish(SONIVOX);
      await downloads.finish(FLUID); // finishes last, but was replaced

      expect(api.loadSoundFont).toHaveBeenCalledExactlyOnceWith(BYTES[SONIVOX], false);
      setPlaying(false);
      api.tickPosition = 0;
      becomeReady();
      expect(api.tickPosition).toBe(4800);
      expect(api.play).toHaveBeenCalledOnce();
    });

    it("keeps the original position if switched again while loading", async () => {
      const { player, api, downloads, becomeReady, setPlaying } = await readySetup();
      setPlaying(true);
      api.tickPosition = 4800;

      void player.setSoundFont(FLUID);
      await downloads.finish(FLUID);
      setPlaying(false);
      api.tickPosition = 0; // reported while loading
      void player.setSoundFont(SONIVOX);
      await downloads.finish(SONIVOX);
      becomeReady();

      expect(api.tickPosition).toBe(4800);
      expect(api.play).toHaveBeenCalledOnce();
    });

    it("follows seeking and stopping while the sounds load", async () => {
      const { player, api, downloads, becomeReady, setPlaying } = await readySetup();
      setPlaying(true);
      api.tickPosition = 960;

      void player.setSoundFont(FLUID);
      await downloads.finish(FLUID);
      player.seekToBar(1);
      becomeReady();
      expect(api.tickPosition).toBe(3840);

      void player.setSoundFont(SONIVOX);
      await downloads.finish(SONIVOX);
      player.stop();
      api.play.mockClear();
      becomeReady();
      expect(api.tickPosition).toBe(0);
      expect(api.play).not.toHaveBeenCalled();
    });

    it("reports a failed download and keeps the current sounds", async () => {
      const { player, api, callbacks, downloads } = await readySetup();

      void player.setSoundFont(FLUID);
      await downloads.fail(FLUID);

      expect(callbacks.onSoundFontError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("404") }),
        { previousKept: true },
      );
      expect(api.resetSoundFonts).not.toHaveBeenCalled();
      expect(callbacks.onReadyChange).not.toHaveBeenCalled();

      void player.setSoundFont(FLUID);
      await downloads.error(FLUID);
      expect(callbacks.onSoundFontError).toHaveBeenLastCalledWith(new TypeError("offline"), {
        previousKept: true,
      });
    });

    it("reports when no sounds are loaded at all", async () => {
      const { callbacks, downloads } = await setup();

      await downloads.fail(SONIVOX);

      expect(callbacks.onSoundFontError).toHaveBeenCalledWith(expect.any(Error), {
        previousKept: false,
      });
    });

    it("refuses a download that is not a SoundFont", async () => {
      const { player, api, callbacks, downloads } = await readySetup();

      void player.setSoundFont(FLUID);
      await downloads.html(FLUID);

      expect(callbacks.onSoundFontError).toHaveBeenCalledWith(
        new Error(`${FLUID} is not a SoundFont.`),
        { previousKept: true },
      );
      expect(api.loadSoundFont).not.toHaveBeenCalled();
    });

    it("ignores failures of a replaced download", async () => {
      const { player, callbacks, downloads } = await readySetup();

      void player.setSoundFont(FLUID);
      void player.setSoundFont(SONIVOX);
      await downloads.fail(FLUID);

      expect(callbacks.onSoundFontError).not.toHaveBeenCalled();
    });

    it("does nothing once the player is destroyed", async () => {
      const { player, api, downloads } = await readySetup();

      void player.setSoundFont(FLUID);
      player.destroy();
      await downloads.finish(FLUID);

      expect(api.destroy).toHaveBeenCalled();
      expect(api.loadSoundFont).not.toHaveBeenCalled();
    });

    it("reports SoundFonts the synthesizer can't read separately from other errors", async () => {
      const { api, callbacks } = await setup();
      const soundFontError = new Error("bad SoundFont");
      const renderError = new Error("render");

      // alphaTab forwards SoundFont failures to `error` first.
      api.error.trigger(soundFontError);
      api.player.soundFontLoadFailed.trigger(soundFontError);
      api.error.trigger(renderError);
      await Promise.resolve();

      expect(callbacks.onSoundFontError).toHaveBeenCalledExactlyOnceWith(soundFontError, {
        previousKept: false,
      });
      expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(renderError);
    });
  });
});
