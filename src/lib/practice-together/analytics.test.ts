import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SessionAnalytics,
  hosted,
  joined,
  lengthRange,
  opened,
  handOverSessionAnalytics,
  presetChosen,
  sessionAnalytics,
  setupFailed,
  sharedStart,
} from "@/lib/practice-together/analytics";
import type { ProblemKind, SessionPhase, SessionState } from "@/lib/practice-together/session";
import { track } from "@/lib/telemetry";

vi.mock("@/lib/telemetry", () => ({ track: vi.fn() }));

const calls = () => vi.mocked(track).mock.calls.map(([event, detail]) => [event, detail]);

function state(
  phase: SessionPhase,
  extra: Partial<SessionState> & { kind?: ProblemKind } = {},
): SessionState {
  const { kind, ...rest } = extra;
  return {
    role: "host",
    phase,
    session: "secret-session-id",
    peerName: "Johnny",
    quality: { errorMs: 4, bucket: "excellent" },
    latency: { samples: 8, p50: 5, p95: 9, jitter: 1 },
    preset: "balanced",
    leadMs: 450,
    problem: kind ? { kind, message: "A message with a name: Johnny", fatal: false } : null,
    peer: null,
    ...rest,
  } as SessionState;
}

beforeEach(() => vi.mocked(track).mockClear());

describe("counting a Practice together session", () => {
  it("counts the dialog, hosting, joining, a failed set-up, the audio quality and a shared start", () => {
    opened("start");
    hosted("lan");
    joined("internet");
    setupFailed("lan");
    presetChosen("safe");
    sharedStart();
    expect(calls()).toEqual([
      ["practice_together_open", "start"],
      ["practice_together_host", "lan"],
      ["practice_together_join", "internet"],
      ["practice_together_setup_failed", "lan"],
      ["practice_together_preset", "safe"],
      ["practice_together_play", undefined],
    ]);
  });

  it("counts the first synchronized clock once, with its quality word and nothing else", () => {
    const stats = new SessionAnalytics();
    stats.observe(state("waiting"));
    stats.observe(state("syncing"));
    stats.observe(state("synchronized"));
    stats.observe(state("synchronized", { quality: { errorMs: 30, bucket: "unstable" } }));
    expect(calls()).toEqual([["practice_together_sync", "excellent"]]);
  });

  it("counts each new problem once, and leaves out the ones that are not faults", () => {
    const stats = new SessionAnalytics();
    stats.observe(state("synchronized", { kind: "late" }));
    stats.observe(state("synchronized", { kind: "late" }));
    stats.observe(state("synchronized"));
    stats.observe(state("synchronized", { kind: "late" }));
    stats.observe(state("synchronized", { kind: "not-synchronized" }));
    stats.observe(state("synchronized", { kind: "poor" }));
    expect(calls().filter(([event]) => event === "practice_together_problem")).toEqual([
      ["practice_together_problem", "late"],
      ["practice_together_problem", "late"],
      ["practice_together_problem", "poor"],
    ]);
  });

  it("counts a tab sent or received when it is whole, and a tab that failed", () => {
    const stats = new SessionAnalytics();
    const progress = (done: number, direction: "send" | "receive") =>
      state("syncing", { transfer: { direction, name: "My Private Song", done, total: 3 } });
    stats.observe(progress(1, "send"));
    stats.observe(progress(3, "send"));
    stats.observe(progress(3, "send"));
    stats.observe(state("syncing", { kind: "tab" }));
    expect(calls()).toEqual([
      ["practice_together_tab", "sent"],
      ["practice_together_problem", "tab"],
      ["practice_together_tab", "failed"],
    ]);
  });

  it("counts how a session ended and how long it lasted", () => {
    let now = 1_000;
    const stats = new SessionAnalytics(() => now);
    stats.observe(state("synchronized"));
    now += 7 * 60_000;
    stats.observe(state("synchronized", { kind: "peer-left" }));
    stats.observe(state("closed"));
    stats.observe(state("closed"));
    expect(calls()).toEqual([
      ["practice_together_sync", "excellent"],
      ["practice_together_end", "peer_left"],
      ["practice_together_length", "5_15m"],
    ]);
  });

  it("tells leaving, a dropped connection and a failure apart", () => {
    const reason = (...snapshots: SessionState[]) => {
      vi.mocked(track).mockClear();
      const stats = new SessionAnalytics();
      for (const snapshot of snapshots) stats.observe(snapshot);
      return calls().find(([event]) => event === "practice_together_end")?.[1];
    };
    expect(reason(state("waiting"), state("closed"))).toBe("left");
    expect(reason(state("reconnecting", { kind: "dropped" }), state("closed"))).toBe("dropped");
    expect(reason(state("syncing"), state("failed"))).toBe("failed");
  });

  it("sends no length for a session that never synchronized", () => {
    const stats = new SessionAnalytics();
    stats.observe(state("waiting"));
    stats.observe(state("closed"));
    expect(calls()).toEqual([["practice_together_end", "left"]]);
  });

  it("never passes a name, a code, a title or the session id to the counters", () => {
    const stats = new SessionAnalytics();
    stats.observe(state("synchronized", { kind: "tab", role: "guest" }));
    stats.observe(state("closed"));
    const sent = JSON.stringify(vi.mocked(track).mock.calls);
    expect(sent).not.toMatch(/Johnny|secret-session-id|A message/);
  });

  it("puts a session length in a range", () => {
    expect(
      [10, 59, 60, 299, 300, 899, 900, 3599, 3600, 9000].map((seconds) => lengthRange(seconds)),
    ).toEqual([
      "under_1m",
      "under_1m",
      "1_5m",
      "1_5m",
      "5_15m",
      "5_15m",
      "15_60m",
      "15_60m",
      "over_60m",
      "over_60m",
    ]);
  });
});

describe("a session that moves to the tab it received", () => {
  it("is not counted as ended, and the resumed session counts its own end once", () => {
    const first = sessionAnalytics(false);
    first.observe(state("synchronized", { role: "guest" }));
    vi.mocked(track).mockClear();

    // The handoff closes the old session on purpose: nothing is counted.
    handOverSessionAnalytics();
    first.observe(state("closed", { role: "guest" }));
    expect(calls()).toEqual([]);

    // The resumed session reuses the counter; its real end is counted, once.
    const resumed = sessionAnalytics(true);
    expect(resumed).toBe(first);
    resumed.observe(state("synchronized", { role: "guest" }));
    resumed.observe(state("closed", { role: "guest", kind: "peer-left" }));
    resumed.observe(state("closed", { role: "guest", kind: "peer-left" }));
    expect(calls().filter(([event]) => event === "practice_together_end")).toEqual([
      ["practice_together_end", "peer_left"],
    ]);
  });
});
