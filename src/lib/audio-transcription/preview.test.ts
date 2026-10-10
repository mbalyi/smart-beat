import { NotePreview } from "./preview";
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
      createGain() {
        return {
          connect: vi.fn(),
          disconnect: vi.fn(),
          gain: {
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
