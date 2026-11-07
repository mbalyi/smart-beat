import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeContext {
  static instances: FakeContext[] = [];
  state = "suspended";
  currentTime = 0;
  sampleRate = 48_000;
  destination = {};
  resume = vi.fn(async () => {
    this.state = "running";
  });
  started: number[] = [];
  constructor() {
    FakeContext.instances.push(this);
  }
  createBuffer = vi.fn(() => ({}));
  createGain = vi.fn(() => ({ gain: { value: 1 }, connect: (node: unknown) => node }));
  createBufferSource = vi.fn(() => {
    const started = this.started;
    const source = {
      buffer: null as unknown,
      connect: (node: unknown) => node,
      start: (at = 0) => void started.push(at),
      stop: vi.fn(),
    };
    return source;
  });
}

beforeEach(() => {
  vi.resetModules();
  FakeContext.instances = [];
  vi.stubGlobal("AudioContext", FakeContext);
  vi.doMock("@/lib/audio/click-sounds", () => ({ clickBuffer: () => ({}) }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/audio/click-sounds");
});

describe("primeClickAudio", () => {
  it("opens and resumes the click audio ahead of the first count-in", async () => {
    const { primeClickAudio } = await import("@/lib/audio/count-in-clicks");
    await primeClickAudio();
    expect(FakeContext.instances).toHaveLength(1);
    const context = FakeContext.instances[0]!;
    expect(context.resume).toHaveBeenCalled();
    expect(context.state).toBe("running");
    // A silent blip is played, so the browser counts the context as started by this click.
    expect(context.started).toEqual([0]);
  });

  it("uses the same context for the count-in afterwards", async () => {
    const { primeClickAudio, playCountInClicks } = await import("@/lib/audio/count-in-clicks");
    await primeClickAudio();
    expect(playCountInClicks(4, 0.5, 1)).not.toBeNull();
    expect(FakeContext.instances).toHaveLength(1);
  });

  it("does not throw where there is no Web Audio", async () => {
    vi.stubGlobal("AudioContext", undefined);
    const { primeClickAudio } = await import("@/lib/audio/count-in-clicks");
    await expect(primeClickAudio()).resolves.toBeUndefined();
  });
});
