import { midi, type synth } from "@coderline/alphatab";

import { defaultEffect } from "@/lib/audio/effects";
import {
  busMixes,
  NativeEngine,
  POLL_MS,
  songFromMidi,
  type EngineExtras,
} from "@/lib/audio/native-engine";
import * as tauri from "@/lib/tauri";

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof tauri>();
  return {
    ...actual,
    engineTransport: vi.fn(() => Promise.resolve()),
    engineState: vi.fn(() =>
      Promise.resolve({
        running: true,
        sampleRate: 48_000,
        positionMs: 1_234,
        durationMs: 8_000,
        playing: true,
        latencyMs: 10,
        dropouts: 0,
        loadPercent: 1,
        meters: { tracks: [0.5], master: 0.6 },
      }),
    ),
    loadEngineSong: vi.fn(() => Promise.resolve()),
    loadEngineSoundFont: vi.fn(() => Promise.resolve()),
    startEngine: vi.fn(() => Promise.resolve({})),
    setEngineMix: vi.fn(() => Promise.resolve()),
    setEngineChain: vi.fn(() => Promise.resolve([])),
    setEngineSounds: vi.fn((_t: number, sounds: unknown[]) =>
      Promise.resolve(sounds.map(() => [])),
    ),
    setEngineAutomation: vi.fn(() => Promise.resolve()),
    setEngineTrackEq: vi.fn(() => Promise.resolve()),
    setEngineDrumMix: vi.fn(() => Promise.resolve()),
    setEngineTrackKit: vi.fn(() => Promise.resolve()),
    setEngineBacking: vi.fn(() => Promise.resolve()),
    loadEngineBacking: vi.fn(() =>
      Promise.resolve({
        name: "a.wav",
        durationMs: 1000,
        sampleRate: 44100,
        channels: 1,
        peaks: [],
        peaksPerSecond: 100,
      }),
    ),
    clearEngineBacking: vi.fn(() => Promise.resolve()),
  };
});

const mocked = vi.mocked(tauri);

function file(): midi.MidiFile {
  const f = new midi.MidiFile();
  f.division = 960;
  f.addEvent(new midi.TempoChangeEvent(0, 500_000)); // 120 BPM
  f.addEvent(new midi.ProgramChangeEvent(0, 0, 1, 30));
  f.addEvent(new midi.ControlChangeEvent(0, 0, 1, midi.ControllerType.VolumeCoarse, 100));
  f.addEvent(new midi.AlphaTabMetronomeEvent(0, 0, 0, 960, 500));
  f.addEvent(new midi.NoteOnEvent(0, 0, 1, 40, 96));
  f.addEvent(new midi.PitchBendEvent(0, 480, 1, 10_000));
  f.addEvent(new midi.AlphaTabMetronomeEvent(0, 960, 1, 960, 500));
  f.addEvent(new midi.NoteOffEvent(0, 960, 1, 40, 0));
  f.addEvent(new midi.NoteOnEvent(1, 960, 9, 36, 127));
  return f;
}

describe("songFromMidi", () => {
  it("turns alphaTab's MIDI into plain channel messages, tempos and clicks", () => {
    const song = songFromMidi(file(), [[1, 2], [9]]);
    expect(song.division).toBe(960);
    expect(song.tempos).toEqual([[0, 120]]);
    expect(song.metronome).toEqual([
      [0, true],
      [960, false],
    ]);
    expect(song.events).toEqual([
      [0, 0xc1, 30, 0],
      [0, 0xb1, 7, 100],
      [0, 0x91, 40, 96],
      [480, 0xe1, 10_000 & 0x7f, 10_000 >> 7],
      [960, 0x81, 40, 0],
      [960, 0x99, 36, 127],
    ]);
    expect(song.tracks).toEqual([[1, 2], [9]]);
    expect(song.endTick).toBe(960);
  });
});

describe("busMixes", () => {
  it("keeps volume, mute and solo, leaves pan to the MIDI and adds the focus trim", () => {
    expect(busMixes({ tracks: [{ volume: 0.5, mute: true, solo: false }] })).toEqual([
      { volume: 0.5, pan: 0, mute: true, solo: false, trimDb: 0 },
    ]);
    const two = {
      tracks: [
        { volume: 1, mute: false, solo: false },
        { volume: 1, mute: false, solo: false },
      ],
    };
    expect(busMixes(two, [3, -12]).map((m) => m.trimDb)).toEqual([3, -12]);
  });
});

describe("NativeEngine", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  function output() {
    return {
      handler: undefined as synth.IExternalMediaHandler | undefined,
      updatePosition: vi.fn(),
    } as unknown as synth.IExternalMediaSynthOutput & { updatePosition: ReturnType<typeof vi.fn> };
  }

  it("becomes alphaTab's external media handler and forwards the transport in order", async () => {
    const engine = new NativeEngine();
    const out = output();
    engine.attach(out);
    expect(out.handler).toBe(engine);

    void engine.loadSong(file(), [[1], [9]]);
    engine.playbackRate = 0.5;
    engine.masterVolume = 0.8;
    engine.seekTo(2_000);
    expect(out.updatePosition).toHaveBeenCalledWith(2_000);
    engine.pause();
    await vi.waitFor(() => expect(mocked.engineTransport).toHaveBeenCalledTimes(4));
    // The song was loaded before any transport command ran.
    expect(mocked.loadEngineSong.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.engineTransport.mock.invocationCallOrder[0]!,
    );
    expect(mocked.engineTransport.mock.calls.map(([c]) => c)).toEqual([
      { type: "rate", value: 0.5 },
      { type: "masterVolume", value: 0.8 },
      { type: "seek", ms: 2_000 },
      { type: "pause" },
    ]);
    expect(engine.backingTrackDuration).toBe(8_000);
  });

  it("reports the engine's position and meters while playing", async () => {
    vi.useFakeTimers();
    const onMeters = vi.fn();
    const engine = new NativeEngine({ onMeters });
    const out = output();
    engine.attach(out);
    engine.play();
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(out.updatePosition).toHaveBeenCalledWith(1_234);
    expect(onMeters).toHaveBeenCalledWith({ tracks: [0.5], master: 0.6 });
    engine.destroy();
    expect(out.handler).toBeUndefined();
  });

  const extras = (over: Partial<EngineExtras> = {}): EngineExtras => ({
    sounds: [
      { chains: [[defaultEffect("gate")]], switches: [] },
      { chains: [[]], switches: [] },
    ],
    master: [defaultEffect("gate")],
    automation: [],
    eq: [],
    drums: [],
    masterPan: 0,
    backing: null,
    ...over,
  });

  it("sends a track's drum kit before its drum mixer, and only when it changes (#40)", async () => {
    const engine = new NativeEngine();
    const order: string[] = [];
    mocked.setEngineTrackKit.mockImplementation(async () => void order.push("kit"));
    mocked.setEngineDrumMix.mockImplementation(async () => void order.push("drums"));
    const drums = {
      stereo: true,
      elements: [],
      other: { volume: 1, pan: 0, mute: false, solo: false, trimDb: 0 },
    };
    await engine.configure(extras({ kits: [null, "free-kit"], drums: [null, drums as never] }));
    expect(mocked.setEngineTrackKit.mock.calls).toEqual([[1, "free-kit"]]);
    expect(order).toEqual(["kit", "drums"]);
    mocked.setEngineTrackKit.mockClear();
    await engine.configure(extras({ kits: [null, "free-kit"], drums: [null, drums as never] }));
    expect(mocked.setEngineTrackKit).not.toHaveBeenCalled();
    await engine.configure(extras({ kits: [null, null], drums: [null, drums as never] }));
    expect(mocked.setEngineTrackKit.mock.calls).toEqual([[1, null]]);
  });

  it("sends everything again with every song", async () => {
    const engine = new NativeEngine();
    const gate = defaultEffect("gate");
    await engine.configure(extras());
    mocked.setEngineChain.mockClear();
    await engine.loadSong(file(), [[1], [9]]);
    expect(mocked.setEngineChain.mock.calls).toEqual([
      [0, [gate]],
      [1, []],
      [null, [gate]],
    ]);
  });

  it("only sends what changed, one sound at a time for a knob turn", async () => {
    const engine = new NativeEngine();
    const gate = defaultEffect("gate");
    const delay = defaultEffect("delay");
    const twoSounds = { chains: [[gate], [delay]], switches: [[1920, 1]] as [number, number][] };
    const problems = await engine.configure(extras({ sounds: [twoSounds] }));
    expect(mocked.setEngineSounds).toHaveBeenCalledWith(0, [[gate], [delay]], [[1920, 1]]);
    expect(problems.tracks[0]).toEqual([[], []]);
    vi.clearAllMocks();
    const louder = { ...delay, mix: 0.9 };
    await engine.configure(extras({ sounds: [{ ...twoSounds, chains: [[gate], [louder]] }] }));
    expect(mocked.setEngineChain.mock.calls).toEqual([[0, [louder], 1]]);
    expect(mocked.setEngineSounds).not.toHaveBeenCalled();
    vi.clearAllMocks();
    // Automation, EQ, drums, master pan and the audio track go when they change.
    const automation = { enabled: true, volume: [[0, 1]] as [number, number][], pan: [], mute: [] };
    const eq = { lowDb: 3, midDb: 0, midHz: 1000, highDb: 0 };
    const drums = {
      stereo: false,
      elements: [],
      other: { volume: 1, pan: 0, mute: false, solo: false },
    };
    const backing = {
      params: {
        enabled: true,
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        eq,
        semitones: 0,
        cents: 0,
        filter: "off" as const,
      },
      sync: [{ tick: 0, ms: 500 }],
    };
    await engine.configure(
      extras({
        sounds: [{ ...twoSounds, chains: [[gate], [louder]] }],
        automation: [automation],
        eq: [eq],
        drums: [drums],
        masterPan: -0.5,
        backing,
      }),
    );
    expect(mocked.setEngineAutomation).toHaveBeenCalledWith(0, automation);
    expect(mocked.setEngineTrackEq).toHaveBeenCalledWith(0, eq);
    expect(mocked.setEngineDrumMix).toHaveBeenCalledWith(0, drums);
    expect(mocked.engineTransport).toHaveBeenCalledWith({ type: "masterPan", value: -0.5 });
    expect(mocked.setEngineBacking).toHaveBeenCalledWith(backing.params, backing.sync);
    expect(mocked.setEngineChain).not.toHaveBeenCalled();
    // Loading a recording resends its settings (the engine starts it with defaults).
    vi.clearAllMocks();
    const info = await engine.loadBacking({ type: "file", path: "/a.wav" });
    expect(info.name).toBe("a.wav");
    expect(mocked.setEngineBacking).toHaveBeenCalledTimes(1);
    await engine.clearBacking();
    expect(mocked.clearEngineBacking).toHaveBeenCalled();
  });

  it("reports failures without throwing", async () => {
    const onError = vi.fn();
    mocked.engineTransport.mockRejectedValueOnce({ kind: "audio", message: "No output device" });
    const engine = new NativeEngine({ onError });
    engine.pause();
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0]![0].message).toBe("No output device");
  });
});
