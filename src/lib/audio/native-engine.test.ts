import { midi, type synth } from "@coderline/alphatab";

import { defaultEffect } from "@/lib/audio/effects";
import {
  busMixes,
  forgetEngineOwner,
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
        faults: 0,
        loops: 0,
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
    setEngineMonitor: vi.fn(() => Promise.resolve(null)),
    setEngineMonitorChain: vi.fn(() => Promise.resolve([])),
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
  beforeEach(() => {
    vi.clearAllMocks();
    forgetEngineOwner();
  });
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

  it("puts a song back into the engine when another song used it (two tabs)", async () => {
    const first = new NativeEngine();
    const second = new NativeEngine();
    first.attach(output());
    second.attach(output());
    await first.loadSong(file(), [[1], [9]]);
    first.setMix([{ volume: 0.5, pan: 0, mute: false, solo: false, trimDb: 0 }]);
    await second.loadSong(file(), [[1]]);
    mocked.loadEngineSong.mockClear();
    mocked.engineTransport.mockClear();

    // The hidden first tab does not pause the second one's playback...
    first.pause();
    await Promise.resolve();
    expect(mocked.engineTransport).not.toHaveBeenCalled();

    // ...and when it plays again, it first gets its own song back.
    first.play();
    await vi.waitFor(() =>
      expect(mocked.engineTransport).toHaveBeenLastCalledWith({ type: "play" }),
    );
    expect(mocked.loadEngineSong).toHaveBeenCalledOnce();
    expect(mocked.loadEngineSong.mock.calls[0]![0].tracks).toEqual([[1], [9]]);
    expect(mocked.setEngineMix).toHaveBeenCalledWith([expect.objectContaining({ volume: 0.5 })]);
    first.destroy();
    second.destroy();
  });

  it("counts in inside the engine, so the song starts on the last click (Play = count-in)", async () => {
    const engine = new NativeEngine();
    engine.attach(output());
    await engine.loadSong(file(), [[1]]);
    mocked.engineTransport.mockClear();

    engine.play();
    await vi.waitFor(() => expect(mocked.engineTransport).toHaveBeenCalledOnce());
    expect(mocked.engineTransport).toHaveBeenLastCalledWith({ type: "play" });

    engine.countIn = () => ({ beats: 4, beatSeconds: 0.5 });
    engine.playbackRate = 0.5; // half speed: the beats are twice as long
    mocked.engineTransport.mockClear();
    engine.play();
    await vi.waitFor(() =>
      expect(mocked.engineTransport).toHaveBeenLastCalledWith({
        type: "countIn",
        beats: 4,
        beatSeconds: 1,
      }),
    );
    engine.destroy();
  });

  it("loads only the newest of the songs sent while typing", async () => {
    const engine = new NativeEngine();
    engine.attach(output());
    const first = engine.loadSong(file(), [[1]]);
    const second = engine.loadSong(file(), [[1], [9]]);
    const third = engine.loadSong(file(), [[1], [9], [2]]);
    await Promise.all([first, second, third]);
    expect(mocked.loadEngineSong).toHaveBeenCalledOnce();
    expect(mocked.loadEngineSong.mock.calls[0]![0].tracks).toEqual([[1], [9], [2]]);
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

  it("tells the UI when a sound crashed in the audio callback (#41)", async () => {
    vi.useFakeTimers();
    const state = vi.mocked(tauri.engineState);
    const status = (faults: number) => ({
      running: true,
      sampleRate: 48_000,
      positionMs: 0,
      durationMs: 8_000,
      playing: true,
      latencyMs: 10,
      dropouts: 0,
      faults,
      loops: 0,
      loadPercent: 1,
      meters: {
        tracks: [],
        master: 0,
        drums: [],
        reduction: { tracks: [], master: [] },
        backing: 0,
      },
    });
    state.mockResolvedValueOnce(status(0)).mockResolvedValueOnce(status(1));
    const onFault = vi.fn();
    const engine = new NativeEngine({ onFault });
    engine.attach(output());
    engine.play();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onFault).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onFault).toHaveBeenCalledTimes(1);
    engine.destroy();
  });

  it("reports the loops the engine played to the end (#83)", async () => {
    vi.useFakeTimers();
    const state = vi.mocked(tauri.engineState);
    const base = await state();
    state.mockResolvedValueOnce({ ...base, loops: 0 }).mockResolvedValueOnce({ ...base, loops: 2 });
    const onLoops = vi.fn();
    const engine = new NativeEngine({ onLoops });
    engine.attach(output());
    engine.play();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onLoops).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onLoops).toHaveBeenCalledWith(2);
    engine.destroy();
  });

  it("counts a bar in before every loop when asked (#83)", async () => {
    const engine = new NativeEngine();
    engine.attach(output());
    engine.setLoop({ startTick: 0, endTick: 3840 }, { beats: 3, beatSeconds: 0.5 });
    await vi.waitFor(() =>
      expect(mocked.engineTransport).toHaveBeenCalledWith({
        type: "loop",
        startTick: 0,
        endTick: 3840,
        countIn: { beats: 3, beatSeconds: 0.5 },
      }),
    );
    engine.setLoop(null, { beats: 3, beatSeconds: 0.5 });
    await vi.waitFor(() =>
      expect(mocked.engineTransport).toHaveBeenLastCalledWith({
        type: "loop",
        startTick: null,
        endTick: null,
        countIn: null,
      }),
    );
    engine.destroy();
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

  describe("monitor track", () => {
    const eq = { lowDb: 0, midDb: 0, midHz: 1000, highDb: 0 };
    const params = { enabled: true, volume: 0.8, pan: 0, mute: false, solo: false, eq };
    const gate = defaultEffect("gate");
    const monitor = (over: Partial<NonNullable<EngineExtras["monitor"]>> = {}) => ({
      params,
      effects: [gate],
      device: "Scarlett 2i2 USB",
      channel: 0,
      ...over,
    });
    const opened = {
      open: true,
      device: "Scarlett 2i2 USB",
      channels: 2,
      sampleRate: 48_000,
      latencyMs: 9,
      error: null,
    };

    it("sends its settings and its effects, and reports the input", async () => {
      mocked.setEngineMonitor.mockResolvedValueOnce(opened);
      const onMonitorStatus = vi.fn();
      const engine = new NativeEngine({ onMonitorStatus });
      const problems = await engine.configure(extras({ monitor: monitor() }));
      expect(mocked.setEngineMonitor).toHaveBeenCalledWith({
        params,
        device: "Scarlett 2i2 USB",
        channel: 0,
      });
      expect(mocked.setEngineMonitorChain).toHaveBeenCalledWith([gate]);
      expect(problems.monitor).toEqual([]);
      expect(onMonitorStatus).toHaveBeenCalledWith(opened);
      engine.destroy();
    });

    it("sends only what changed: a knob turn sends the chain, a fader the settings", async () => {
      const engine = new NativeEngine();
      await engine.configure(extras({ monitor: monitor() }));
      vi.clearAllMocks();
      const louder = { ...gate, enabled: false };
      await engine.configure(extras({ monitor: monitor({ effects: [louder] }) }));
      expect(mocked.setEngineMonitor).not.toHaveBeenCalled();
      expect(mocked.setEngineMonitorChain).toHaveBeenCalledWith([louder]);
      vi.clearAllMocks();
      await engine.configure(
        extras({ monitor: monitor({ effects: [louder], params: { ...params, volume: 0.5 } }) }),
      );
      expect(mocked.setEngineMonitor).toHaveBeenCalledTimes(1);
      expect(mocked.setEngineMonitorChain).not.toHaveBeenCalled();
      engine.destroy();
    });

    it("keeps the input open through song loads (every edit loads a song)", async () => {
      const engine = new NativeEngine();
      engine.prepare(extras({ monitor: monitor() }));
      await engine.loadSong(file(), [[1], [9]]);
      expect(mocked.setEngineMonitor).toHaveBeenCalledTimes(1);
      await engine.loadSong(file(), [[1], [9]]);
      expect(mocked.setEngineMonitor).toHaveBeenCalledTimes(1);
      expect(mocked.setEngineMonitorChain).toHaveBeenCalledTimes(1);
      engine.destroy();
    });

    it("sends it again when its song takes the engine back from another song", async () => {
      const first = new NativeEngine();
      first.prepare(extras({ monitor: monitor() }));
      await first.loadSong(file(), [[1], [9]]);
      const second = new NativeEngine();
      second.prepare(extras());
      await second.loadSong(file(), [[1], [9]]);
      // The other song has no monitor track: the input closes.
      expect(mocked.setEngineMonitor).toHaveBeenLastCalledWith(null);
      vi.clearAllMocks();
      first.seekTo(0);
      await vi.waitFor(() =>
        expect(mocked.setEngineMonitor).toHaveBeenCalledWith(
          expect.objectContaining({ device: "Scarlett 2i2 USB" }),
        ),
      );
      first.destroy();
      second.destroy();
    });

    it("closes the input when its song closes", async () => {
      const engine = new NativeEngine();
      engine.prepare(extras({ monitor: monitor() }));
      await engine.loadSong(file(), [[1], [9]]);
      vi.clearAllMocks();
      engine.destroy();
      expect(mocked.setEngineMonitor).toHaveBeenCalledWith(null);
    });

    it("shows the input's level while paused, and stops reading it when switched off", async () => {
      vi.useFakeTimers();
      const state = vi.mocked(tauri.engineState);
      const base = await state();
      state.mockResolvedValue({
        ...base,
        playing: false,
        meters: { tracks: [], master: 0.2, monitor: 0.4, monitorInput: 0.3 },
        monitor: opened,
      });
      const onMeters = vi.fn();
      const engine = new NativeEngine({ onMeters });
      const out = output();
      engine.attach(out);
      await engine.configure(extras({ monitor: monitor() }));
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
      expect(onMeters).toHaveBeenCalledWith(expect.objectContaining({ monitorInput: 0.3 }));
      // Paused: the cursor stays where the app put it.
      expect(out.updatePosition).not.toHaveBeenCalled();
      await engine.configure(
        extras({ monitor: monitor({ params: { ...params, enabled: false } }) }),
      );
      onMeters.mockClear();
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
      expect(onMeters).not.toHaveBeenCalled();
      state.mockReset();
      engine.destroy();
    });
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
