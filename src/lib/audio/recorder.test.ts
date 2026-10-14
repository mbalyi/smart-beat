import { MAX_TAKE_SECONDS, startRecorder } from "@/lib/audio/recorder";
import { installMediaDevices } from "@/test/media-devices";

const RATE = 48_000;

interface FakeNode {
  port: {
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage: (m: unknown) => void;
  };
  disconnect: ReturnType<typeof vi.fn>;
  options: unknown;
}

/** An audio context whose worklet the test drives by hand. */
function installAudio({ stamp = { contextTime: 5, performanceTime: 10_000 } } = {}) {
  const nodes: FakeNode[] = [];
  const contexts: { close: ReturnType<typeof vi.fn>; addModule: ReturnType<typeof vi.fn> }[] = [];
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  class FakeAudioContext {
    sampleRate = RATE;
    audioWorklet = { addModule: vi.fn(async () => {}) };
    close = vi.fn(async () => {});
    resume = vi.fn(async () => {});
    createMediaStreamSource() {
      return source;
    }
    getOutputTimestamp() {
      return stamp;
    }
    constructor() {
      contexts.push({ close: this.close, addModule: this.audioWorklet.addModule });
    }
  }
  class FakeWorkletNode implements FakeNode {
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      // Like the real processor: a flush answers with what it still holds, then "flushed".
      postMessage: (message: unknown) => {
        if (message === "flush")
          queueMicrotask(() => this.port.onmessage?.({ data: { type: "flushed" } }));
      },
    };
    disconnect = vi.fn();
    options: unknown;
    constructor(_context: unknown, _name: string, options: unknown) {
      this.options = options;
      nodes.push(this);
    }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  const send = (samples: Float32Array, peak = 0.5, time = 5.5) =>
    nodes[0]!.port.onmessage?.({ data: { type: "samples", samples, peak, time } });
  return { nodes, contexts, source, send };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startRecorder", () => {
  it("opens the chosen input and loads the worklet from public/", async () => {
    const devices = installMediaDevices({ inputs: [{ deviceId: "a", label: "Scarlett" }] });
    const audio = installAudio();
    await startRecorder({ deviceId: "a", label: "Scarlett" });
    expect(devices.getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        deviceId: { exact: "a" },
      }),
    });
    expect(audio.contexts[0]!.addModule).toHaveBeenCalledWith(
      expect.stringMatching(/recorder-worklet\.js$/),
    );
    expect(audio.source.connect).toHaveBeenCalledWith(audio.nodes[0]);
  });

  it("returns the samples in order, at the context rate", async () => {
    installMediaDevices({ inputs: [{ deviceId: "a", label: "Scarlett" }] });
    const audio = installAudio();
    const recorder = await startRecorder(null);
    audio.send(new Float32Array([0.1, 0.2]));
    audio.send(new Float32Array([0.3]));
    const take = await recorder.stop();
    expect(Array.from(take.samples)).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(0.2),
      expect.closeTo(0.3),
    ]);
    expect(take.sampleRate).toBe(RATE);
    expect(take.capped).toBe(false);
  });

  it("reports when the first sample was taken on the performance clock", async () => {
    installMediaDevices({ inputs: [{ deviceId: "a", label: "Scarlett" }] });
    const audio = installAudio({ stamp: { contextTime: 5, performanceTime: 10_000 } });
    const recorder = await startRecorder(null);
    // The first block began half a second after the stamp's moment.
    audio.send(new Float32Array(4), 0.5, 5.5);
    audio.send(new Float32Array(4), 0.5, 5.6);
    const take = await recorder.stop();
    expect(take.startedAt).toBeCloseTo(10_500, 3);
  });

  it("reports the input's own latency", async () => {
    installMediaDevices({ inputs: [{ deviceId: "a", label: "Scarlett" }] });
    const audio = installAudio();
    const devices = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
    const track = { label: "x", stop: vi.fn(), getSettings: () => ({ latency: 0.012 }) };
    devices.mockResolvedValueOnce({
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream);
    const recorder = await startRecorder(null);
    audio.send(new Float32Array(4));
    expect((await recorder.stop()).inputLatency).toBe(0.012);
  });

  it("passes the level of every block on", async () => {
    installMediaDevices({ inputs: [{ deviceId: "a", label: "Scarlett" }] });
    const audio = installAudio();
    const onLevel = vi.fn();
    await startRecorder(null, { onLevel });
    audio.send(new Float32Array(4), 0.25);
    audio.send(new Float32Array(4), 0.75);
    expect(onLevel.mock.calls).toEqual([[0.25], [0.75]]);
  });

  it("counts the seconds recorded", async () => {
    installMediaDevices({ inputs: [{ deviceId: "a", label: "Scarlett" }] });
    const audio = installAudio();
    const recorder = await startRecorder(null);
    expect(recorder.elapsed()).toBe(0);
    audio.send(new Float32Array(RATE / 2));
    expect(recorder.elapsed()).toBeCloseTo(0.5);
  });

  it("stops itself at the limit, and keeps no more than the limit", async () => {
    installMediaDevices({ inputs: [{ deviceId: "a", label: "Scarlett" }] });
    const audio = installAudio();
    const onLimit = vi.fn();
    const recorder = await startRecorder(null, { onLimit });
    const minute = new Float32Array(60 * RATE);
    for (let i = 0; i < 9; i++) audio.send(minute);
    expect(onLimit).not.toHaveBeenCalled();
    audio.send(new Float32Array(61 * RATE));
    expect(onLimit).toHaveBeenCalledTimes(1);
    audio.send(new Float32Array(RATE));
    expect(onLimit).toHaveBeenCalledTimes(1);
    const take = await recorder.stop();
    expect(take.samples.length).toBe(MAX_TAKE_SECONDS * RATE);
    expect(take.capped).toBe(true);
  });

  it("lets go of the input and the context when the take ends", async () => {
    const devices = installMediaDevices({ inputs: [{ deviceId: "a", label: "Scarlett" }] });
    const audio = installAudio();
    const recorder = await startRecorder(null);
    audio.send(new Float32Array(4));
    await recorder.stop();
    expect(devices.stop).toHaveBeenCalled();
    expect(audio.contexts[0]!.close).toHaveBeenCalled();
    expect(audio.nodes[0]!.disconnect).toHaveBeenCalled();
    await expect(recorder.stop()).rejects.toThrow("The recording has ended.");
  });

  it("lets go of everything when the take is thrown away", async () => {
    const devices = installMediaDevices({ inputs: [{ deviceId: "a", label: "Scarlett" }] });
    const audio = installAudio();
    const recorder = await startRecorder(null);
    recorder.cancel();
    recorder.cancel();
    expect(devices.stop).toHaveBeenCalled();
    expect(audio.contexts[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("lets go of the input when the worklet can't be loaded", async () => {
    const devices = installMediaDevices({ inputs: [{ deviceId: "a", label: "Scarlett" }] });
    const audio = installAudio();
    vi.stubGlobal(
      "AudioContext",
      class extends (globalThis.AudioContext as unknown as new () => object) {
        constructor() {
          super();
          (this as unknown as { audioWorklet: unknown }).audioWorklet = {
            addModule: async () => {
              throw new Error("no worklet");
            },
          };
        }
      },
    );
    await expect(startRecorder(null)).rejects.toThrow("no worklet");
    expect(devices.stop).toHaveBeenCalled();
    expect(audio.nodes).toHaveLength(0);
  });

  it("fails like the input does when the microphone is not allowed", async () => {
    installMediaDevices({ denied: true });
    installAudio();
    await expect(startRecorder(null)).rejects.toMatchObject({ name: "NotAllowedError" });
  });
});
