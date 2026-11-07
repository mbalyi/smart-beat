import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decode, encode, type Command } from "@/lib/practice-together/protocol";
import { Session, type SessionHooks, type SessionOptions } from "@/lib/practice-together/session";
import {
  dropPair,
  memoryPair,
  openPair,
  type PeerTransport,
} from "@/lib/practice-together/transport";

const SCORE = { key: "score-a", bars: 16 };

const cmd = (over: Partial<Command> = {}): Omit<Command, "id" | "at"> => ({
  action: "play",
  tick: 0,
  speed: 100,
  loop: null,
  metronome: false,
  countIn: false,
  countInBeats: 4,
  ...over,
});

interface Side {
  session: Session;
  hooks: SessionHooks & {
    prepared: Command[];
    scheduled: { cmd: Command; localAt: number }[];
    cancelled: number[];
  };
}

function side(
  transport: PeerTransport,
  role: "host" | "guest",
  extra: Partial<SessionOptions> & { ready?: boolean; clockOffset?: number } = {},
): Side {
  const hooks: Side["hooks"] = {
    prepared: [],
    scheduled: [],
    cancelled: [],
    async prepare(c) {
      hooks.prepared.push(c);
      return extra.ready ?? true;
    },
    schedule(c, localAt) {
      hooks.scheduled.push({ cmd: c, localAt });
      return () => hooks.cancelled.push(c.id);
    },
    approve: async () => true,
  };
  const shift = extra.clockOffset ?? 0;
  const session = new Session({
    role,
    transport,
    name: role === "host" ? "Host" : "Guest",
    score: SCORE,
    hooks,
    now: () => performance.now() + shift,
    ...extra,
  });
  return { session, hooks };
}

/** Connects a host and a guest over a wire with `latency` ms each way, and lets them sync. */
async function connect(
  latency = 2,
  guestExtra: Parameters<typeof side>[2] = { clockOffset: 7_000 },
  hostExtra: Parameters<typeof side>[2] = {},
) {
  const pair = memoryPair({ up: latency, down: latency });
  const host = side(pair[0], "host", hostExtra);
  const guest = side(pair[1], "guest", guestExtra);
  host.session.start();
  guest.session.start();
  openPair(pair);
  await vi.advanceTimersByTimeAsync(2_000);
  return { pair, host, guest };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("connecting", () => {
  it("syncs the two clocks and reaches synchronized on both sides", async () => {
    const { host, guest } = await connect(3);
    expect(host.session.snapshot.phase).toBe("synchronized");
    expect(guest.session.snapshot.phase).toBe("synchronized");
    expect(guest.session.snapshot.quality.bucket).toBe("excellent");
    expect(guest.session.snapshot.peerName).toBe("Host");
    expect(host.session.snapshot.peerName).toBe("Guest");
    // The guest's clock is 7 s ahead; the estimate finds it.
    const now = performance.now();
    expect(guest.session.sessionNow()).toBeCloseTo(now, 0);
  });

  it("waits for the host to approve and can be declined", async () => {
    const pair = memoryPair({ up: 1 });
    const host = side(pair[0], "host");
    host.hooks.approve = async () => false;
    const guest = side(pair[1], "guest");
    host.session.start();
    guest.session.start();
    openPair(pair);
    await vi.advanceTimersByTimeAsync(100);
    expect(guest.session.snapshot.phase).toBe("failed");
    expect(guest.session.snapshot.problem?.kind).toBe("declined");
    expect(host.session.snapshot.phase).toBe("waiting");
  });

  it("refuses a different version of the score", async () => {
    const pair = memoryPair({ up: 1 });
    const host = side(pair[0], "host");
    const guest = side(pair[1], "guest", { score: { key: "other", bars: 16 } });
    host.session.start();
    guest.session.start();
    openPair(pair);
    await vi.advanceTimersByTimeAsync(100);
    expect(guest.session.snapshot.phase).toBe("failed");
    expect(guest.session.snapshot.problem?.kind).toBe("score");
  });

  it("blocks starting when the score changes mid-session and recovers when it matches again", async () => {
    const { host, guest } = await connect();
    guest.session.setScore({ key: "edited", bars: 16 });
    await vi.advanceTimersByTimeAsync(50);
    expect(host.session.snapshot.problem?.kind).toBe("score");
    expect(await host.session.command(cmd())).toBe("score");
    guest.session.setScore(SCORE);
    await vi.advanceTimersByTimeAsync(50);
    expect(host.session.snapshot.problem).toBeNull();
  });

  it("shows the guest's sync quality to the host", async () => {
    const { host } = await connect(4);
    const peer = host.session.snapshot.peer;
    expect(peer).not.toBeNull();
    expect(peer!.errorMs).toBeLessThan(10);
  });

  it("turns a stranger away while it has a guest", async () => {
    const { pair, host } = await connect();
    const answers: string[] = [];
    pair[1].onFrame((text) => {
      const msg = decode(text)?.msg;
      if (msg?.type === "refuse") answers.push(msg.reason);
    });
    pair[1].send(
      encode({ type: "hello", name: "Stranger", role: "guest", caps: [], score: SCORE }, 99),
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(answers).toEqual(["busy"]);
    // (Here the stranger shares the real guest's pipe, so the guest also hears the refusal;
    // on a real network each has its own connection.)
    expect(host.session.snapshot.peerName).toBe("Guest");
  });
});

describe("scheduled commands", () => {
  it("starts both apps at the same session time", async () => {
    const { host, guest } = await connect(3);
    const result = await Promise.all([
      host.session.command(cmd({ tick: 960 })),
      vi.advanceTimersByTimeAsync(50),
    ]).then(([r]) => r);
    expect(result).toBe("started");
    expect(host.hooks.scheduled).toHaveLength(1);
    expect(guest.hooks.scheduled).toHaveLength(1);
    const h = host.hooks.scheduled[0]!;
    const g = guest.hooks.scheduled[0]!;
    expect(h.cmd.tick).toBe(960);
    // Each app's local start time, brought to the same clock, agrees within the sync error.
    const hostClock = h.localAt;
    const guestClock = g.localAt - 7_000;
    expect(Math.abs(hostClock - guestClock)).toBeLessThan(3);
    expect(hostClock).toBeGreaterThan(performance.now() - 50);
  });

  it("uses a lead time that follows the network", async () => {
    const calm = await connect(1);
    const calmLead = calm.host.session.snapshot.leadMs;
    const rough = await connect(120);
    expect(rough.host.session.snapshot.leadMs).toBeGreaterThan(calmLead);
  });

  it("calls the start off for everyone when the guest is not ready", async () => {
    const { host, guest } = await connect(3, { clockOffset: 7_000, ready: false });
    const [result] = await Promise.all([
      host.session.command(cmd()),
      vi.advanceTimersByTimeAsync(3_000),
    ]);
    expect(result).toBe("late");
    expect(host.hooks.scheduled).toHaveLength(0);
    expect(guest.hooks.scheduled).toHaveLength(0);
    expect(host.session.snapshot.problem?.kind).toBe("late");
  });

  it("takes a guest's start back when the host calls it off", async () => {
    const { host, guest } = await connect(3);
    // The host cannot prepare.
    host.hooks.prepare = async () => false;
    const [result] = await Promise.all([
      host.session.command(cmd()),
      vi.advanceTimersByTimeAsync(2_000),
    ]);
    expect(result).toBe("late");
    expect(guest.hooks.cancelled).toEqual(guest.hooks.scheduled.map((s) => s.cmd.id));
  });

  it("refuses to start before the clocks are in sync", async () => {
    const pair = memoryPair({ up: 1 });
    const host = side(pair[0], "host");
    host.session.start();
    expect(await host.session.command(cmd())).toBe("not-synchronized");
    expect(host.session.snapshot.problem?.kind).toBe("not-synchronized");
  });

  it("only the host sends commands", async () => {
    const { guest } = await connect();
    expect(await guest.session.command(cmd())).toBe("not-synchronized");
  });
});

describe("a guest's requests", () => {
  it("reach the host, which decides and starts it for both", async () => {
    const { host, guest } = await connect();
    const asked: [string, number | undefined][] = [];
    host.hooks.request = (action, tick) => asked.push([action, tick]);
    expect(guest.session.request("play")).toBe(true);
    expect(guest.session.request("seek", 3840)).toBe(true);
    expect(guest.session.request("pause")).toBe(true);
    expect(guest.session.request("stop")).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(asked).toEqual([
      ["play", undefined],
      ["seek", 3840],
      ["pause", undefined],
      ["stop", undefined],
    ]);
  });

  it("cannot be made before the clocks are in sync, or by the host", async () => {
    const pair = memoryPair({ up: 1 });
    const guest = side(pair[1], "guest");
    guest.session.start();
    expect(guest.session.request("play")).toBe(false);
    const { host } = await connect();
    expect(host.session.request("play")).toBe(false);
  });

  it("are ignored by a host that is not synchronized, and a guest never acts on one", async () => {
    const pair = memoryPair({ up: 1 });
    const host = side(pair[0], "host");
    const asked: string[] = [];
    host.hooks.request = (action) => asked.push(action);
    host.session.start();
    openPair(pair);
    pair[1].send(encode({ type: "request", action: "play" }, 1));
    await vi.advanceTimersByTimeAsync(20);
    expect(asked).toEqual([]);

    const { guest } = await connect();
    const guestAsked: string[] = [];
    guest.hooks.request = (action) => guestAsked.push(action);
    // The host's session sends nothing like it; a stray one is dropped.
    expect(decode(encode({ type: "request", action: "nap" as never }, 1))).toBeNull();
    expect(guestAsked).toEqual([]);
  });
});

describe("failures", () => {
  it("reconnects after a short drop and syncs again", async () => {
    const { pair, host, guest } = await connect();
    dropPair(pair);
    await vi.advanceTimersByTimeAsync(100);
    expect(guest.session.snapshot.phase).toBe("reconnecting");
    expect(guest.session.snapshot.problem?.kind).toBe("dropped");
    expect(host.session.snapshot.phase).toBe("reconnecting");
    openPair(pair);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(guest.session.snapshot.phase).toBe("synchronized");
    expect(host.session.snapshot.phase).toBe("synchronized");
    expect(guest.session.snapshot.problem).toBeNull();
  });

  it("gives up when the connection does not come back", async () => {
    const { pair, guest } = await connect();
    dropPair(pair);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(guest.session.snapshot.phase).toBe("failed");
    expect(guest.session.snapshot.problem?.kind).toBe("dropped");
  });

  it("starts over after the computer sleeps", async () => {
    const { guest } = await connect();
    const problems: (string | undefined)[] = [];
    guest.session.subscribe((st) => problems.push(st.problem?.kind));
    // The timers stall for a minute (sleep), then run again.
    const real = performance.now.bind(performance);
    let slept = 0;
    vi.spyOn(performance, "now").mockImplementation(() => real() + slept);
    slept = 60_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(problems).toContain("woke");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(guest.session.snapshot.phase).toBe("synchronized");
    expect(guest.session.snapshot.problem).toBeNull();
  });

  it("warns when the quality is too poor", async () => {
    const { guest } = await connect(180);
    expect(guest.session.snapshot.problem?.kind).toBe("poor");
    expect(guest.session.snapshot.problem?.fatal).toBe(false);
  });

  it("the host goes back to waiting when the guest leaves", async () => {
    const { host, guest } = await connect();
    guest.session.leave();
    await vi.advanceTimersByTimeAsync(20);
    expect(guest.session.snapshot.phase).toBe("closed");
    expect(host.session.snapshot.phase).toBe("waiting");
    expect(host.session.snapshot.problem?.kind).toBe("peer-left");
  });

  it("the guest ends when the host leaves", async () => {
    const { host, guest } = await connect();
    host.session.leave();
    await vi.advanceTimersByTimeAsync(20);
    expect(guest.session.snapshot.phase).toBe("closed");
    expect(guest.session.snapshot.problem?.kind).toBe("peer-left");
  });

  it("ignores junk on the wire", async () => {
    const pair = memoryPair();
    const host = side(pair[0], "host");
    host.session.start();
    openPair(pair);
    pair[1].send("garbage");
    pair[1].send('{"v":1,"n":1,"msg":{"type":"cmd","cmd":{}}}');
    await vi.advanceTimersByTimeAsync(10);
    expect(host.session.snapshot.phase).toBe("waiting");
  });
});

describe("quality setting", () => {
  it("changes the lead time", async () => {
    const { host } = await connect(3, undefined, { quality: "tight" });
    const tight = host.session.snapshot.leadMs;
    host.session.setQuality("safe");
    expect(host.session.snapshot.leadMs).toBeGreaterThan(tight);
    expect(host.session.snapshot.preset).toBe("safe");
  });

  it("auto follows the measurements", async () => {
    const { host } = await connect(1, undefined, { quality: "auto" });
    expect(host.session.snapshot.preset).toBe("tight");
  });
});
