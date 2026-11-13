/**
 * Hybrid playback: alphaTab's SoundFonts synthesizer plays the notes and the native engine plays
 * the audio lanes, in time with it (ADR 0003). The engine has only the lanes: a song with the
 * tempo map and no tracks, and it follows alphaTab's transport.
 */
import { midi, synth } from "@coderline/alphatab";

import { EMPTY_AUDIO, newClip, newLane } from "@/lib/audio-lanes/model";
import { addClip, addLane, addSource } from "@/lib/audio-lanes/edits";
import { mixFromScore } from "@/lib/score/mixer";
import { ScorePlayer } from "@/lib/score/player";
import { parseScore } from "@/lib/score/score";
import * as tauri from "@/lib/tauri";
import { FakeAlphaTabApi } from "@/test/fake-alphatab";
import { fixtureBytes } from "@/test/score";

vi.mock(import("@coderline/alphatab"), async (importOriginal) => ({
  ...(await importOriginal()),
  AlphaTabApi: (await import("@/test/fake-alphatab")).FakeAlphaTabApi as never,
}));

// The desktop app: the native engine exists.
vi.mock("@/lib/audio/engine-preference", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  nativeEngineAvailable: () => true,
}));

let clock = 0;
/** The engine is closed until a player starts it. */
let running = false;
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof tauri>();
  return {
    ...actual,
    loadEngineSoundFont: vi.fn(() => Promise.resolve()),
    startEngine: vi.fn(() => {
      running = true;
      return Promise.resolve({});
    }),
    loadEngineSong: vi.fn(() => Promise.resolve()),
    engineState: vi.fn(() =>
      Promise.resolve({
        running,
        sampleRate: 48_000,
        latencyMs: 20,
        clockFrames: clock,
        durationMs: 8_000,
        positionMs: 0,
        playing: false,
      }),
    ),
    engineTransport: vi.fn(() => Promise.resolve()),
    setEngineLanes: vi.fn(() => Promise.resolve()),
    setEngineChain: vi.fn(() => Promise.resolve([])),
    setEngineSounds: vi.fn(() => Promise.resolve([])),
    setEngineAutomation: vi.fn(() => Promise.resolve()),
    setEngineTrackEq: vi.fn(() => Promise.resolve()),
    setEngineDrumMix: vi.fn(() => Promise.resolve()),
    setEngineTrackKit: vi.fn(() => Promise.resolve()),
    setEngineMonitorChain: vi.fn(() => Promise.resolve([])),
    setEngineMix: vi.fn(() => Promise.resolve()),
    setEngineMonitor: vi.fn(() => Promise.resolve(null)),
    loadAudioSource: vi.fn(() =>
      Promise.resolve({ id: "s".repeat(64), name: "a.wav", ext: "wav", durationMs: 1000 }),
    ),
  };
});

const { PlayerState } = synth;
const mocked = vi.mocked(tauri);
const SF = new Uint8Array([
  ...new TextEncoder().encode("RIFF"),
  0,
  0,
  0,
  0,
  ...new TextEncoder().encode("sfbk"),
]);

/** A mix with one lane that has one clip. */
function withLane(mix: tauri.MixerSettings): tauri.MixerSettings {
  const source = { id: "s".repeat(64), name: "a.wav", ext: "wav", embedded: true };
  const lane = newLane("Drums");
  const audio = addClip(
    addLane(addSource(EMPTY_AUDIO, source), lane),
    lane.id,
    newClip(source.id, "a.wav", 0, 4_000),
  );
  return { ...mix, audio };
}

async function setup(laneMix = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(SF.slice()))),
  );
  const { score, summary } = parseScore(fixtureBytes("practice-song.gp"));
  const onError = vi.fn();
  const base = mixFromScore(summary);
  const mix = laneMix ? withLane(base) : base;
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
      audioEngine: "alphatab",
    },
    { onError },
  );
  const api = FakeAlphaTabApi.last;
  return { player, api, mix, onError };
}

/** alphaTab's MIDI: 120 beats a minute, 960 ticks a quarter, 4 bars. */
function midiFile() {
  const file = new midi.MidiFile();
  file.division = 960;
  file.addEvent(new midi.TempoChangeEvent(0, 500_000));
  file.addEvent(new midi.NoteOnEvent(0, 0, 0, 40, 100));
  file.addEvent(new midi.NoteOffEvent(0, 960 * 16, 0, 40, 0));
  return file;
}

const transports = () => mocked.engineTransport.mock.calls.map(([command]) => command);
/** The positions the lanes engine was sent to (ms). */
const seeks = () =>
  transports().flatMap((command) => (command.type === "seek" ? [command.ms] : []));

describe("ScorePlayer: audio lanes with the SoundFonts synthesizer (hybrid)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clock = 0;
    running = false;
  });

  it("plays lanes with the native engine while alphaTab's synthesizer plays the notes", async () => {
    const { player, api } = await setup();
    expect(player.usesNativeEngine).toBe(false);
    expect(player.playsLanes).toBe(true);
    (api as unknown as { tickCache: unknown }).tickCache = null;
    api.midiLoad.trigger(midiFile());
    // The engine opens with the small SoundFont that ships with the app, and gets a song with the
    // tempo map and length but no tracks and no notes, then the lanes.
    await vi.waitFor(() => expect(mocked.loadEngineSong).toHaveBeenCalled());
    expect(mocked.startEngine).toHaveBeenCalledWith("sonivox");
    expect(mocked.loadEngineSong.mock.calls[0]![0]).toMatchObject({
      division: 960,
      tempos: [[0, 120]],
      tracks: [],
      events: [],
      endTick: 960 * 16,
    });
    await vi.waitFor(() => expect(mocked.setEngineLanes).toHaveBeenCalled());
    expect(mocked.setEngineLanes.mock.calls[0]![0]?.audio.lanes).toHaveLength(1);
  });

  it("does not open the engine for a song without lanes", async () => {
    const { api } = await setup(false);
    (api as unknown as { tickCache: unknown }).tickCache = null;
    api.midiLoad.trigger(midiFile());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocked.startEngine).not.toHaveBeenCalled();
    expect(mocked.loadEngineSong).not.toHaveBeenCalled();
  });

  it("starts the lanes where the notes start, and pauses them with the notes", async () => {
    const { api } = await setup();
    (api as unknown as { tickCache: unknown }).tickCache = null;
    api.midiLoad.trigger(midiFile());
    await vi.waitFor(() => expect(mocked.setEngineLanes).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    mocked.engineTransport.mockClear();

    api.tickPosition = 960 * 4; // two seconds in
    api.playerStateChanged.trigger({ state: PlayerState.Playing, stopped: false });
    await vi.waitFor(() => expect(transports().some((c) => c.type === "seek")).toBe(true));
    // The engine's sound is heard 20 ms after it renders and the notes at once (no output latency
    // measured here): the lanes begin 20 ms into the song, so both are heard together.
    expect(seeks()[0]).toBeCloseTo(2_020, 3);
    // On a moment of the engine's clock, or at once when it was not read yet.
    expect(transports().some((c) => c.type === "playAtFrame" || c.type === "play")).toBe(true);

    mocked.engineTransport.mockClear();
    api.playerStateChanged.trigger({ state: PlayerState.Paused, stopped: false });
    await vi.waitFor(() => expect(transports()).toContainEqual({ type: "pause" }));
  });

  it("gives the lanes the speed and the loop of the notes, and follows a seek while paused", async () => {
    const { player, api } = await setup();
    (api as unknown as { tickCache: unknown }).tickCache = null;
    api.midiLoad.trigger(midiFile());
    await vi.waitFor(() => expect(mocked.setEngineLanes).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    mocked.engineTransport.mockClear();

    player.setSpeed(50);
    await vi.waitFor(() => expect(transports()).toContainEqual({ type: "rate", value: 0.5 }));

    mocked.engineTransport.mockClear();
    api.playerPositionChanged.trigger({ currentTick: 960 * 8, currentTime: 4_000, endTime: 8_000 });
    await vi.waitFor(() => expect(seeks()).toHaveLength(1));
    expect(seeks()[0]).toBeCloseTo(4_000, 3);
  });

  it("opens lane files with the lanes engine, and says nothing plays lanes outside the desktop app", async () => {
    const { player } = await setup();
    const info = await player.loadSource({ type: "file", path: "/music/a.wav" });
    expect(info.name).toBe("a.wav");
    expect(mocked.loadAudioSource).toHaveBeenCalledWith({ type: "file", path: "/music/a.wav" });
  });

  it("a shared start waits until the lanes engine has the song, and is ready for a song without lanes", async () => {
    const { player, api } = await setup();
    (api as unknown as { tickCache: unknown }).tickCache = null;
    let release: () => void = () => {};
    mocked.loadEngineSong.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    api.midiLoad.trigger(midiFile());
    await vi.waitFor(() => expect(mocked.loadEngineSong).toHaveBeenCalled());
    let ready: boolean | null = null;
    void player.prepareStart(2_000).then((value) => (ready = value));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ready).toBeNull();
    release();
    await vi.waitFor(() => expect(ready).not.toBeNull());
  });

  it("stays off with lanes: false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(SF.slice()))),
    );
    const { score, summary } = parseScore(fixtureBytes("practice-song.gp"));
    const player = new ScorePlayer(
      {
        element: document.createElement("div"),
        scrollElement: document.createElement("div"),
        score,
        trackIndex: 0,
        view: { notation: "score-tab", rhythm: false },
        layout: "page",
        mix: mixFromScore(summary),
        soundFontUrl: "/soundfont/sonivox.sf3",
        audioEngine: "alphatab",
        lanes: false,
      },
      {},
    );
    expect(player.playsLanes).toBe(false);
    await expect(player.loadSource({ type: "file", path: "/a.wav" })).rejects.toThrow(
      "desktop app",
    );
  });
});
