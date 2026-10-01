import { midi, type synth } from "@coderline/alphatab";

import { defaultEffect } from "@/lib/audio/effects";
import { busMixes, NativeEngine, POLL_MS, songFromMidi } from "@/lib/audio/native-engine";
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
  it("keeps volume, mute and solo and leaves pan to the MIDI", () => {
    expect(busMixes({ tracks: [{ volume: 0.5, mute: true, solo: false }] })).toEqual([
      { volume: 0.5, pan: 0, mute: true, solo: false },
    ]);
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

  it("sends its chains again with every song", async () => {
    const engine = new NativeEngine();
    const gate = defaultEffect("gate");
    await engine.setAllChains([[gate], []], [gate]);
    mocked.setEngineChain.mockClear();
    await engine.loadSong(file(), [[1], [9]]);
    expect(mocked.setEngineChain.mock.calls).toEqual([
      [0, [gate]],
      [1, []],
      [null, [gate]],
    ]);
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
