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
}

/** The notes and the lanes may differ this much (ms) before the lanes are moved. */
export const DRIFT_LIMIT_MS = 120;
/** After a start or a correction the lanes are left alone for this long (ms). */
const SETTLE_MS = 600;
/** Corrections are at least this far apart (ms). */
const FIX_EVERY_MS = 400;

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

  get isPlaying(): boolean {
    return this.playing;
  }

  /**
   * Reads the engine's clock; the reading with the shortest round trip is kept (the engine's clock
   * and the page's agree to within about half of it). Call it before a start, and now and then.
   */
  async calibrate(readings = 3): Promise<void> {
    for (let i = 0; i < readings; i++) {
      const clock = await this.engine.clock();
      if (clock && (!this.calibration || clock.rtt <= this.calibration.rtt)) {
        this.calibration = clock;
      }
    }
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
    if (!clock) {
      // Not calibrated yet: start at once and calibrate for the next time.
      this.engine.seekTo(positionMs);
      this.engine.play();
      void this.calibrate(1);
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

  /** The engine reported where it is (its published position is what is heard). */
  onStatus(status: Pick<EngineStatus, "positionMs" | "playing">) {
    this.heard = { ms: status.positionMs, at: this.now(), playing: status.playing };
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
