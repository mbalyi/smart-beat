import { DRIFT_LIMIT_MS, LaneFollower, type FollowerEngine } from "@/lib/audio/lane-follower";
import type { EngineClock } from "@/lib/audio/native-engine";

/** An engine that records what it is told, and a clock the test moves. */
function setup({ synthLatency = 60, engineLatency = 20, clock = true } = {}) {
  let time = 1_000;
  const calls: string[] = [];
  const reading = (): EngineClock => ({
    // The engine started at page time 0 and renders 48 000 frames a second.
    frames: (time / 1000) * 48_000,
    sampleRate: 48_000,
    latencyMs: engineLatency,
    at: time,
    rtt: 2,
  });
  const engine: FollowerEngine = {
    seekTo: (ms) => calls.push(`seek ${Math.round(ms)}`),
    play: () => calls.push("play"),
    playAt: (frame) => calls.push(`playAt ${Math.round(frame)}`),
    pause: () => calls.push("pause"),
    set playbackRate(value: number) {
      calls.push(`rate ${value}`);
    },
    get playbackRate() {
      return 1;
    },
    clock: async () => (clock ? reading() : null),
  };
  const follower = new LaneFollower(engine, {
    synthLatencyMs: () => synthLatency,
    now: () => time,
    refreshMs: 0,
  });
  return {
    follower,
    calls,
    advance: (ms: number) => {
      time += ms;
    },
    clearCalls: () => calls.splice(0),
  };
}

describe("LaneFollower", () => {
  it("starts at once and calibrates when it has not read the engine's clock yet", async () => {
    const { follower, calls } = setup();
    follower.start(1_500, 1);
    expect(calls.slice(0, 3)).toEqual(["rate 1", "seek 1500", "play"]);
    await vi.waitFor(() => expect(follower.isPlaying).toBe(true));
  });

  it("starts on the frame where the notes are heard: later by the difference of the latencies", async () => {
    const { follower, calls, clearCalls } = setup({ synthLatency: 60, engineLatency: 20 });
    await follower.calibrate();
    clearCalls();
    follower.start(2_000, 1);
    // Now is 1000 ms; the notes are heard at 1060 ms, the lanes render 20 ms ahead of being
    // heard, so they begin at 1040 ms: frame 1.04 s * 48 000.
    expect(calls.slice(0, 3)).toEqual([
      "rate 1",
      "seek 2000",
      `playAt ${Math.round(1.04 * 48_000)}`,
    ]);
  });

  it("begins a little way into the song when the engine's sound arrives later than the notes", async () => {
    const { follower, calls, clearCalls } = setup({ synthLatency: 10, engineLatency: 50 });
    await follower.calibrate();
    clearCalls();
    follower.start(2_000, 0.5);
    // 40 ms late: at half speed that is 20 ms of the song.
    expect(calls.slice(0, 3)).toEqual(["rate 0.5", "seek 2020", "play"]);
  });

  it("pauses, seeks and changes the speed", () => {
    const { follower, calls, clearCalls } = setup();
    follower.start(0, 1);
    clearCalls();
    follower.setSpeed(0.75);
    follower.seek(4_000);
    follower.pause();
    expect(calls).toEqual(["rate 0.75", "seek 4000", "pause"]);
    expect(follower.isPlaying).toBe(false);
  });

  describe("the engine's clock", () => {
    /** An engine whose clock the test can restart, speed up or make slow to answer. */
    function drifting() {
      let time = 1_000;
      let offsetFrames = 0;
      let rate = 48_000;
      let rtt = 2;
      let latency = 20;
      let reads = 0;
      const calls: string[] = [];
      const engine: FollowerEngine = {
        seekTo: (ms) => calls.push(`seek ${Math.round(ms)}`),
        play: () => calls.push("play"),
        playAt: (frame) => calls.push(`playAt ${Math.round(frame)}`),
        pause: () => calls.push("pause"),
        set playbackRate(_value: number) {},
        get playbackRate() {
          return 1;
        },
        clock: async () => {
          reads += 1;
          return {
            frames: (time / 1000) * rate + offsetFrames,
            sampleRate: rate,
            latencyMs: latency,
            at: time,
            rtt,
          };
        },
      };
      const follower = new LaneFollower(engine, {
        synthLatencyMs: () => 60,
        now: () => time,
        refreshMs: 0,
      });
      return {
        follower,
        calls,
        reads: () => reads,
        advance: (ms: number) => (time += ms),
        // The engine restarted: its frame counter begins again.
        restart: () => (offsetFrames = -(time / 1000) * rate),
        setRate: (value: number) => (rate = value),
        setRtt: (value: number) => (rtt = value),
        setLatency: (value: number) => (latency = value),
      };
    }

    it("does not aim a start with a reading that is old: it starts at once and reads again", async () => {
      const t = drifting();
      await t.follower.calibrate();
      // The user paused for a minute: the reading is too old to aim with.
      t.advance(60_000);
      t.calls.length = 0;
      const reads = t.reads();
      t.follower.start(2_000, 1);
      expect(t.calls.filter((c) => c.startsWith("playAt"))).toEqual([]);
      expect(t.calls).toContain("play");
      await vi.waitFor(() => expect(t.reads()).toBeGreaterThan(reads));
    });

    it("aims with a fresh reading again after it has read the clock", async () => {
      const t = drifting();
      await t.follower.calibrate();
      t.advance(60_000);
      t.follower.start(0, 1);
      // The start's own reading (two reads) has landed.
      await vi.waitFor(() => expect(t.reads()).toBeGreaterThanOrEqual(5));
      await new Promise((resolve) => setTimeout(resolve, 0));
      t.follower.pause();
      t.calls.length = 0;
      t.follower.start(0, 1);
      expect(t.calls.some((c) => c.startsWith("playAt"))).toBe(true);
    });

    it("forgets the reading when the engine restarted (its frame counter went back) and reads again", async () => {
      const t = drifting();
      await t.follower.calibrate();
      const before = t.reads();
      t.advance(1_000);
      t.restart();
      // The engine's status shows a clock far from the one the reading predicts.
      t.follower.onStatus({
        positionMs: 0,
        playing: false,
        clockFrames: 100,
        sampleRate: 48_000,
      });
      await vi.waitFor(() => expect(t.reads()).toBeGreaterThanOrEqual(before + 2));
      await new Promise((resolve) => setTimeout(resolve, 0));
      t.calls.length = 0;
      t.follower.start(0, 1);
      // A start aims at the restarted counter (about a second of frames), not 50 000 frames ahead.
      const frame = Number(t.calls.find((c) => c.startsWith("playAt"))?.split(" ")[1]);
      expect(frame).toBeGreaterThan(0);
      expect(frame).toBeLessThan(3_000);
    });

    it("forgets the reading when the output's sample rate changed", async () => {
      const t = drifting();
      await t.follower.calibrate();
      const before = t.reads();
      t.setRate(44_100);
      t.follower.onStatus({
        positionMs: 0,
        playing: false,
        clockFrames: (1_000 / 1000) * 44_100,
        sampleRate: 44_100,
      });
      await vi.waitFor(() => expect(t.reads()).toBeGreaterThan(before));
    });

    it("keeps the reading while the engine's clock does what it predicts", async () => {
      const t = drifting();
      await t.follower.calibrate();
      const before = t.reads();
      t.advance(500);
      t.follower.onStatus({
        positionMs: 0,
        playing: false,
        clockFrames: (1_500 / 1000) * 48_000 + 480, // 10 ms off: a late poll
        sampleRate: 48_000,
      });
      await Promise.resolve();
      expect(t.reads()).toBe(before);
    });

    it("a better reading replaces an old one, a worse one does not replace a fresh one", async () => {
      const t = drifting();
      t.setRtt(2);
      await t.follower.calibrate(1);
      t.advance(100);
      t.setRtt(40);
      t.setLatency(35);
      await t.follower.calibrate(1);
      // Fresh and better: kept (the latency of the first reading is still what a start uses).
      t.calls.length = 0;
      t.follower.start(0, 1);
      expect(t.calls.some((c) => c.startsWith("playAt"))).toBe(true);
      // 60 - 20 = 40 ms later than now (1 100 ms): frame 1.14 s * 48 000.
      expect(t.calls.find((c) => c.startsWith("playAt"))).toBe(
        `playAt ${Math.round(1.14 * 48_000)}`,
      );
    });

    it("reads the clock now and then by itself, so a start after a pause is still aimed", async () => {
      vi.useFakeTimers();
      try {
        let time = 1_000;
        let reads = 0;
        const engine: FollowerEngine = {
          seekTo: () => {},
          play: () => {},
          playAt: () => {},
          pause: () => {},
          playbackRate: 1,
          clock: async () => {
            reads += 1;
            return { frames: time * 48, sampleRate: 48_000, latencyMs: 20, at: time, rtt: 2 };
          },
        };
        const follower = new LaneFollower(engine, {
          synthLatencyMs: () => 60,
          now: () => time,
          refreshMs: 1_000,
        });
        await follower.calibrate(1);
        const before = reads;
        time += 1_000;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(reads).toBeGreaterThan(before);
        follower.dispose();
        const after = reads;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(reads).toBe(after);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("while playing", () => {
    async function playing() {
      const s = setup({ synthLatency: 60, engineLatency: 20 });
      await s.follower.calibrate();
      s.follower.start(0, 1);
      s.advance(1_000); // past the settling time
      s.clearCalls();
      return s;
    }

    it("leaves the lanes alone while the two agree", async () => {
      const { follower, advance, calls } = await playing();
      // Synth rendered 1 000 ms, heard 940; the engine says 945 is heard: 5 ms apart.
      follower.onStatus({ positionMs: 945, playing: true });
      follower.follow(1_000);
      advance(500);
      follower.onStatus({ positionMs: 1_445, playing: true });
      follower.follow(1_500);
      expect(calls).toEqual([]);
    });

    it("moves the lanes when they are further apart than the limit", async () => {
      const { follower, calls } = await playing();
      // The notes jumped back to 200 ms (a loop restarted); the lanes still run at 1 000.
      follower.onStatus({ positionMs: 1_000, playing: true });
      follower.follow(200);
      // Heard from the notes: 200 - 60 = 140 ms; the engine renders 20 ms ahead of that.
      expect(calls).toEqual(["seek 160"]);
    });

    it("corrects at most every 400 ms, and leaves the lanes alone just after a start", async () => {
      const { follower, calls, advance } = await playing();
      follower.onStatus({ positionMs: 1_000, playing: true });
      follower.follow(200);
      follower.follow(210);
      expect(calls).toHaveLength(1);
      advance(450);
      follower.onStatus({ positionMs: 1_000, playing: true });
      follower.follow(2_000);
      expect(calls).toHaveLength(2);
      // A fresh start: nothing is corrected while it settles.
      follower.start(0, 1);
      const afterStart = calls.length;
      follower.onStatus({ positionMs: 5_000, playing: true });
      follower.follow(0);
      expect(calls).toHaveLength(afterStart);
    });

    it("does nothing when paused or before the engine has reported", async () => {
      const { follower, calls } = await playing();
      follower.follow(9_000);
      expect(calls).toEqual([]);
      follower.onStatus({ positionMs: 0, playing: true });
      follower.pause();
      follower.follow(9_000);
      expect(calls).toEqual(["pause"]);
    });

    it("stays within the limit it advertises", () => {
      expect(DRIFT_LIMIT_MS).toBeGreaterThanOrEqual(60);
    });
  });
});
