/**
 * Practice together: turns the session's scheduled commands into playback on this computer, and
 * keeps this player in step with the host's while it plays.
 *
 * Starting: the command is prepared (position, speed, loop, metronome, count-in), the other app
 * is told it is ready, and the start is made at the agreed instant. The instant is moved earlier
 * by this computer's output latency, so the sound is heard at the same moment on both.
 *
 * Following: the host reports its position every second. The guest compares it with its own
 * (a median of a few readings, because the synthesizer reports in chunks), and speeds up or slows
 * down a little instead of jumping, so the music never stutters.
 */
import type { Command } from "@/lib/practice-together/protocol";
import type { Session, SessionHooks } from "@/lib/practice-together/session";
import { PRESETS } from "@/lib/practice-together/quality-presets";

/** What the shared transport needs from the player (`ScorePlayer` has all of it). */
export interface TransportPlayer {
  isPlaying(): boolean;
  /** Plays from the current position, or pauses (the same call, like the Play button). */
  playPause(): void;
  pause(): void;
  stop(): boolean;
  seekToTick(tick: number): void;
  /** Where playback is heard, in score milliseconds; null before anything played. */
  heardTimeMs(): number | null;
  /** Multiplies the speed a little (1 = as set). */
  nudgeSpeed(multiplier: number): void;
  /** How long after a start the sound is heard, in milliseconds. */
  outputLatencyMs(): number;
}

/** Drift beyond this is large: it is corrected faster and the group is told. */
export const BIG_DRIFT_MS = 150;
/** The fastest correction of a big drift (a fraction of the speed). */
export const BIG_NUDGE = 0.05;
/** A drift is corrected over about this long. */
export const CORRECT_OVER_MS = 3000;
/** The last milliseconds before a start are waited out in a tight loop: a timer is too coarse. */
export const SPIN_MS = 12;
/** Readings the drift is the median of. */
const WINDOW = 5;

export interface SharedTransportOptions {
  player: () => TransportPlayer | null;
  /** Puts the command's speed, loop, metronome and count-in into the app's practice state. */
  applySettings(cmd: Command): void;
  /** Called with the guest's drift in milliseconds whenever it is measured. */
  onDrift?(driftMs: number): void;
  /** How long to wait for the app to apply settings before moving the position. */
  settleMs?: number;
  /** How long before a start to switch from a timer to a tight loop (tests: 0). */
  spinMs?: number;
  now?: () => number;
}

/** Runs `action` at the local time `at` (a timer, then a short spin for the last milliseconds). */
export function fireAt(
  at: number,
  now: () => number,
  action: (error: number) => void,
  spinMs = SPIN_MS,
): () => void {
  let cancelled = false;
  const spinFrom = spinMs;
  const timer = setTimeout(
    () => {
      if (cancelled) return;
      while (now() < at) {
        // The last few milliseconds: a timer is too coarse, so wait precisely.
      }
      action(now() - at);
    },
    Math.max(0, at - now() - spinFrom),
  );
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

export class SharedTransport {
  private readonly options: SharedTransportOptions;
  private readonly now: () => number;
  private session: Session | null = null;
  private speed = 100;
  private readings: number[] = [];
  private drift = 0;
  private nudge = 1;
  /** How late each start was made, in milliseconds (negative: early). For measuring. */
  readonly startErrors: number[] = [];

  constructor(options: SharedTransportOptions) {
    this.options = options;
    this.now = options.now ?? (() => performance.now());
  }

  /** Connects to the session whose commands this runs. */
  bind(session: Session) {
    this.session = session;
  }

  /** The hooks to give the {@link Session}. */
  readonly hooks: SessionHooks = {
    prepare: (cmd) => this.prepare(cmd),
    schedule: (cmd, localAt) => this.schedule(cmd, localAt),
    driftMs: () => this.drift,
    position: () => {
      const player = this.options.player();
      const pos = player?.heardTimeMs();
      return player && pos !== null && pos !== undefined
        ? { pos, playing: player.isPlaying() }
        : null;
    },
    hostState: (pos, localAt, playing) => this.follow(pos, localAt, playing),
  };

  private async prepare(cmd: Command): Promise<boolean> {
    const player = this.options.player();
    if (!player) return false;
    this.options.applySettings(cmd);
    this.speed = cmd.speed;
    // The settings reach the player through the app's state: give them a moment to land.
    await new Promise((resolve) => setTimeout(resolve, this.options.settleMs ?? 40));
    if (cmd.action === "play" || cmd.action === "seek") player.seekToTick(cmd.tick);
    return true;
  }

  private schedule(cmd: Command, localAt: number): () => void {
    const player = this.options.player();
    if (!player || cmd.action === "settings") return () => {};
    const early = cmd.action === "play" ? player.outputLatencyMs() : 0;
    return fireAt(
      localAt - early,
      this.now,
      (error) => {
        this.startErrors.push(error);
        this.resetDrift();
        switch (cmd.action) {
          case "play":
            if (!player.isPlaying()) player.playPause();
            break;
          case "pause":
            player.pause();
            break;
          case "stop":
            player.stop();
            break;
          case "seek":
            player.seekToTick(cmd.tick);
            break;
        }
      },
      this.options.spinMs,
    );
  }

  private resetDrift() {
    this.readings = [];
    this.drift = 0;
    this.setNudge(1);
  }

  private setNudge(multiplier: number) {
    if (multiplier === this.nudge) return;
    this.nudge = multiplier;
    this.options.player()?.nudgeSpeed(multiplier);
  }

  /** The host's report: compare, then correct gently. */
  private follow(pos: number, localAt: number, playing: boolean) {
    const player = this.options.player();
    if (!player) return;
    const own = player.heardTimeMs();
    if (!playing || !player.isPlaying() || own === null) {
      this.resetDrift();
      return;
    }
    // Where this player was when the host reported, then the difference: positive means ahead.
    const ownThen = own - (this.now() - localAt) * (this.speed / 100);
    this.readings.push(ownThen - pos);
    if (this.readings.length > WINDOW) this.readings.shift();
    if (this.readings.length < 3) return;
    this.drift = Math.round(median(this.readings) * 10) / 10;
    this.options.onDrift?.(this.drift);
    const preset = PRESETS[this.session?.snapshot.preset ?? "balanced"];
    const size = Math.abs(this.drift);
    if (size <= preset.driftToleranceMs) {
      this.setNudge(1);
      return;
    }
    const limit = size > BIG_DRIFT_MS ? BIG_NUDGE : preset.maxNudge;
    const correction = Math.min(limit, size / CORRECT_OVER_MS);
    // Ahead: slow down. Behind: speed up.
    this.setNudge(1 + (this.drift > 0 ? -correction : correction));
  }

  /** Back to the normal speed (the session ended). */
  release() {
    this.resetDrift();
  }
}
