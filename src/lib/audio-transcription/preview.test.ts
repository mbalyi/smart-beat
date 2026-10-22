import { decodeOriginal, NotePreview } from "./preview";
it("schedules timed notes with velocity and stops the audio context", async () => {
  const close = vi.fn().mockResolvedValue(undefined);
  const frequency = { value: 0 };
  const start = vi.fn();
  const stop = vi.fn();
  const setValueAtTime = vi.fn();
  vi.stubGlobal(
    "AudioContext",
    class {
      currentTime = 0;
      destination = {};
      close = close;
      resume = () => Promise.resolve();
      createOscillator() {
        return {
          type: "",
          frequency,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start,
          stop,
          onended: null,
        };
      }
      createStereoPanner() {
        return { connect: vi.fn(), pan: { value: 0 } };
      }
      createGain() {
        return {
          connect: vi.fn(),
          disconnect: vi.fn(),
          gain: {
            value: 1,
            setValueAtTime,
            linearRampToValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
        };
      }
    },
  );
  const player = new NotePreview();
  await player.play([{ pitch: 69, start: 0, end: 1, velocity: 100 }], 1, vi.fn());
  expect(frequency.value).toBe(440);
  expect(start).toHaveBeenCalledWith(0.05);
  expect(stop).toHaveBeenCalledWith(1.07);
  player.stop();
  expect(close).toHaveBeenCalledOnce();
});

it("crossfades the original and the MIDI, pans them in stereo and reports the position", async () => {
  const gains: { gain: { value: number } }[] = [];
  const pans: { pan: { value: number } }[] = [];
  const source = { buffer: null as unknown, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
  const context = {
    currentTime: 0,
    destination: {},
    close: vi.fn().mockResolvedValue(undefined),
    resume: () => Promise.resolve(),
    createOscillator: () => ({
      type: "",
      frequency: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    }),
    createGain() {
      const node = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        gain: {
          value: 1,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
      };
      gains.push(node);
      return node;
    },
    createStereoPanner() {
      const node = { connect: vi.fn(), pan: { value: 0 } };
      pans.push(node);
      return node;
    },
    createBufferSource: () => source,
  };
  vi.stubGlobal("AudioContext", function () {
    return context;
  });
  const player = new NotePreview();
  const buffer = {} as AudioBuffer;
  await player.play([], 10, vi.fn(), { original: buffer, mix: 0, from: 2 });
  // gains[0] is the MIDI bus, gains[1] the original's.
  expect(gains[1]!.gain.value).toBeCloseTo(1);
  expect(gains[0]!.gain.value).toBeCloseTo(0);
  expect(source.buffer).toBe(buffer);
  expect(source.start).toHaveBeenCalledWith(0.05, 2);
  player.setMix(1);
  expect(gains[1]!.gain.value).toBeCloseTo(0);
  expect(gains[0]!.gain.value).toBeCloseTo(1);
  player.setMix(0.5);
  expect(gains[0]!.gain.value).toBeCloseTo(Math.SQRT1_2);
  player.setStereo(true);
  expect(pans[0]!.pan.value).toBe(1);
  expect(pans[1]!.pan.value).toBe(-1);
  context.currentTime = 1.05;
  expect(player.position()).toBeCloseTo(3);
  player.stop();
  expect(source.stop).toHaveBeenCalled();
});

it("decodes a recording, or answers null when it cannot", async () => {
  const decoded = {} as AudioBuffer;
  const close = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("AudioContext", function () {
    return { decodeAudioData: () => Promise.resolve(decoded), close };
  });
  const file = { arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) } as File;
  expect(await decodeOriginal(file)).toBe(decoded);
  vi.stubGlobal("AudioContext", function () {
    return { decodeAudioData: () => Promise.reject(new Error("bad")), close };
  });
  expect(await decodeOriginal(file)).toBeNull();
});
