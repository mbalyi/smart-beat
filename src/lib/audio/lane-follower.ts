import type { EngineClock } from "@/lib/audio/native-engine";
import type { EngineStatus } from "@/lib/tauri";

/** What the follower needs of the engine that plays the audio lanes (the native engine). */
export interface FollowerEngine {
  seekTo(ms: number): void;
  play(): void;
  /** Starts when the engine's clock reaches `frame`. */
  playAt(frame: number): void;
  pause(): void;
  playbackRate: number;
  clock(): Promise<EngineClock | null>;
}

export interface LaneFollowerOptions {
  /** How long after the notes player renders something it is heard (ms). */
  synthLatencyMs: () => number;
  /** The time in ms, from a clock that agrees with `EngineClock.at` (default: `performance.now`). */
  now?: () => number;
  /**
   * How often the engine's clock is read again, so a reading is never old when a start needs it
   * (ms; default {@link REFRESH_MS}, 0: never, for tests).
   */
  refreshMs?: number;
}

/** The notes and the lanes may differ this much (ms) before the lanes are moved. */
export const DRIFT_LIMIT_MS = 120;
/** After a start or a correction the lanes are left alone for this long (ms). */
const SETTLE_MS = 600;
/** Corrections are at least this far apart (ms). */
const FIX_EVERY_MS = 400;
/** The engine's clock is read again this often (ms). */
export const REFRESH_MS = 2_000;
/** A reading older than this is not used to aim a start (the clocks drift, an engine restarts). */
const MAX_AGE_MS = 5_000;
/** A status whose clock is this far (ms) from what the reading predicts: the engine restarted. */
const CLOCK_JUMP_MS = 300;

/**
 * Keeps the audio lanes in time with notes that another player plays (alphaTab's SoundFonts
 * synthesizer): the notes player says when it starts, pauses, seeks, changes speed or loops, and
 * where it is; the lanes are played by the native engine, which only has the song's tempo map and
 * the lanes (no tracks, ADR 0003).
 *
 * A start is on an exact frame of the engine's clock: the lanes begin when the notes are heard,
 * the two output latencies taken into account. While playing, the follower compares what is heard
 * from both and moves the lanes when they differ by more than {@link DRIFT_LIMIT_MS} (a seek
 * during playback, a loop that restarted, a tempo change).
 */
export class LaneFollower {
  private readonly now: () => number;
  private speed = 1;
  private playing = false;
  private calibration: EngineClock | null = null;
  private calibrating = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private settledAt = 0;
  private fixedAt = -Infinity;
  /** The engine's last report: the song position that is heard, and when it was read. */
  private heard: { ms: number; at: number; playing: boolean } | null = null;

  private readonly engine: FollowerEngine;
  private readonly options: LaneFollowerOptions;

  constructor(engine: FollowerEngine, options: LaneFollowerOptions) {
    this.engine = engine;
    this.options = options;
    this.now = options.now ?? (() => performance.now());
  }

  /** Stops reading the clock by itself. */
  dispose(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /**
   * Reads the engine's clock; of this batch the reading with the shortest round trip is used (the
   * engine's clock and the page's agree to within about half of it). It replaces the earlier
   * reading when it is at least as good, or when that one is getting old: the two clocks drift
   * apart, and an engine that started again counts from zero. Call it before a start; it also
   * runs by itself every {@link REFRESH_MS}.
   */
  async calibrate(readings = 3): Promise<void> {
    if (this.calibrating) return;
    this.calibrating = true;
    try {
      let best: EngineClock | null = null;
      for (let i = 0; i < readings; i++) {
        const clock = await this.engine.clock();
        if (clock && (!best || clock.rtt <= best.rtt)) best = clock;
      }
      const old = this.calibration;
      if (
        best &&
        (!old || best.rtt <= old.rtt || this.age(old) > (this.refreshMs() || REFRESH_MS))
      ) {
        this.calibration = best;
      }
      this.startTimer();
    } finally {
      this.calibrating = false;
    }
  }

  private refreshMs(): number {
    return this.options.refreshMs ?? REFRESH_MS;
  }

  private age(clock: EngineClock): number {
    return this.now() - clock.at;
  }

  /** Reads the clock again now and then, also while nothing plays (a start comes without notice). */
  private startTimer() {
    const every = this.refreshMs();
    if (this.timer !== undefined || every <= 0) return;
    this.timer = setInterval(() => void this.calibrate(2), every);
  }

  /** The engine's frame that is current at the page's time `at`. */
  private frameAt(at: number, clock: EngineClock): number {
    return clock.frames + ((at - clock.at) / 1000) * clock.sampleRate;
  }

  /**
   * The notes start now, from `positionMs` of the song at `speed`. The lanes start when the notes
   * are heard.
   */
  start(positionMs: number, speed: number) {
    this.speed = speed;
    this.engine.playbackRate = speed;
    this.playing = true;
    this.fixedAt = -Infinity;
    const at = this.now();
    this.settledAt = at + SETTLE_MS;
    const clock = this.calibration;
    if (!clock || this.age(clock) > MAX_AGE_MS) {
      // Not calibrated yet, or the reading is too old to aim with: start at once and read the
      // clock for the next time.
      this.engine.seekTo(positionMs);
      this.engine.play();
      void this.calibrate(2);
      return;
    }
    // Both start now; each is heard after its own output latency.
    const delayMs = this.options.synthLatencyMs() - clock.latencyMs;
    if (delayMs >= 0) {
      this.engine.seekTo(positionMs);
      this.engine.playAt(this.frameAt(at + delayMs, clock));
    } else {
      // The engine's sound arrives later than the notes: begin a little way into the song.
      this.engine.seekTo(positionMs + -delayMs * speed);
      this.engine.play();
    }
    void this.calibrate(1);
  }

  pause() {
    this.playing = false;
    this.heard = null;
    this.engine.pause();
  }

  /** The notes moved to `positionMs` (a click, a bar, a restart of the loop). */
  seek(positionMs: number) {
    this.settledAt = this.now() + SETTLE_MS / 2;
    this.engine.seekTo(positionMs);
  }

  setSpeed(speed: number) {
    this.speed = speed;
    this.engine.playbackRate = speed;
  }

  /**
   * The engine reported where it is (its published position is what is heard). Its clock is
   * checked against the reading: a different sample rate, or a frame counter far from where the
   * reading puts it (the engine started again, or the output changed), makes the reading useless,
   * so it is dropped and read again.
   */
  onStatus(
    status: Pick<EngineStatus, "positionMs" | "playing"> &
      Partial<Pick<EngineStatus, "clockFrames" | "sampleRate">>,
  ) {
    const at = this.now();
    this.heard = { ms: status.positionMs, at, playing: status.playing };
    const clock = this.calibration;
    if (!clock || status.clockFrames === undefined || status.sampleRate === undefined) return;
    const offMs =
      (Math.abs(status.clockFrames - this.frameAt(at, clock)) / status.sampleRate) * 1000;
    if (status.sampleRate !== clock.sampleRate || offMs > CLOCK_JUMP_MS) {
      this.calibration = null;
      void this.calibrate(2);
    }
  }

  /**
   * The notes player says where its notes are (`synthMs`, what it has rendered). While playing,
   * the lanes are moved when what is heard differs by more than the limit.
   */
  follow(synthMs: number) {
    const at = this.now();
    const clock = this.calibration;
    const heard = this.heard;
    if (
      !this.playing ||
      !heard?.playing ||
      at < this.settledAt ||
      at - this.fixedAt < FIX_EVERY_MS
    ) {
      return;
    }
    const synthHeard = synthMs - this.options.synthLatencyMs() * this.speed;
    const lanesHeard = heard.ms + (at - heard.at) * this.speed;
    if (Math.abs(lanesHeard - synthHeard) <= DRIFT_LIMIT_MS) return;
    this.fixedAt = at;
    this.settledAt = at + SETTLE_MS / 2;
    // The engine reports what is heard: it has to render ahead of that by its latency.
    this.engine.seekTo(synthHeard + (clock?.latencyMs ?? 0) * this.speed);
  }
}
