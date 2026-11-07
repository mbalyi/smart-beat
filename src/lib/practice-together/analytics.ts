import type { ProblemKind, SessionState } from "@/lib/practice-together/session";
import { track } from "@/lib/telemetry";

/**
 * Anonymous usage counters for Practice together (#158, docs/analytics.md). Only fixed words are
 * ever sent: never a room code, an address, a player name, a song title or any score content. A
 * session has no identifier either, so the counts say how often something happens, not to whom.
 */

/** Where the Practice together dialog was opened from. */
export type OpenedFrom = "menu" | "toolbar" | "start";

export type Connection = "lan" | "internet";

const LENGTHS = [
  [60, "under_1m"],
  [5 * 60, "1_5m"],
  [15 * 60, "5_15m"],
  [60 * 60, "15_60m"],
] as const;

/** A session length as a range, so no exact time leaves the computer. */
export function lengthRange(seconds: number): string {
  for (const [below, name] of LENGTHS) if (seconds < below) return name;
  return "over_60m";
}

/** The problems that are counted (the others are not faults: the peer leaving ends the session). */
const COUNTED_PROBLEMS: readonly ProblemKind[] = [
  "score",
  "version",
  "declined",
  "busy",
  "dropped",
  "poor",
  "late",
  "woke",
  "tab",
];

export const opened = (from: OpenedFrom) => track("practice_together_open", from);
export const hosted = (connection: Connection) => track("practice_together_host", connection);
export const joined = (connection: Connection) => track("practice_together_join", connection);
export const setupFailed = (connection: Connection) =>
  track("practice_together_setup_failed", connection);
/** A guest came back to a session it was in. */
export const rejoined = (connection: Connection) => track("practice_together_rejoin", connection);
/** The host removed a player (`kick`: it can come back; `ban`: it cannot). */
export const playerRemoved = (how: "kick" | "ban") => track("practice_together_remove", how);
/** The audio quality choice: Auto, Tight, Balanced or Safe. */
export const presetChosen = (choice: string) => track("practice_together_preset", choice);
/** A shared start ran on this computer. */
export const sharedStart = () => track("practice_together_play");

/**
 * Watches one session's state and counts what happens in it, each at most once: the first
 * synchronized clock, each new problem, a tab sent or received, and how it ended and how long it
 * lasted. Feed it every snapshot (`session.subscribe`).
 */
export class SessionAnalytics {
  private synchronizedAt: number | null = null;
  /** The problem in the previous snapshot, to count a problem once when it appears. */
  private previous: ProblemKind | null = null;
  /** The last problem there was, for the reason a session ended (closing clears it). */
  private lastSeen: ProblemKind | null = null;
  private tabCounted = false;
  private finished = false;

  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  observe(state: SessionState): void {
    if (this.finished) return;

    if (state.phase === "synchronized" && this.synchronizedAt === null) {
      this.synchronizedAt = this.now();
      if (state.quality.bucket !== "none") track("practice_together_sync", state.quality.bucket);
    }

    const kind = state.problem?.kind ?? null;
    if (kind !== null && kind !== this.previous) {
      if (COUNTED_PROBLEMS.includes(kind)) track("practice_together_problem", kind);
      if (kind === "tab") track("practice_together_tab", "failed");
    }
    this.previous = kind;
    if (kind !== null) this.lastSeen = kind;

    const transfer = state.transfer;
    if (transfer && transfer.total > 0 && transfer.done >= transfer.total) {
      if (!this.tabCounted) {
        this.tabCounted = true;
        track("practice_together_tab", transfer.direction === "send" ? "sent" : "received");
      }
    } else if (transfer) this.tabCounted = false;

    if (state.phase === "closed" || state.phase === "failed") {
      this.finished = true;
      const why =
        state.phase === "failed"
          ? "failed"
          : this.lastSeen === "peer-left"
            ? "peer_left"
            : this.lastSeen === "dropped"
              ? "dropped"
              : this.lastSeen === "kicked" || this.lastSeen === "banned"
                ? "removed"
                : "left";
      track("practice_together_end", why);
      if (this.synchronizedAt !== null) {
        track("practice_together_length", lengthRange((this.now() - this.synchronizedAt) / 1000));
      }
    }
  }
}

let carried: SessionAnalytics | null = null;

/**
 * The counter for a session that is starting. A guest that receives the host's tab moves its
 * connection to a new workspace (`resumed`): that is the same session, so it carries on with the
 * same counter and is not counted again.
 */
export function sessionAnalytics(resumed: boolean): SessionAnalytics {
  if (!(resumed && carried)) carried = new SessionAnalytics();
  return carried;
}
