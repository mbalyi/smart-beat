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

describe("clickStartTime (#258)", () => {
  it("uses the output's timestamp: the moment of the timeline that is heard when", async () => {
    const { clickStartTime } = await import("@/lib/audio/count-in-clicks");
    const ctx = {
      currentTime: 10,
      outputLatency: 0.5,
      // Timeline second 9.96 is heard at page time 5 000 ms.
      getOutputTimestamp: () => ({ contextTime: 9.96, performanceTime: 5_000 }),
    };
    expect(clickStartTime(ctx, 5_100, 5_010)).toBeCloseTo(10.06, 6);
  });

  it("takes the output latency off when there is no timestamp", async () => {
    const { clickStartTime } = await import("@/lib/audio/count-in-clicks");
    const ctx = { currentTime: 10, outputLatency: 0.03, baseLatency: 0.01 };
    // Heard 100 ms from now: started 40 ms earlier than that.
    expect(clickStartTime(ctx, 1_100, 1_000)).toBeCloseTo(10.06, 6);
  });

  it("never schedules in the past: a click that is late sounds at once", async () => {
    const { clickStartTime } = await import("@/lib/audio/count-in-clicks");
    expect(clickStartTime({ currentTime: 10, outputLatency: 0.05 }, 990, 1_000)).toBe(10);
    const stamped = {
      currentTime: 10,
      getOutputTimestamp: () => ({ contextTime: 9.9, performanceTime: 5_000 }),
    };
    expect(clickStartTime(stamped, 4_000, 5_000)).toBe(10);
  });

  it("ignores an empty timestamp (the output has not started)", async () => {
    const { clickStartTime } = await import("@/lib/audio/count-in-clicks");
    const ctx = {
      currentTime: 2,
      getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }),
    };
    expect(clickStartTime(ctx, 1_050, 1_000)).toBeCloseTo(2.05, 6);
  });

  it("plays a click at the time it is to be heard", async () => {
    const { playClick } = await import("@/lib/audio/count-in-clicks");
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    playClick("cowbell", true, 1);
    const ctx = FakeContext.instances[0]!;
    ctx.currentTime = 3;
    playClick("cowbell", false, 1, 1_200);
    expect(ctx.started[0]).toBe(0);
    expect(ctx.started[1]).toBeCloseTo(3.2, 6);
    vi.restoreAllMocks();
  });
});

describe("SongTimeline (#258)", () => {
  it("places the song on the page's clock by its earliest-arriving recent report", async () => {
    const { SongTimeline } = await import("@/lib/audio/count-in-clicks");
    const line = new SongTimeline();
    expect(line.pageTimeOf(0)).toBeNull();
    line.note(2_000, 1_000, 1);
    line.note(2_100, 1_130, 1); // arrived 30 ms late
    expect(line.pageTimeOf(2_200)).toBe(1_200);
  });

  it("starts over after a jump, a new speed or a stop", async () => {
    const { SongTimeline } = await import("@/lib/audio/count-in-clicks");
    const line = new SongTimeline();
    line.note(2_000, 1_000, 1);
    line.note(0, 1_100, 1); // the loop restarted
    expect(line.pageTimeOf(0)).toBe(1_100);
    line.note(100, 1_200, 0.5); // a new speed
    expect(line.pageTimeOf(200)).toBe(1_400);
    line.reset();
    expect(line.pageTimeOf(0)).toBeNull();
  });

  it("forgets reports older than a couple of seconds", async () => {
    const { SongTimeline } = await import("@/lib/audio/count-in-clicks");
    const line = new SongTimeline();
    line.note(0, 0, 1); // the earliest-arriving one, long ago
    for (let t = 100; t <= 5_000; t += 100) line.note(t, t + 20, 1);
    expect(line.pageTimeOf(5_000)).toBe(5_020);
  });
});
