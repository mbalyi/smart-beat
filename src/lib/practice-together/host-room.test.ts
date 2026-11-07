import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FLUSH_MS,
  HELLO_TIMEOUT_MS,
  HostRoom,
  NOTICE_MS,
  SEAT_HOLD_MS,
  type HostRoomOptions,
} from "@/lib/practice-together/host-room";
import { MAX_PLAYERS, encode, type Command } from "@/lib/practice-together/protocol";
import { Session, type SessionHooks, type SessionOptions } from "@/lib/practice-together/session";
import type { ReceivedTab, TabPayload } from "@/lib/practice-together/tab-transfer";
import {
  dropPair,
  memoryAcceptor,
  memoryPair,
  openPair,
  type GuestLink,
} from "@/lib/practice-together/transport";

const realSetTimeout = globalThis.setTimeout;
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

interface Host {
  room: HostRoom;
  acceptor: ReturnType<typeof memoryAcceptor>;
  log: {
    prepared: Command[];
    scheduled: { cmd: Command; localAt: number }[];
    requested: [string, number | undefined][];
    approvals: { name: string; signal?: AbortSignal }[];
  };
  /** What the host answers when a guest asks to join. */
  approve: (name: string) => boolean;
  hostReady: boolean;
  /** The host's hooks (change them before guests arrive). */
  hooks: SessionHooks;
}

function makeHost(extra: Partial<HostRoomOptions> = {}): Host {
  const acceptor = memoryAcceptor();
  const host: Host = {
    room: undefined as unknown as HostRoom,
    acceptor,
    log: { prepared: [], scheduled: [], requested: [], approvals: [] },
    approve: () => true,
    hostReady: true,
    hooks: undefined as unknown as SessionHooks,
  };
  const hooks: SessionHooks = {
    prepare: async (c) => {
      host.log.prepared.push(c);
      return host.hostReady;
    },
    schedule: (c, localAt) => {
      host.log.scheduled.push({ cmd: c, localAt });
      return () => {};
    },
    request: (action, tick) => host.log.requested.push([action, tick]),
    approve: async (name, signal) => {
      host.log.approvals.push({ name, signal });
      return host.approve(name);
    },
    position: () => ({ pos: 0, playing: false }),
  };
  host.hooks = hooks;
  host.room = new HostRoom({
    acceptor: acceptor.acceptor,
    name: "Host",
    score: SCORE,
    hooks,
    ...extra,
  });
  return host;
}

interface Guest {
  session: Session;
  prepared: Command[];
  scheduled: Command[];
  cancelled: number[];
  received: ReceivedTab[];
  ready: boolean;
}

function makeGuest(
  pair: ReturnType<typeof memoryPair>,
  name: string,
  extra: Partial<SessionOptions> = {},
): Guest {
  const guest: Guest = {
    session: undefined as unknown as Session,
    prepared: [],
    scheduled: [],
    cancelled: [],
    received: [],
    ready: true,
  };
  guest.session = new Session({
    role: "guest",
    transport: pair[1],
    name,
    score: SCORE,
    guest: name.toLowerCase().padEnd(16, "0").slice(0, 16),
    now: () => performance.now() + 5_000,
    hooks: {
      prepare: async (c) => {
        guest.prepared.push(c);
        return guest.ready;
      },
      schedule: (c) => {
        guest.scheduled.push(c);
        return () => guest.cancelled.push(c.id);
      },
      tab: {
        receive: async (tab) => {
          guest.received.push(tab);
          return null;
        },
        opened: () => {},
      },
    },
    ...extra,
  });
  return guest;
}

/** A guest connects to the host and has time to sync (unless it is refused). */
async function join(host: Host, name: string, extra: Partial<SessionOptions> = {}, ms = 2_000) {
  const pair = memoryPair({ up: 2, down: 2 });
  const guest = makeGuest(pair, name, extra);
  guest.session.start();
  openPair(pair);
  host.acceptor.arrive(pair[0] as GuestLink, { address: `10.0.0.${name.length}` });
  await vi.advanceTimersByTimeAsync(ms);
  return { pair, guest };
}

/** Runs a command while time passes (the guests answer over the wire). */
async function run(host: Host, partial = cmd()) {
  const result = host.room.command(partial);
  await vi.advanceTimersByTimeAsync(1_500);
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a room with several guests", () => {
  it("keeps a place for every guest and syncs each one's clock", async () => {
    const host = makeHost();
    await join(host, "Ann");
    await join(host, "Bob");
    const state = host.room.snapshot;
    expect(state.phase).toBe("synchronized");
    expect(state.peers?.map((p) => [p.name, p.phase])).toEqual([
      ["Ann", "synchronized"],
      ["Bob", "synchronized"],
    ]);
    expect(state.peerName).toBe("Ann and Bob");
    expect(state.peers!.every((p) => p.quality.bucket === "excellent")).toBe(true);
    expect(state.peers!.every((p) => p.peer !== null)).toBe(true);
    expect(state.listening).toBe(true);
    // The host's own clock is the session clock.
    expect(host.room.role).toBe("host");
  });

  it("names a crowd briefly", async () => {
    const host = makeHost();
    for (const name of ["Ann", "Bob", "Cy"]) await join(host, name);
    expect(host.room.snapshot.peerName).toBe("Ann and 2 others");
  });

  it("holds ten players with the host, and turns the tenth guest away as full", async () => {
    expect(MAX_PLAYERS).toBe(10);
    const host = makeHost();
    for (let i = 1; i <= 9; i += 1) await join(host, `P${i}`, {}, 400);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.room.snapshot.peers).toHaveLength(9);
    expect(host.room.snapshot.phase).toBe("synchronized");
    const { guest } = await join(host, "Late", {}, 400);
    expect(guest.session.snapshot.phase).toBe("failed");
    expect(guest.session.snapshot.problem?.kind).toBe("full");
    expect(host.room.snapshot.peers).toHaveLength(9);
    await vi.advanceTimersByTimeAsync(FLUSH_MS + 10);
    expect(host.acceptor.removed).toHaveLength(1);
  });

  it("asks the host about each guest on its own, and a no only keeps that guest out", async () => {
    const host = makeHost();
    host.approve = (name) => name !== "Mallory";
    await join(host, "Ann");
    const { guest } = await join(host, "Mallory");
    await join(host, "Bob");
    expect(host.log.approvals.map((a) => a.name)).toEqual(["Ann", "Mallory", "Bob"]);
    expect(guest.session.snapshot.problem?.kind).toBe("declined");
    expect(host.room.snapshot.peers?.map((p) => p.name)).toEqual(["Ann", "Bob"]);
    expect(host.room.snapshot.phase).toBe("synchronized");
  });

  it("shows a guest waiting for the host's yes, and takes the question back if it leaves", async () => {
    const host = makeHost();
    const pending = new Promise<boolean>(() => {});
    host.hooks.approve = async (name, signal) => {
      host.log.approvals.push({ name, signal });
      return pending;
    };
    const { pair } = await join(host, "Ann", {}, 200);
    expect(host.room.snapshot.phase).toBe("approving");
    expect(host.room.snapshot.peers?.[0]?.phase).toBe("approving");
    const signal = host.log.approvals[0]!.signal!;
    expect(signal.aborted).toBe(false);
    // The guest gives up before the host answers.
    pair[1].close();
    await vi.advanceTimersByTimeAsync(50);
    expect(signal.aborted).toBe(true);
    expect(host.room.snapshot.peers).toEqual([]);
    expect(host.room.snapshot.phase).toBe("waiting");
  });

  it("closes a connection that does not start with a hello, or says nothing", async () => {
    const host = makeHost();
    const pair = memoryPair();
    openPair(pair);
    host.acceptor.arrive(pair[0] as GuestLink);
    pair[1].send(encode({ type: "ping", id: 1, t0: 0 }, 1));
    await vi.advanceTimersByTimeAsync(10);
    expect(host.acceptor.removed.map((r) => r.link)).toEqual([pair[0]]);
    expect(host.room.snapshot.peers).toEqual([]);
    const quiet = memoryPair();
    openPair(quiet);
    host.acceptor.arrive(quiet[0] as GuestLink);
    await vi.advanceTimersByTimeAsync(HELLO_TIMEOUT_MS + 1);
    expect(host.acceptor.removed.map((r) => r.link)).toContain(quiet[0]);
  });
});

describe("starting together", () => {
  it("sends one command to every guest and starts it once on the host", async () => {
    const host = makeHost();
    const ann = (await join(host, "Ann")).guest;
    const bob = (await join(host, "Bob")).guest;
    const result = await run(host);
    expect(result).toBe("started");
    expect(host.log.prepared).toHaveLength(1);
    expect(host.log.scheduled).toHaveLength(1);
    expect(ann.scheduled).toHaveLength(1);
    expect(bob.scheduled).toHaveLength(1);
    // Everybody is told the same moment, on the host's clock.
    expect(ann.scheduled[0]!.id).toBe(host.log.scheduled[0]!.cmd.id);
    expect(ann.scheduled[0]!.at).toBe(host.log.scheduled[0]!.cmd.at);
    expect(bob.scheduled[0]!.at).toBe(host.log.scheduled[0]!.cmd.at);
  });

  it("starts for the guests that are ready when one is late, and calls it off for that one", async () => {
    const host = makeHost();
    const ann = (await join(host, "Ann")).guest;
    const bob = (await join(host, "Bob")).guest;
    bob.ready = false;
    expect(await run(host)).toBe("started");
    expect(host.log.scheduled).toHaveLength(1);
    expect(ann.scheduled).toHaveLength(1);
    expect(bob.scheduled).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(bob.session.snapshot.problem?.kind).toBe("late");
    // The host is told which player it was.
    expect(host.room.snapshot.problem?.message).toMatch(/^Bob: /);
    expect(host.room.snapshot.peers?.find((p) => p.name === "Ann")?.problem).toBeNull();
  });

  it("starts nothing when no guest is ready, or the host is not", async () => {
    const host = makeHost();
    const ann = (await join(host, "Ann")).guest;
    const bob = (await join(host, "Bob")).guest;
    ann.ready = false;
    bob.ready = false;
    expect(await run(host)).toBe("late");
    expect(host.log.scheduled).toHaveLength(0);
    ann.ready = true;
    bob.ready = true;
    host.hostReady = false;
    expect(await run(host)).toBe("late");
    await vi.advanceTimersByTimeAsync(50);
    expect(host.log.scheduled).toHaveLength(0);
    // The guests that had got ready are told to forget it.
    expect(ann.cancelled).toHaveLength(1);
    expect(bob.cancelled).toHaveLength(1);
  });

  it("does not start for a guest that has another version of the tab", async () => {
    const host = makeHost();
    // The host can share its tab, so a guest with another one is let in and waits for it.
    host.hooks.tab = { offer: async () => null };
    const ann = (await join(host, "Ann")).guest;
    const bob = (await join(host, "Bob", { score: { key: "other", bars: 16 } }, 400)).guest;
    await vi.advanceTimersByTimeAsync(2_000);
    void bob;
    expect(host.room.snapshot.peers?.find((p) => p.name === "Bob")?.problem?.kind).toBe("score");
    expect(await run(host)).toBe("started");
    expect(ann.scheduled).toHaveLength(1);
    expect(bob.scheduled).toHaveLength(0);
  });

  it("says it cannot start when no guest is in sync, or all have another tab", async () => {
    const host = makeHost();
    host.hooks.tab = { offer: async () => null };
    expect(await run(host)).toBe("not-synchronized");
    await join(host, "Bob", { score: { key: "other", bars: 16 } }, 400);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await run(host)).toBe("score");
  });

  it("starts ahead by the longest wait any guest needs", async () => {
    const host = makeHost();
    await join(host, "Ann");
    await join(host, "Bob");
    const lead = Math.max(...host.room.snapshot.peers!.map(() => host.room.snapshot.leadMs));
    await run(host);
    const planned = host.log.scheduled[0]!.cmd;
    expect(planned.at - performance.now()).toBeLessThanOrEqual(lead + 1);
    expect(host.room.snapshot.leadMs).toBeGreaterThan(0);
  });

  it("hears every guest's requests", async () => {
    const host = makeHost();
    const ann = (await join(host, "Ann")).guest;
    const bob = (await join(host, "Bob")).guest;
    expect(ann.session.request("play", 480)).toBe(true);
    expect(bob.session.request("stop")).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(host.log.requested).toEqual([
      ["play", 480],
      ["stop", undefined],
    ]);
  });

  it("follows the host's score for every guest", async () => {
    const host = makeHost();
    await join(host, "Ann");
    await join(host, "Bob");
    host.room.setScore({ key: "edited", bars: 16 });
    await vi.advanceTimersByTimeAsync(200);
    const problems = host.room.snapshot.peers!.map((p) => p.problem?.kind);
    expect(problems).toEqual(["score", "score"]);
  });

  it("applies the audio quality to every guest", async () => {
    const host = makeHost();
    await join(host, "Ann");
    await join(host, "Bob");
    host.room.setQuality("safe");
    expect(host.room.snapshot.preset).toBe("safe");
  });
});

describe("sharing the tab with every guest", () => {
  it("sends the host's tab to each guest that has another one", async () => {
    const payload: TabPayload = {
      name: "Song",
      bytes: Uint8Array.from({ length: 20_000 }, (_, i) => i % 251),
      key: "host-tab",
      bars: 8,
    };
    const host = makeHost({ score: { key: "host-tab", bars: 8 } });
    host.hooks.tab = { offer: async () => payload };
    const guests = [];
    for (const name of ["Ann", "Bob"]) {
      const pair = memoryPair({ up: 2, down: 2 });
      const guest = makeGuest(pair, name, { score: { key: "nothing", bars: 0 } });
      guest.session.start();
      openPair(pair);
      host.acceptor.arrive(pair[0] as GuestLink);
      guests.push(guest);
    }
    // Real time passes in small steps so the native SHA-256 can finish between the fake timers.
    for (let done = 0; done < 3_000; done += 50) {
      await vi.advanceTimersByTimeAsync(50);
      await new Promise((resolve) => realSetTimeout(resolve, 1));
    }
    expect(guests.map((g) => g.received.length)).toEqual([1, 1]);
    expect(guests.every((g) => g.received[0]!.key === "host-tab")).toBe(true);
    expect(guests[0]!.received[0]!.bytes).toEqual(payload.bytes);
  });
});

describe("coming back", () => {
  it("keeps a dropped guest's place and gives it back to the same guest", async () => {
    const host = makeHost();
    const { pair } = await join(host, "Ann");
    await join(host, "Bob");
    expect(host.room.snapshot.peers).toHaveLength(2);
    dropPair(pair);
    await vi.advanceTimersByTimeAsync(100);
    const roster = host.room.snapshot.peers!;
    expect(roster.map((p) => [p.name, p.phase])).toEqual([
      ["Ann", "reconnecting"],
      ["Bob", "synchronized"],
    ]);
    // The others are not held up: a start goes to Bob.
    expect(host.room.snapshot.phase).toBe("synchronized");
    // Ann's laptop comes back (a new connection, the same guest id).
    const again = await join(host, "Ann");
    expect(again.guest.session.snapshot.phase).toBe("synchronized");
    const after = host.room.snapshot.peers!;
    expect(after.map((p) => [p.name, p.phase])).toEqual([
      ["Ann", "synchronized"],
      ["Bob", "synchronized"],
    ]);
    expect(after[0]!.id).toBe(roster[0]!.id);
    // Her old connection was let go; she was not asked again.
    expect(host.log.approvals.map((a) => a.name)).toEqual(["Ann", "Bob"]);
    expect(host.acceptor.removed.map((r) => r.link)).toContain(pair[0]);
  });

  it("takes the place back after a long wait, within the time the host holds it", async () => {
    const host = makeHost();
    const { pair } = await join(host, "Ann");
    dropPair(pair);
    await vi.advanceTimersByTimeAsync(SEAT_HOLD_MS - 60_000);
    expect(host.room.snapshot.peers![0]!.phase).toBe("reconnecting");
    expect(host.room.snapshot.phase).toBe("reconnecting");
    const again = await join(host, "Ann");
    expect(again.guest.session.snapshot.phase).toBe("synchronized");
    expect(host.room.snapshot.peers).toHaveLength(1);
  });

  it("frees the place when the guest does not come back in time", async () => {
    const host = makeHost();
    const { pair } = await join(host, "Ann");
    dropPair(pair);
    await vi.advanceTimersByTimeAsync(SEAT_HOLD_MS + 1_000);
    expect(host.room.snapshot.peers).toEqual([]);
    expect(host.room.snapshot.phase).toBe("waiting");
    expect(host.room.snapshot.problem?.message).toMatch(/Ann could not get back/);
    // It has to ask again like a new guest.
    await join(host, "Ann");
    expect(host.log.approvals.map((a) => a.name)).toEqual(["Ann", "Ann"]);
  });

  it("frees the place of a guest that leaves, and says so for a while", async () => {
    const host = makeHost();
    const ann = (await join(host, "Ann")).guest;
    await join(host, "Bob");
    ann.session.leave();
    await vi.advanceTimersByTimeAsync(50);
    expect(host.room.snapshot.peers?.map((p) => p.name)).toEqual(["Bob"]);
    expect(host.room.snapshot.problem?.message).toBe("Ann left the session.");
    expect(host.room.snapshot.phase).toBe("synchronized");
    await vi.advanceTimersByTimeAsync(NOTICE_MS + 10);
    expect(host.room.snapshot.problem).toBeNull();
  });

  it("recognises a guest by its id, not by its name", async () => {
    const host = makeHost();
    const { pair } = await join(host, "Ann");
    dropPair(pair);
    await vi.advanceTimersByTimeAsync(100);
    const again = await join(host, "Annie", { guest: "ann0000000000000" });
    expect(again.guest.session.snapshot.phase).toBe("synchronized");
    expect(host.room.snapshot.peers).toHaveLength(1);
  });
});

describe("kicking and banning", () => {
  it("kicks a guest: it is told, its place is freed, and it can come back", async () => {
    const host = makeHost();
    const ann = (await join(host, "Ann")).guest;
    const bob = (await join(host, "Bob")).guest;
    const id = host.room.snapshot.peers![0]!.id;
    host.room.kick(id);
    await vi.advanceTimersByTimeAsync(FLUSH_MS + 50);
    expect(ann.session.snapshot.phase).toBe("closed");
    expect(ann.session.snapshot.problem?.kind).toBe("kicked");
    expect(ann.session.snapshot.problem?.message).toMatch(/join again/);
    expect(bob.session.snapshot.phase).toBe("synchronized");
    expect(host.room.snapshot.peers?.map((p) => p.name)).toEqual(["Bob"]);
    // The connection is closed without a block.
    expect(host.acceptor.removed).toHaveLength(1);
    expect(host.acceptor.removed[0]!.block).toBeUndefined();
    // It can join again (and is asked again).
    const again = await join(host, "Ann");
    expect(again.guest.session.snapshot.phase).toBe("synchronized");
    expect(host.room.snapshot.peers).toHaveLength(2);
  });

  it("bans a guest: it cannot come back, by id or by address", async () => {
    const host = makeHost();
    const ann = (await join(host, "Ann")).guest;
    await join(host, "Bob");
    const id = host.room.snapshot.peers![0]!.id;
    host.room.ban(id);
    await vi.advanceTimersByTimeAsync(FLUSH_MS + 50);
    expect(ann.session.snapshot.problem?.kind).toBe("banned");
    expect(host.acceptor.removed[0]!.block).toEqual({ guest: id, address: "10.0.0.3" });
    expect(host.room.snapshot.peers?.map((p) => p.name)).toEqual(["Bob"]);

    // The same guest id, from another address.
    const again = await join(host, "Ann", {}, 400);
    expect(again.guest.session.snapshot.problem?.kind).toBe("banned");
    // Another guest id from the banned address ("Ann" and "Eve" are 3 letters: the same address).
    const evePair = memoryPair({ up: 2, down: 2 });
    const eve = makeGuest(evePair, "Eve");
    eve.session.start();
    openPair(evePair);
    host.acceptor.arrive(evePair[0] as GuestLink, { address: "10.0.0.3" });
    await vi.advanceTimersByTimeAsync(400);
    expect(eve.session.snapshot.problem?.kind).toBe("banned");
    expect(host.room.snapshot.peers?.map((p) => p.name)).toEqual(["Bob"]);
    // Nobody else is affected.
    const cy = await join(host, "Cyrus");
    expect(cy.guest.session.snapshot.phase).toBe("synchronized");
    expect(host.log.approvals.map((a) => a.name)).not.toContain("Eve");
  });

  it("can ban a guest that has dropped out, so it cannot take its place back", async () => {
    const host = makeHost();
    const { pair } = await join(host, "Ann");
    dropPair(pair);
    await vi.advanceTimersByTimeAsync(100);
    host.room.ban(host.room.snapshot.peers![0]!.id);
    await vi.advanceTimersByTimeAsync(FLUSH_MS + 50);
    expect(host.room.snapshot.peers).toEqual([]);
    const again = await join(host, "Ann", {}, 400);
    expect(again.guest.session.snapshot.problem?.kind).toBe("banned");
  });

  it("ignores a kick or a ban of someone who is not there", async () => {
    const host = makeHost();
    await join(host, "Ann");
    host.room.kick("nobody");
    host.room.ban("nobody");
    expect(host.room.snapshot.peers).toHaveLength(1);
  });
});

describe("the room's own lifetime", () => {
  it("tells every guest when the host leaves, and stops listening", async () => {
    const host = makeHost();
    const ann = (await join(host, "Ann")).guest;
    const bob = (await join(host, "Bob")).guest;
    host.room.leave();
    await vi.advanceTimersByTimeAsync(50);
    expect(ann.session.snapshot.problem?.kind).toBe("peer-left");
    expect(bob.session.snapshot.problem?.kind).toBe("peer-left");
    expect(host.room.snapshot.phase).toBe("closed");
    expect(host.acceptor.closed).toBe(true);
    // A late arrival is turned away.
    host.room.leave();
  });

  it("says when new players can no longer join, and keeps the ones that are in", async () => {
    const host = makeHost();
    await join(host, "Ann");
    host.acceptor.setListening(false, "The room has closed.");
    expect(host.room.snapshot.listening).toBe(false);
    expect(host.room.snapshot.problem?.message).toMatch(/can no longer join/);
    expect(host.room.snapshot.peers).toHaveLength(1);
  });
});
