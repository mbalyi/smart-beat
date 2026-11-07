import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostRoom } from "@/lib/practice-together/host-room";
import { TAB_CHUNK_BYTES, type Command } from "@/lib/practice-together/protocol";
import { Session, type SessionHooks, type TabHooks } from "@/lib/practice-together/session";
import type { ReceivedTab, TabPayload } from "@/lib/practice-together/tab-transfer";
import {
  memoryAcceptor,
  memoryPair,
  openPair,
  type GuestLink,
} from "@/lib/practice-together/transport";

/** Several tabs in one session: the app moves the live session to another tab (`rebind`). */

const realSetTimeout = globalThis.setTimeout;
const TAB_A = { key: "tab-a", bars: 16 };
const TAB_B = { key: "tab-b", bars: 8 };

const cmd = (): Omit<Command, "id" | "at"> => ({
  action: "play",
  tick: 0,
  speed: 100,
  loop: null,
  metronome: false,
  countIn: false,
  countInBeats: 4,
});

const payload = (key: string): TabPayload => ({
  name: `Song ${key}`,
  bytes: Uint8Array.from({ length: TAB_CHUNK_BYTES + 5 }, (_, i) => (i * 7 + key.length) % 256),
  key,
  bars: 8,
});

/** The host's hooks for one tab, with what they were asked. */
function hostHooks(tabKey: string, extra: Partial<SessionHooks> = {}) {
  const log = {
    prepared: [] as Command[],
    scheduled: [] as Command[],
    cancelled: [] as number[],
    offers: 0,
    requests: [] as string[],
    approvals: [] as string[],
  };
  const hooks: SessionHooks = {
    prepare: async (c) => {
      log.prepared.push(c);
      return true;
    },
    schedule: (c) => {
      log.scheduled.push(c);
      return () => log.cancelled.push(c.id);
    },
    request: (action) => log.requests.push(action),
    approve: async (name) => {
      log.approvals.push(name);
      return true;
    },
    position: () => ({ pos: 0, playing: false }),
    tab: {
      offer: async () => {
        log.offers += 1;
        return payload(tabKey);
      },
    },
    ...extra,
  };
  return { hooks, log };
}

interface Guest {
  session: Session;
  received: ReceivedTab[];
  shown: string[];
  scheduled: Command[];
  /** The starts the host called off (with `abort`). */
  aborted: number[];
  has: Set<string>;
}

function guestOn(pair: ReturnType<typeof memoryPair>, name: string): Guest {
  const guest: Guest = {
    session: undefined as unknown as Session,
    received: [],
    shown: [],
    scheduled: [],
    aborted: [],
    has: new Set(),
  };
  const tab: TabHooks = {
    receive: async (t) => {
      guest.received.push(t);
      return null;
    },
    opened: () => {},
    have: (key) => guest.has.has(key),
    show: (key) => guest.shown.push(key),
  };
  guest.session = new Session({
    role: "guest",
    transport: pair[1],
    name,
    score: TAB_A,
    guest: name.toLowerCase().padEnd(16, "0").slice(0, 16),
    now: () => performance.now() + 5_000,
    hooks: {
      prepare: async () => true,
      schedule: (c) => {
        guest.scheduled.push(c);
        return (abort) => {
          if (abort) guest.aborted.push(c.id);
        };
      },
      tab,
    },
  });
  return guest;
}

/** Real time passes in small steps so the native SHA-256 can finish between the fake timers. */
async function settle(ms: number) {
  for (let done = 0; done < ms; done += 50) {
    await vi.advanceTimersByTimeAsync(50);
    await new Promise((resolve) => realSetTimeout(resolve, 1));
  }
}

function makeRoom(hooks: SessionHooks) {
  const acceptor = memoryAcceptor();
  const room = new HostRoom({ acceptor: acceptor.acceptor, name: "Host", score: TAB_A, hooks });
  return { room, acceptor };
}

async function join(acceptor: ReturnType<typeof memoryAcceptor>, name: string) {
  const pair = memoryPair({ up: 2, down: 2 });
  const guest = guestOn(pair, name);
  guest.session.start();
  openPair(pair);
  acceptor.arrive(pair[0] as GuestLink, { address: `10.0.0.${name.length}` });
  await settle(2_000);
  return { pair, guest };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a room whose app moves to another tab", () => {
  it("keeps the guests in sync and starts with the new hooks, not the old", async () => {
    const a = hostHooks("tab-a");
    const { room, acceptor } = makeRoom(a.hooks);
    const ann = await join(acceptor, "Ann");
    const bob = await join(acceptor, "Bob");
    expect(room.snapshot.phase).toBe("synchronized");

    const b = hostHooks("tab-a");
    room.rebind(b.hooks);
    await settle(500);
    // Nobody was asked again, told, or had to sync again.
    expect(room.snapshot.phase).toBe("synchronized");
    expect(room.snapshot.peers?.map((p) => p.phase)).toEqual(["synchronized", "synchronized"]);
    expect(ann.guest.session.snapshot.phase).toBe("synchronized");
    expect(a.log.approvals).toEqual(["Ann", "Bob"]);
    expect(b.log.approvals).toEqual([]);

    const [result] = await Promise.all([room.command(cmd()), settle(1_500)]);
    expect(result).toBe("started");
    expect(b.log.prepared).toHaveLength(1);
    expect(b.log.scheduled).toHaveLength(1);
    expect(a.log.prepared).toHaveLength(0);
    expect(a.log.scheduled).toHaveLength(0);
    expect(ann.guest.scheduled).toHaveLength(1);
    expect(bob.guest.scheduled).toHaveLength(1);
  });

  it("sends the new tab to a guest that does not have it, and only to it", async () => {
    const a = hostHooks("tab-a");
    const { room, acceptor } = makeRoom(a.hooks);
    const ann = await join(acceptor, "Ann");

    const b = hostHooks("tab-b");
    room.rebind(b.hooks);
    room.setScore(TAB_B);
    await settle(3_000);

    expect(b.log.offers).toBe(1);
    expect(a.log.offers).toBe(0);
    expect(ann.guest.received).toHaveLength(1);
    expect(ann.guest.received[0]).toMatchObject({ key: "tab-b", name: "Song tab-b" });
  });

  it("is answered with 'have' and no transfer by a guest that has the tab open, which shows it once", async () => {
    const a = hostHooks("tab-a");
    const { room, acceptor } = makeRoom(a.hooks);
    const { guest } = await join(acceptor, "Ann");
    guest.has.add("tab-b");

    const b = hostHooks("tab-b");
    room.rebind(b.hooks);
    room.setScore(TAB_B);
    await settle(3_000);

    expect(guest.received).toHaveLength(0);
    expect(guest.shown).toEqual(["tab-b"]);
    // The host took the "have" as an answer: it does not send the tab again.
    expect(b.log.offers).toBe(1);
    expect(room.snapshot.problem?.kind ?? null).not.toBe("tab");
    await settle(2_000);
    expect(b.log.offers).toBe(1);
  });

  it("calls off a start that was being prepared with the old hooks", async () => {
    const a = hostHooks("tab-a", {
      prepare: () => new Promise((resolve) => setTimeout(() => resolve(true), 300)),
    });
    const { room, acceptor } = makeRoom(a.hooks);
    const { guest } = await join(acceptor, "Ann");

    const started = room.command(cmd());
    await vi.advanceTimersByTimeAsync(50);
    const b = hostHooks("tab-b");
    room.rebind(b.hooks);
    await settle(2_000);

    expect(await started).toBe("late");
    expect(a.log.scheduled).toHaveLength(0);
    expect(b.log.scheduled).toHaveLength(0);
    expect(b.log.prepared).toHaveLength(0);
    // The guest did not start alone either: whatever it scheduled was called off.
    expect(guest.aborted).toEqual(guest.scheduled.map((c) => c.id));
  });

  it("calls off a start waiting for its moment with the old hooks", async () => {
    const a = hostHooks("tab-a");
    const { room, acceptor } = makeRoom(a.hooks);
    await join(acceptor, "Ann");
    const started = room.command(cmd());
    await vi.advanceTimersByTimeAsync(50);
    expect(await Promise.race([started, Promise.resolve("pending")])).toBe("started");
    expect(a.log.scheduled).toHaveLength(1);

    room.rebind(hostHooks("tab-b").hooks);
    expect(a.log.cancelled).toEqual([a.log.scheduled[0]!.id]);
  });

  it("lets a guest that joins afterwards use the new hooks", async () => {
    const a = hostHooks("tab-a");
    const { room, acceptor } = makeRoom(a.hooks);
    await join(acceptor, "Ann");

    const b = hostHooks("tab-a");
    room.rebind(b.hooks);
    const late = await join(acceptor, "Cy");

    expect(b.log.approvals).toEqual(["Cy"]);
    expect(a.log.approvals).toEqual(["Ann"]);
    expect(room.snapshot.peers).toHaveLength(2);
    // Its requests reach the new tab's host hooks, and so do Ann's after the rebind.
    late.guest.session.request("play");
    await settle(300);
    expect(b.log.requests).toEqual(["play"]);
    expect(a.log.requests).toEqual([]);
  });

  it("stops a tab that was on its way when the app moves on", async () => {
    const a = hostHooks("tab-a");
    const { room, acceptor } = makeRoom(a.hooks);
    const ann = await join(acceptor, "Ann");
    // The host edits: a new version starts on its way...
    room.setScore({ key: "tab-a2", bars: 16 });
    await vi.advanceTimersByTimeAsync(700);
    // ...and the app moves to another tab before it arrives.
    const b = hostHooks("tab-b");
    room.rebind(b.hooks);
    room.setScore(TAB_B);
    await settle(3_000);
    // The guest ends up with the new tab, never with the old tab's file.
    expect(ann.guest.received.map((t) => t.key)).not.toContain("tab-a2");
    expect(ann.guest.received.at(-1)?.key).toBe("tab-b");
  });
});

describe("a single session whose app moves to another tab", () => {
  it("stays in sync and starts with the new hooks", async () => {
    const pair = memoryPair({ up: 2, down: 2 });
    const a = hostHooks("tab-a");
    const host = new Session({
      role: "host",
      transport: pair[0],
      name: "Host",
      score: TAB_A,
      hooks: a.hooks,
    });
    const guest = guestOn(pair, "Ann");
    host.start();
    guest.session.start();
    openPair(pair);
    await settle(2_000);
    expect(host.snapshot.phase).toBe("synchronized");

    const b = hostHooks("tab-a");
    host.rebind(b.hooks);
    await settle(500);
    expect(host.snapshot.phase).toBe("synchronized");
    expect(guest.session.snapshot.phase).toBe("synchronized");

    const [result] = await Promise.all([host.command(cmd()), settle(1_500)]);
    expect(result).toBe("started");
    expect(b.log.scheduled).toHaveLength(1);
    expect(a.log.scheduled).toHaveLength(0);
  });
});
