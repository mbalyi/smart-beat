import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decode, encode, type Command } from "@/lib/practice-together/protocol";
import { RECONNECT_MS, Session, type SessionOptions } from "@/lib/practice-together/session";
import {
  dropPair,
  memoryPair,
  openPair,
  type PeerTransport,
} from "@/lib/practice-together/transport";

const SCORE = { key: "score-a", bars: 16 };

function make(
  transport: PeerTransport,
  role: "host" | "guest",
  extra: Partial<SessionOptions> = {},
): Session {
  return new Session({
    role,
    transport,
    name: role === "host" ? "Host" : "Guest",
    score: SCORE,
    hooks: {
      prepare: async () => true,
      schedule: () => () => {},
      approve: async () => true,
    },
    now: () => performance.now(),
    ...extra,
  });
}

/** The frames a transport sends, decoded. */
function spy(inner: PeerTransport, log: ReturnType<typeof decode>[]): PeerTransport {
  return {
    send: (text) => {
      log.push(decode(text));
      inner.send(text);
    },
    close: () => inner.close(),
    onFrame: (l) => inner.onFrame(l),
    onState: (l) => inner.onState(l),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a guest's own id", () => {
  it("is said in hello, and only when the app has one", async () => {
    const pair = memoryPair({ up: 1, down: 1 });
    const sent: ReturnType<typeof decode>[] = [];
    const guest = make(spy(pair[1], sent), "guest", { guest: "0011223344556677" });
    const host = make(pair[0], "host");
    host.start();
    guest.start();
    openPair(pair);
    await vi.advanceTimersByTimeAsync(50);
    const hello = sent.find((f) => f?.msg.type === "hello")!.msg as { guest?: string };
    expect(hello.guest).toBe("0011223344556677");
    expect(host.guest).toBe("0011223344556677");

    const plain: ReturnType<typeof decode>[] = [];
    const pair2 = memoryPair({ up: 1, down: 1 });
    make(pair2[0], "host").start();
    const other = make(spy(pair2[1], plain), "guest");
    other.start();
    openPair(pair2);
    await vi.advanceTimersByTimeAsync(50);
    expect(
      (plain.find((f) => f?.msg.type === "hello")!.msg as { guest?: string }).guest,
    ).toBeUndefined();
  });

  it("is checked by the protocol: a short text, not a long one", () => {
    const hello = (guest: string) =>
      encode({ type: "hello", name: "A", role: "guest", caps: [], score: SCORE, guest }, 1);
    expect(decode(hello("a".repeat(64)))).not.toBeNull();
    expect(decode(hello("a".repeat(65)))).toBeNull();
  });
});

describe("how long a dropped guest gets", () => {
  it("is 20 seconds by default and can be made longer for the host's seats", async () => {
    for (const [reconnectMs, expected] of [
      [undefined, "failed"],
      [5 * 60_000, "reconnecting"],
    ] as const) {
      const pair = memoryPair({ up: 1, down: 1 });
      const host = make(pair[0], "host", { reconnectMs });
      const guest = make(pair[1], "guest");
      host.start();
      guest.start();
      openPair(pair);
      await vi.advanceTimersByTimeAsync(2_000);
      dropPair(pair);
      await vi.advanceTimersByTimeAsync(RECONNECT_MS + 1_000);
      expect(host.snapshot.phase).toBe(expected);
      host.leave();
    }
  });
});

describe("a line that is lost for good", () => {
  it("is a dropped connection for a guest that was let in (it can rejoin), not a goodbye", async () => {
    const pair = memoryPair({ up: 1, down: 1 });
    const host = make(pair[0], "host");
    const guest = make(pair[1], "guest");
    host.start();
    guest.start();
    openPair(pair);
    await vi.advanceTimersByTimeAsync(2_000);
    (pair[1] as unknown as { set(state: string, detail?: string): void }).set(
      "closed",
      "the host did not come back",
    );
    expect(guest.snapshot.phase).toBe("closed");
    expect(guest.snapshot.problem).toMatchObject({ kind: "dropped", fatal: true });
  });
});

describe("removing a guest", () => {
  it.each(["kicked", "banned"] as const)(
    "tells the guest it was %s, and ends the host's end",
    async (how) => {
      const pair = memoryPair({ up: 1, down: 1 });
      const host = make(pair[0], "host");
      const guest = make(pair[1], "guest");
      host.start();
      guest.start();
      openPair(pair);
      await vi.advanceTimersByTimeAsync(2_000);
      host.dismiss(how);
      await vi.advanceTimersByTimeAsync(50);
      expect(guest.snapshot.phase).toBe("closed");
      expect(guest.snapshot.problem).toMatchObject({ kind: how, fatal: true });
      expect(host.snapshot.phase).toBe("closed");
    },
  );

  it("is a no-op once the session has ended", () => {
    const pair = memoryPair();
    const host = make(pair[0], "host");
    host.start();
    host.leave();
    expect(() => host.dismiss("kicked")).not.toThrow();
  });

  it("says the session is full when the host has no more room", async () => {
    const pair = memoryPair({ up: 1, down: 1 });
    const guest = make(pair[1], "guest");
    guest.start();
    openPair(pair);
    pair[0].send(encode({ type: "refuse", reason: "full" }, 1));
    await vi.advanceTimersByTimeAsync(10);
    expect(guest.snapshot.phase).toBe("failed");
    expect(guest.snapshot.problem?.message).toMatch(/holds ten players/);
  });
});

describe("one command for several guests", () => {
  const partial: Omit<Command, "id" | "at"> = {
    action: "play",
    tick: 0,
    speed: 100,
    loop: null,
    metronome: false,
    countIn: false,
    countInBeats: 4,
  };

  it("is sent as given, and answered when the guest is ready", async () => {
    const pair = memoryPair({ up: 1, down: 1 });
    const host = make(pair[0], "host");
    const guest = make(pair[1], "guest");
    host.start();
    guest.start();
    openPair(pair);
    await vi.advanceTimersByTimeAsync(2_000);
    const cmd: Command = { ...partial, id: 77, at: performance.now() + 400 };
    const ready = host.dispatch(cmd);
    await vi.advanceTimersByTimeAsync(50);
    await expect(ready).resolves.toBe(true);
  });

  it("gives up on a guest that does not answer before the start is too close", async () => {
    const pair = memoryPair({ up: 1, down: 1 });
    const host = make(pair[0], "host");
    host.start();
    openPair(pair);
    const ready = host.dispatch({ ...partial, id: 1, at: performance.now() + 300 });
    await vi.advanceTimersByTimeAsync(400);
    await expect(ready).resolves.toBe(false);
  });

  it("can be called off for one guest, which says so", async () => {
    const pair = memoryPair({ up: 1, down: 1 });
    const host = make(pair[0], "host");
    const guest = make(pair[1], "guest");
    host.start();
    guest.start();
    openPair(pair);
    await vi.advanceTimersByTimeAsync(2_000);
    host.callOff(5, "peer-late");
    await vi.advanceTimersByTimeAsync(20);
    expect(host.snapshot.problem?.kind).toBe("late");
    expect(guest.snapshot.problem?.kind).toBe("late");
  });
});
