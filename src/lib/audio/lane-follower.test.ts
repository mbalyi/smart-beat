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
