import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decode, encode, type Command } from "@/lib/practice-together/protocol";
import { Session, type SessionHooks, type SessionOptions } from "@/lib/practice-together/session";
import { memoryPair, openPair, type PeerTransport } from "@/lib/practice-together/transport";

/** Review findings of PR #208 (the sync engine), each with the case that failed. */

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
  hooks: SessionHooks & { scheduled: { cmd: Command; localAt: number }[]; aborts: boolean[] };
}

function side(
  transport: PeerTransport,
  role: "host" | "guest",
  extra: Partial<SessionOptions> & { clockOffset?: number } = {},
): Side {
  const hooks: Side["hooks"] = {
    scheduled: [],
    aborts: [],
    prepare: async () => true,
    schedule(c, localAt) {
      hooks.scheduled.push({ cmd: c, localAt });
      return (abort) => hooks.aborts.push(abort === true);
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

describe("a message that only makes sense at the other end", () => {
  it("cannot let a guest past the host's approval by sending welcome", async () => {
    const pair = memoryPair({ up: 1, down: 1 });
    const host = side(pair[0], "host");
    let answer: (ok: boolean) => void = () => {};
    host.hooks.approve = () => new Promise<boolean>((resolve) => (answer = resolve));
    host.session.start();
    openPair(pair);
    // A modified guest: hello, then a forged welcome, then the pongs of a guest that is in.
    pair[1].send(
      encode({ type: "hello", name: "Mallory", role: "guest", caps: [], score: SCORE }, 1),
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(host.session.snapshot.phase).toBe("approving");
    pair[1].send(encode({ type: "welcome", session: "s", version: 1, name: "Mallory" }, 1));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.session.snapshot.phase).toBe("approving");
    answer(false);
    await vi.advanceTimersByTimeAsync(50);
    // No is still no: the guest was never let in.
    expect(host.session.snapshot.phase).toBe("waiting");
  });

  it("does not queue a second approval for a guest that says hello again", async () => {
    const pair = memoryPair({ up: 1, down: 1 });
    const host = side(pair[0], "host");
    const asked = vi.fn(() => new Promise<boolean>(() => {}));
    host.hooks.approve = asked;
    host.session.start();
    openPair(pair);
    const hello = encode({ type: "hello", name: "G", role: "guest", caps: [], score: SCORE }, 1);
    pair[1].send(hello);
    pair[1].send(hello);
    pair[1].send(hello);
    await vi.advanceTimersByTimeAsync(50);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("makes a guest drop commands meant for a host", async () => {
    const { pair, guest } = await connect();
    const seen: string[] = [];
    pair[0].onFrame((text) => {
      const msg = decode(text)?.msg;
      if (msg) seen.push(msg.type);
    });
    // A request arriving at a guest does nothing (it is a host's message).
    pair[0].send(encode({ type: "request", action: "play" }, 1));
    await vi.advanceTimersByTimeAsync(50);
    expect(guest.session.snapshot.phase).toBe("synchronized");
  });
});

describe("a guest that comes back before the host noticed the drop", () => {
  it("is welcomed again and syncs (a new app of the same guest)", async () => {
    const pair = memoryPair({ up: 2, down: 2 });
    const host = side(pair[0], "host");
    const first = side(pair[1], "guest", { guest: "g-1", clockOffset: 7_000 });
    host.session.start();
    first.session.start();
    openPair(pair);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.session.snapshot.phase).toBe("synchronized");
    const sessionId = first.session.snapshot.session ?? undefined;
    // The guest's app is gone (no goodbye, no close the host can see) and a new one joins on the
    // same line: the host still believes the old one is there.
    first.session.release();
    const second = side(pair[1], "guest", {
      guest: "g-1",
      resume: sessionId,
      clockOffset: 7_000,
    });
    second.session.start("open");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(second.session.snapshot.phase).toBe("synchronized");
    expect(host.session.snapshot.phase).toBe("synchronized");
  });

  it("is welcomed again when the guest reconnects its line itself", async () => {
    const { pair, host, guest } = await connect(2, { guest: "g-1", clockOffset: 7_000 });
    expect(host.session.snapshot.phase).toBe("synchronized");
    // The guest's line blips and comes back at once; the host's does not notice.
    const end = pair[1] as unknown as { set(state: string, detail?: string): void };
    end.set("reconnecting", "connection lost");
    await vi.advanceTimersByTimeAsync(100);
    expect(guest.session.snapshot.phase).toBe("reconnecting");
    end.set("open");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(guest.session.snapshot.phase).toBe("synchronized");
    expect(guest.session.snapshot.problem).toBeNull();
  });
});

describe("a start the guest cannot be ready for in time", () => {
  it("starts on a slow wire with the Tight setting (110 ms each way)", async () => {
    const { host, guest } = await connect(110, { clockOffset: 7_000 }, { quality: "tight" });
    const [result] = await Promise.all([
      host.session.command(cmd()),
      vi.advanceTimersByTimeAsync(3_000),
    ]);
    // Either both start, or neither: the guest never plays alone.
    expect(host.hooks.scheduled.length).toBe(guest.hooks.scheduled.length);
    expect(result).toBe("started");
  });

  it("does not start alone when the host calls the start off while it is preparing", async () => {
    const { host, guest } = await connect(3);
    host.hooks.prepare = async () => false;
    guest.hooks.prepare = () => new Promise((resolve) => setTimeout(() => resolve(true), 300));
    const [result] = await Promise.all([
      host.session.command(cmd()),
      vi.advanceTimersByTimeAsync(3_000),
    ]);
    expect(result).toBe("late");
    expect(guest.hooks.scheduled).toHaveLength(0);
  });

  it("tells the guest's start it was called off, so a start that already happened stops", async () => {
    const { host, guest } = await connect(3);
    host.hooks.prepare = async () => false;
    await Promise.all([host.session.command(cmd()), vi.advanceTimersByTimeAsync(2_000)]);
    expect(guest.hooks.aborts).toEqual(guest.hooks.scheduled.map(() => true));
    expect(guest.hooks.aborts.length).toBeGreaterThan(0);
  });
});
