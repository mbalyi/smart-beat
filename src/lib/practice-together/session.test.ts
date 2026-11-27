import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decode, encode, type Command, type Message } from "@/lib/practice-together/protocol";
import {
  REFRESH_PINGS,
  Session,
  type SessionHooks,
  type SessionOptions,
} from "@/lib/practice-together/session";
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
    const issued = performance.now();
    const result = await Promise.all([
      host.session.command(cmd({ tick: 960 })),
      vi.advanceTimersByTimeAsync(500),
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
    expect(hostClock).toBeGreaterThan(issued);
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
    // Play goes after a few quick pings (#258); the others at once.
    await vi.advanceTimersByTimeAsync(500);
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

  it("drop a Play still on its way when a Stop is asked for right after it (#258)", async () => {
    const { host, guest } = await connect();
    const asked: string[] = [];
    host.hooks.request = (action) => asked.push(action);
    guest.session.request("play");
    guest.session.request("stop");
    await vi.advanceTimersByTimeAsync(500);
    expect(asked).toEqual(["stop"]);
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

  it("does not take a slow ping setting for a sleep", async () => {
    // Safe pings every 3 s: the time between pings is not how late the timer was.
    const { host, guest } = await connect(2, { clockOffset: 7_000, quality: "safe" });
    const problems: (string | undefined)[] = [];
    host.session.subscribe((st) => problems.push(st.problem?.kind));
    guest.session.subscribe((st) => problems.push(st.problem?.kind));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(problems).not.toContain("woke");
    expect(host.session.snapshot.phase).toBe("synchronized");
    expect(guest.session.snapshot.phase).toBe("synchronized");
  });

  it("does not take a busy page for a sleep, however often it is late", async () => {
    const { guest } = await connect(2, { clockOffset: 7_000, quality: "balanced" });
    const problems: (string | undefined)[] = [];
    guest.session.subscribe((st) => problems.push(st.problem?.kind));
    // Playback and drawing hold the page up: the timer comes a few seconds late, again and again.
    const real = performance.now.bind(performance);
    let stalled = 0;
    vi.spyOn(performance, "now").mockImplementation(() => real() + stalled);
    for (let i = 0; i < 8; i += 1) {
      stalled += 4_000;
      await vi.advanceTimersByTimeAsync(2_100);
    }
    expect(problems).not.toContain("woke");
    expect(guest.session.snapshot.phase).toBe("synchronized");
  });

  it("notices a sleep that the page's own clock did not count", async () => {
    // Some computers stop performance.now() while they sleep; the wall clock keeps going.
    const { guest } = await connect();
    const problems: (string | undefined)[] = [];
    guest.session.subscribe((st) => problems.push(st.problem?.kind));
    vi.setSystemTime(Date.now() + 120_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(problems).toContain("woke");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(guest.session.snapshot.phase).toBe("synchronized");
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

/** The types of the messages each end hears from the other, as they arrive. */
function listen(pair: [PeerTransport, PeerTransport]) {
  const fromHost: Message[] = [];
  const fromGuest: Message[] = [];
  pair[1].onFrame((text) => {
    const msg = decode(text)?.msg;
    if (msg) fromHost.push(msg);
  });
  pair[0].onFrame((text) => {
    const msg = decode(text)?.msg;
    if (msg) fromGuest.push(msg);
  });
  const types = (list: Message[]) => list.map((m) => m.type);
  return {
    fromHost,
    fromGuest,
    types,
    clear() {
      fromHost.length = 0;
      fromGuest.length = 0;
    },
  };
}

describe("while a song plays (#258)", () => {
  it("sends no pings, reports or positions, and measures again once it stops", async () => {
    const { pair, host, guest } = await connect();
    host.hooks.position = () => ({ pos: 1_000, playing: true });
    const wire = listen(pair);
    host.session.setPlaying(true);
    guest.session.setPlaying(true);
    // A ping timer already set may still fire once; after that the line is quiet.
    await vi.advanceTimersByTimeAsync(5_000);
    wire.clear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wire.types(wire.fromHost)).toEqual([]);
    expect(wire.types(wire.fromGuest)).toEqual([]);

    host.session.setPlaying(false);
    guest.session.setPlaying(false);
    await vi.advanceTimersByTimeAsync(300);
    // A few quick pings right away, from both ends.
    expect(wire.types(wire.fromHost).filter((t) => t === "ping").length).toBeGreaterThanOrEqual(
      REFRESH_PINGS,
    );
    expect(wire.types(wire.fromGuest).filter((t) => t === "ping").length).toBeGreaterThanOrEqual(
      REFRESH_PINGS,
    );
    expect(host.session.snapshot.phase).toBe("synchronized");
  });

  it("keeps measuring a guest that joined during the song until it is in sync", async () => {
    const pair = memoryPair({ up: 2, down: 2 });
    const host = side(pair[0], "host");
    const guest = side(pair[1], "guest", { clockOffset: 7_000 });
    host.session.setPlaying(true);
    guest.session.setPlaying(true);
    host.session.start();
    guest.session.start();
    openPair(pair);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(host.session.snapshot.phase).toBe("synchronized");
    expect(guest.session.snapshot.phase).toBe("synchronized");
  });

  it("goes quiet on the guest when a Play arrives, before its player says it plays", async () => {
    const { pair, host, guest } = await connect();
    await Promise.all([host.session.command(cmd()), vi.advanceTimersByTimeAsync(500)]);
    expect(guest.hooks.scheduled).toHaveLength(1);
    const wire = listen(pair);
    await vi.advanceTimersByTimeAsync(5_000);
    wire.clear();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(wire.types(wire.fromGuest)).not.toContain("ping");
  });

  it("brings the clocks up to date with a few quick pings before a Play's lead time", async () => {
    const { pair, host } = await connect();
    const wire = listen(pair);
    const started = host.session.command(cmd());
    await vi.advanceTimersByTimeAsync(500);
    expect(await started).toBe("started");
    const sent = wire.types(wire.fromHost);
    const command = sent.indexOf("cmd");
    expect(command).toBeGreaterThan(-1);
    expect(sent.slice(0, command).filter((t) => t === "ping")).toHaveLength(REFRESH_PINGS);
    // The pongs came back before the command went out.
    const pongs = wire.fromGuest.filter((m) => m.type === "pong").length;
    expect(pongs).toBeGreaterThanOrEqual(REFRESH_PINGS);
  });

  it("does not take a long stall during the song for a sleep", async () => {
    const { host, guest } = await connect();
    host.session.setPlaying(true);
    guest.session.setPlaying(true);
    const problems: (string | undefined)[] = [];
    guest.session.subscribe((st) => problems.push(st.problem?.kind));
    host.session.subscribe((st) => problems.push(st.problem?.kind));
    const real = performance.now.bind(performance);
    let stalled = 0;
    vi.spyOn(performance, "now").mockImplementation(() => real() + stalled);
    stalled = 60_000;
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(problems).not.toContain("woke");
    expect(guest.session.snapshot.phase).toBe("synchronized");
    // Stopping starts the timers afresh: the stall is not counted then either.
    guest.session.setPlaying(false);
    host.session.setPlaying(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(problems).not.toContain("woke");
  });

  it("keeps the clock and stays in sync when the connection comes back during the song", async () => {
    const { pair, host, guest } = await connect();
    host.session.setPlaying(true);
    guest.session.setPlaying(true);
    dropPair(pair);
    await vi.advanceTimersByTimeAsync(100);
    expect(guest.session.snapshot.phase).toBe("reconnecting");
    const wire = listen(pair);
    const phases: string[] = [];
    guest.session.subscribe((st) => phases.push(st.phase));
    host.session.subscribe((st) => phases.push(st.phase));
    openPair(pair);
    await vi.advanceTimersByTimeAsync(20);
    expect(guest.session.snapshot.phase).toBe("synchronized");
    expect(host.session.snapshot.phase).toBe("synchronized");
    expect(guest.session.snapshot.problem).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    // Never back to syncing while the song plays, and nothing measured.
    expect(phases).not.toContain("syncing");
    expect(wire.types(wire.fromHost)).not.toContain("ping");
    expect(wire.types(wire.fromGuest)).not.toContain("ping");
    // A Stop still reaches the guest and acts there.
    host.session.halt({ ...cmd({ action: "stop" }), id: 99, at: 0 });
    await vi.advanceTimersByTimeAsync(20);
    expect(guest.hooks.scheduled.map((s) => s.cmd.action)).toContain("stop");
    // Once the song stops, the clocks are synced again from scratch.
    guest.session.setPlaying(false);
    host.session.setPlaying(false);
    expect(phases).toContain("syncing");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(guest.session.snapshot.phase).toBe("synchronized");
    expect(host.session.snapshot.phase).toBe("synchronized");
  });
});

describe("pause and stop (#258)", () => {
  it("act on the guest at once, with no lead time and no answer", async () => {
    const { pair, host, guest } = await connect();
    const wire = listen(pair);
    host.session.halt({ ...cmd({ action: "stop" }), id: 7, at: 0 });
    await vi.advanceTimersByTimeAsync(10);
    const stop = guest.hooks.scheduled.find((s) => s.cmd.action === "stop")!;
    expect(stop).toBeDefined();
    // Right when it arrived (2 ms on the wire), on the guest's own clock.
    expect(Math.abs(stop.localAt - (performance.now() + 7_000))).toBeLessThan(10);
    expect(guest.hooks.prepared.map((c) => c.action)).not.toContain("stop");
    expect(wire.types(wire.fromGuest)).not.toContain("ready");
    // The host stops at once too.
    expect(host.hooks.scheduled.map((s) => s.cmd.action)).toContain("stop");
  });

  it("act on a guest whose clocks are being synced again", async () => {
    const { pair, host, guest } = await connect();
    dropPair(pair);
    await vi.advanceTimersByTimeAsync(100);
    openPair(pair);
    // Welcomed again, the clocks start over: the guest is syncing.
    await vi.advanceTimersByTimeAsync(10);
    expect(guest.session.snapshot.phase).toBe("syncing");
    host.session.halt({ ...cmd({ action: "pause" }), id: 8, at: 0 });
    await vi.advanceTimersByTimeAsync(10);
    expect(guest.hooks.scheduled.map((s) => s.cmd.action)).toContain("pause");
  });

  it("call off a Play that waits for its moment on the guest", async () => {
    const { host, guest } = await connect(3, { clockOffset: 7_000 }, { quality: "safe" });
    const started = host.session.command(cmd());
    await vi.advanceTimersByTimeAsync(250);
    const play = guest.hooks.scheduled.find((s) => s.cmd.action === "play");
    expect(play).toBeDefined();
    // The start is still ahead when the Stop comes.
    expect(play!.localAt).toBeGreaterThan(performance.now() + 7_000);
    host.session.halt({ ...cmd({ action: "stop" }), id: 50, at: 0 });
    await vi.advanceTimersByTimeAsync(10);
    expect(guest.hooks.cancelled).toContain(play!.cmd.id);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await started).toBe("started");
  });

  it("call off a Play the guest is still preparing", async () => {
    const { host, guest } = await connect();
    guest.hooks.prepare = (c) =>
      new Promise((resolve) => {
        guest.hooks.prepared.push(c);
        setTimeout(() => resolve(true), 60);
      });
    const started = host.session.command(cmd());
    // Past the quick pings: the guest is preparing.
    await vi.advanceTimersByTimeAsync(170);
    expect(guest.hooks.prepared.map((c) => c.action)).toContain("play");
    guest.session.cancelStarts();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(guest.hooks.scheduled.map((s) => s.cmd.action)).not.toContain("play");
    expect(await started).toBe("late");
  });

  it("call off the host's own Play that is still on its way", async () => {
    const { host } = await connect();
    const started = host.session.command(cmd());
    await vi.advanceTimersByTimeAsync(20);
    host.session.halt({ ...cmd({ action: "stop" }), id: 51, at: 0 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await started).toBe("late");
    expect(host.hooks.scheduled.map((s) => s.cmd.action)).toEqual(["stop"]);
  });

  it("go out a lead time ahead, as before, to an app that does not know halts", async () => {
    const pair = memoryPair({ up: 2, down: 2 });
    const host = side(pair[0], "host");
    host.session.start();
    const heard: Message[] = [];
    pair[1].onFrame((text) => {
      const msg = decode(text)?.msg;
      if (msg) heard.push(msg);
    });
    openPair(pair);
    pair[1].send(
      encode(
        {
          type: "hello",
          name: "Old guest",
          role: "guest",
          caps: ["transport", "metronome", "speed", "loop", "tab"],
          score: SCORE,
        },
        1,
      ),
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(heard.map((m) => m.type)).toContain("welcome");
    const before = performance.now();
    host.session.halt({ ...cmd({ action: "stop" }), id: 9, at: 0 });
    await vi.advanceTimersByTimeAsync(10);
    const sent = heard.find((m) => m.type === "cmd") as Extract<Message, { type: "cmd" }>;
    expect(sent.cmd.at).toBeGreaterThanOrEqual(before + host.session.snapshot.leadMs);
  });
});

describe("telling the app about changes", () => {
  it("does not hand out a new state when nothing it shows changed", async () => {
    const { host, guest } = await connect();
    await vi.advanceTimersByTimeAsync(10_000);
    let updates = 0;
    host.session.subscribe(() => (updates += 1));
    guest.session.subscribe(() => (updates += 1));
    // A steady wire: every pong measures the same, so nothing new is shown.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(updates).toBe(0);
  });
});
