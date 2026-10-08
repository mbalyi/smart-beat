/**
 * ScorePlayer with the native audio engine: alphaTab follows the engine's
 * clock (external media), the engine gets the sounds, the MIDI, the mix and
 * the effect chains, and exports come from the engine.
 */
import { midi, PlayerMode } from "@coderline/alphatab";

import { defaultEffect } from "@/lib/audio/effects";
import { mixerReducer, mixFromScore } from "@/lib/score/mixer";
import type { NativeEngine } from "@/lib/audio/native-engine";
import { ScorePlayer } from "@/lib/score/player";
import { parseScore } from "@/lib/score/score";
import * as tauri from "@/lib/tauri";
import { FakeAlphaTabApi } from "@/test/fake-alphatab";
import { fixtureBytes } from "@/test/score";

vi.mock(import("@coderline/alphatab"), async (importOriginal) => ({
  ...(await importOriginal()),
  AlphaTabApi: (await import("@/test/fake-alphatab")).FakeAlphaTabApi as never,
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof tauri>();
  return {
    ...actual,
    loadEngineSoundFont: vi.fn(() => Promise.resolve()),
    startEngine: vi.fn(() => Promise.resolve({})),
    loadEngineSong: vi.fn(() => Promise.resolve()),
    engineState: vi.fn(() => Promise.resolve({ durationMs: 5_000, positionMs: 0, playing: false })),
    engineTransport: vi.fn(() => Promise.resolve()),
    setEngineMix: vi.fn(() => Promise.resolve()),
    setEngineChain: vi.fn(() =>
      Promise.resolve([{ index: 0, message: "Amp model “x” is not in the library" }]),
    ),
    renderEngineAudio: vi.fn(() => Promise.resolve(new Float32Array([0.1, -0.1]))),
  };
});

const mocked = vi.mocked(tauri);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const SF = new Uint8Array([
  ...new TextEncoder().encode("RIFF"),
  0,
  0,
  0,
  0,
  ...new TextEncoder().encode("sfbk"),
]);

async function setup() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(SF.slice()))),
  );
  const { score, summary } = parseScore(fixtureBytes("practice-song.gp"));
  const onEffectProblems = vi.fn();
  const onReadyChange = vi.fn();
  const onLoopRestart = vi.fn();
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
      audioEngine: "native",
    },
    { onEffectProblems, onReadyChange, onLoopRestart },
  );
  const api = FakeAlphaTabApi.last;
  return { player, api, mix, onEffectProblems, onReadyChange, onLoopRestart };
}

describe("ScorePlayer with the native engine", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lets alphaTab follow the engine and is ready once the engine has the sounds", async () => {
    const { player, api, onReadyChange } = await setup();
    expect(api.settings.player.playerMode).toBe(PlayerMode.EnabledExternalMedia);
    expect(api.player.output.handler).toBeDefined();
    expect(player.usesNativeEngine).toBe(true);

    api.player.readyForPlayback.trigger(); // alphaTab has the MIDI
    expect(onReadyChange).not.toHaveBeenCalledWith(true);
    api.player.ready.trigger();
    await vi.waitFor(() => expect(mocked.startEngine).toHaveBeenCalledWith("sonivox.sf3"));
    await vi.waitFor(() => expect(onReadyChange).toHaveBeenCalledWith(true));
    expect(mocked.loadEngineSoundFont).toHaveBeenCalledWith("sonivox.sf3", expect.any(Uint8Array));
    expect(mocked.setEngineMix).toHaveBeenCalled();
  });

  it("sends alphaTab's MIDI, the effect chains and the metronome to the engine", async () => {
    const { player, api, mix, onEffectProblems } = await setup();
    const file = new midi.MidiFile();
    file.division = 960;
    file.addEvent(new midi.NoteOnEvent(0, 0, 0, 40, 100));
    (api as unknown as { tickCache: unknown }).tickCache = null; // no effects to approximate
    api.midiLoad.trigger(file);
    await vi.waitFor(() => expect(mocked.loadEngineSong).toHaveBeenCalled());
    expect(mocked.loadEngineSong.mock.calls[0]![0].events).toContainEqual([0, 0x90, 40, 100]);

    api.player.ready.trigger();
    api.player.readyForPlayback.trigger();
    await vi.waitFor(() => expect(mocked.startEngine).toHaveBeenCalled());
    await flush();
    vi.clearAllMocks();

    const next = mixerReducer(mix, { type: "effects", track: 0, slots: [defaultEffect("gate")] });
    player.setMix(next);
    await vi.waitFor(() => expect(mocked.setEngineChain).toHaveBeenCalledTimes(1));
    expect(mocked.setEngineChain).toHaveBeenCalledWith(0, [defaultEffect("gate")]);
    await vi.waitFor(() =>
      expect(onEffectProblems).toHaveBeenCalledWith(
        expect.objectContaining({
          // Per track, per sound: the blocks that cannot run.
          tracks: expect.arrayContaining([[[expect.objectContaining({ index: 0 })]]]),
        }),
      ),
    );

    player.setMetronome(true);
    await vi.waitFor(() =>
      expect(mocked.engineTransport).toHaveBeenCalledWith({ type: "metronome", volume: 1 }),
    );
  });

  it("exports audio rendered by the engine (with the effects)", async () => {
    const { player, api } = await setup();
    api.player.ready.trigger();
    api.player.readyForPlayback.trigger();
    await vi.waitFor(() => expect(mocked.startEngine).toHaveBeenCalled());
    await flush();
    const audio = await player.renderAudio();
    expect(mocked.renderEngineAudio).toHaveBeenCalledWith(44_100);
    expect(audio).toEqual({
      samples: new Float32Array([0.1, -0.1]),
      sampleRate: 44_100,
      channels: 2,
    });
    expect(api.exportAudio).not.toHaveBeenCalled();
  });

  it("previews drums through the engine", async () => {
    const { player } = await setup();
    player.previewDrum(42);
    await vi.waitFor(() =>
      expect(mocked.engineTransport).toHaveBeenCalledWith({
        type: "preview",
        channel: 9,
        key: 42,
        velocity: 100,
      }),
    );
  });

  /** The player's engine (private). */
  const engineOf = (player: ScorePlayer) => (player as unknown as { engine: NativeEngine }).engine;
  /** The engine's report of finished loops (a private callback). */
  const reportLoops = (player: ScorePlayer, count: number) =>
    (
      engineOf(player) as unknown as { callbacks: { onLoops?: (count: number) => void } }
    ).callbacks.onLoops?.(count);

  it("advances the Speed Trainer on the engine's own loops, once each (#83)", async () => {
    const { player, api, onLoopRestart } = await setup();
    reportLoops(player, 1);
    expect(onLoopRestart).not.toHaveBeenCalled(); // no loop set
    player.setLoop({ start: 0, end: 0 });
    // alphaTab's "finished" is not a loop under the engine: the engine reports those.
    api.playerFinished.trigger();
    expect(onLoopRestart).not.toHaveBeenCalled();
    reportLoops(player, 2);
    expect(onLoopRestart).toHaveBeenCalledTimes(2);
  });

  it("counts a bar in before every loop in the loop's own time (#83)", async () => {
    const { player, api } = await setup();
    const setLoop = vi.spyOn(engineOf(player), "setLoop");
    (api as unknown as { tickCache: unknown }).tickCache = {
      getMasterBarStart: (bar: { index: number }) => bar.index * 3840,
    };
    player.setLoopCountIn(true);
    player.setLoop({ start: 2, end: 3 });
    // Bar 3 of the practice song: 4/4 at 120 BPM.
    expect(setLoop).toHaveBeenLastCalledWith(expect.any(Object), { beats: 4, beatSeconds: 0.5 });
    player.setLoopCountIn(false);
    expect(setLoop).toHaveBeenLastCalledWith(expect.any(Object), null);
  });
});
