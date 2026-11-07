/**
 * Practice together: turns the session's scheduled commands into playback on this computer.
 *
 * Starting: the command is prepared (position, speed, loop, metronome, count-in), the other app
 * is told it is ready, and the start is made at the agreed instant. The instant is moved earlier
 * by this computer's output latency, so the sound is heard at the same moment on both.
 *
 * Once playing, nothing is corrected. Both computers run the same score at the same speed from
 * the same instant, and a speed or position change in the middle of a song is what people hear as
 * the two drifting apart (a measurement of the position is only as exact as the synthesizer's
 * reports, which come in chunks). The guest still compares its position with the host's reports,
 * but only to show the drift; the next Play starts both again from the same instant.
 */
import type { Command } from "@/lib/practice-together/protocol";
import type { SessionHooks } from "@/lib/practice-together/session";

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
  /** How long after a start the sound is heard, in milliseconds. */
  outputLatencyMs(): number;
  /** Whether the song is loaded, so a start plays. */
  isReady(): boolean;
}

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
  private speed = 100;
  private readings: number[] = [];
  private drift = 0;
  /** How late each start was made, in milliseconds (negative: early). For measuring. */
  readonly startErrors: number[] = [];

  constructor(options: SharedTransportOptions) {
    this.options = options;
    this.now = options.now ?? (() => performance.now());
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
    // A start with nothing loaded would do nothing here: say so, instead of starting alone.
    if (cmd.action === "play" && !player.isReady()) return false;
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
  }

  /** The host's report: compare with this player's position, to show how far apart they are. */
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
  }

  /** The session ended. */
  release() {
    this.resetDrift();
  }
}
