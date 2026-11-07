import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decode, MAX_TAB_BYTES, TAB_CHUNK_BYTES } from "@/lib/practice-together/protocol";
import {
  OFFER_DEBOUNCE_MS,
  Session,
  type SessionHooks,
  type SessionOptions,
  type TabHooks,
} from "@/lib/practice-together/session";
import type { ReceivedTab, TabPayload } from "@/lib/practice-together/tab-transfer";
import { memoryPair, openPair, type PeerTransport } from "@/lib/practice-together/transport";

const realSetTimeout = globalThis.setTimeout;
const HOST_SCORE = { key: "host-tab", bars: 8 };
const NO_TAB = { key: "nothing-yet", bars: 0 };

const payload = (key = HOST_SCORE.key, length = TAB_CHUNK_BYTES * 3 + 11): TabPayload => ({
  name: "Smoke on the Water",
  bytes: Uint8Array.from({ length }, (_, i) => (i * 13 + key.length) % 256),
  key,
  bars: 8,
});

interface Side {
  session: Session;
  received: ReceivedTab[];
  opened: number;
  offers: number;
  playing: boolean;
  current: TabPayload;
  receiveResult: string | null;
}

function side(
  transport: PeerTransport,
  role: "host" | "guest",
  extra: Partial<SessionOptions> = {},
  withTab = true,
): Side {
  const state: Side = {
    session: undefined as unknown as Session,
    received: [],
    opened: 0,
    offers: 0,
    playing: false,
    current: payload(),
    receiveResult: null,
  };
  const tab: TabHooks =
    role === "host"
      ? {
          offer: async () => {
            state.offers += 1;
            return state.current;
          },
        }
      : {
          receive: async (t) => {
            state.received.push(t);
            return state.receiveResult;
          },
          opened: () => {
            state.opened += 1;
          },
        };
  const hooks: SessionHooks = {
    prepare: async () => true,
    schedule: () => () => {},
    approve: async () => true,
    position: () => ({ pos: 0, playing: state.playing }),
    ...(withTab && { tab }),
  };
  state.session = new Session({
    role,
    transport,
    name: role === "host" ? "Host" : "Guest",
    score: role === "host" ? HOST_SCORE : NO_TAB,
    hooks,
    ...extra,
  });
  return state;
}

/** Real time passes in small steps so the native SHA-256 can finish between the fake timers. */
async function settle(ms: number) {
  for (let done = 0; done < ms; done += 50) {
    await vi.advanceTimersByTimeAsync(50);
    await new Promise((resolve) => realSetTimeout(resolve, 1));
  }
}

function connect(guestScore = NO_TAB, hostExtra: Partial<SessionOptions> = {}, latency = 2) {
  const pair = memoryPair({ up: latency, down: latency });
  const host = side(pair[0], "host", hostExtra);
  const guest = side(pair[1], "guest", { score: guestScore });
  host.session.start();
  guest.session.start();
  openPair(pair);
  return { pair, host, guest };
}

/** The frames a transport sends, as the other end will read them. */
function spied(inner: PeerTransport, log: string[], tamper?: (text: string) => string) {
  return {
    send: (text: string) => {
      log.push(text);
      inner.send(tamper ? tamper(text) : text);
    },
    close: () => inner.close(),
    onFrame: (l: (text: string) => void) => inner.onFrame(l),
    onState: (l: Parameters<PeerTransport["onState"]>[0]) => inner.onState(l),
  } satisfies PeerTransport;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a guest without the tab", () => {
  it("receives the host's tab, whole and checked, and the session goes on", async () => {
    const { host, guest } = connect();
    await settle(2_500);

    expect(guest.received).toHaveLength(1);
    const [tab] = guest.received;
    expect(tab).toMatchObject({
      name: "Smoke on the Water",
      key: "host-tab",
      bars: 8,
      from: "Host",
    });
    expect(tab?.bytes).toEqual(host.current.bytes);
    expect(guest.opened).toBe(1);
    // The host knows the guest has this version, so nothing blocks Play.
    expect(host.session.snapshot.problem).toBeNull();
    expect(host.session.snapshot.transfer ?? null).toBeNull();
    expect(guest.session.snapshot.transfer ?? null).toBeNull();
  });

  it("shows progress on both ends while the pieces are on the way", async () => {
    const { host, guest } = connect();
    const hostSeen: number[] = [];
    const guestSeen: number[] = [];
    host.session.subscribe((s) => s.transfer && hostSeen.push(s.transfer.done));
    guest.session.subscribe((s) => s.transfer && guestSeen.push(s.transfer.done));
    await settle(2_500);

    expect(hostSeen.length).toBeGreaterThan(1);
    expect(hostSeen.at(-1)).toBe(4);
    expect(guestSeen.at(-1)).toBe(4);
  });

  it("is not sent a tab it already has", async () => {
    const pair = memoryPair({ up: 2 });
    const log: string[] = [];
    const host = side(spied(pair[0], log), "host");
    const guest = side(pair[1], "guest", { score: HOST_SCORE });
    host.session.start();
    guest.session.start();
    openPair(pair);
    await settle(2_500);

    expect(guest.received).toHaveLength(0);
    expect(host.offers).toBe(0);
    expect(log.some((t) => decode(t)?.msg.type === "tab-offer")).toBe(false);
    expect(host.session.snapshot.problem).toBeNull();
  });

  it("is told so when the tab is too big", async () => {
    const { host, guest } = connect();
    host.current = payload("host-tab", MAX_TAB_BYTES + 1);
    await settle(2_500);

    expect(guest.received).toHaveLength(0);
    expect(host.session.snapshot.problem).toMatchObject({ kind: "tab", fatal: false });
    expect(host.session.snapshot.problem?.message).toMatch(/too big/);
  });

  it("refuses a piece that was damaged on the way and says so on both ends", async () => {
    const pair = memoryPair({ up: 2 });
    const log: string[] = [];
    // The same text length, but different bytes: only the checksum can tell.
    const damaged = (text: string) => {
      const frame = decode(text);
      if (frame?.msg.type !== "tab-chunk" || frame.msg.i !== 1) return text;
      const flipped = frame.msg.data.startsWith("A") ? "B" : "A";
      return text.replace(frame.msg.data, flipped + frame.msg.data.slice(1));
    };
    const host = side(spied(pair[0], log, damaged), "host");
    const guest = side(pair[1], "guest", { score: NO_TAB });
    host.session.start();
    guest.session.start();
    openPair(pair);
    await settle(2_500);

    expect(guest.received).toHaveLength(0);
    expect(guest.opened).toBe(0);
    expect(guest.session.snapshot.problem).toMatchObject({ kind: "tab" });
    expect(guest.session.snapshot.problem?.message).toMatch(/damaged/);
    expect(host.session.snapshot.problem?.kind).toBe("tab");
    // The host does not keep offering the same thing forever.
    expect(host.offers).toBeLessThanOrEqual(2);
  });

  it("says so when the app could not open the tab", async () => {
    const pair = memoryPair({ up: 2 });
    const host = side(pair[0], "host");
    const guest = side(pair[1], "guest", { score: NO_TAB });
    guest.receiveResult = "unreadable";
    host.session.start();
    guest.session.start();
    openPair(pair);
    await settle(2_500);

    expect(guest.opened).toBe(0);
    expect(guest.session.snapshot.problem?.message).toMatch(/could not be opened/);
    expect(host.session.snapshot.problem?.kind).toBe("tab");
  });

  it("is still refused by a host that cannot share tabs", async () => {
    const pair = memoryPair({ up: 2 });
    const host = side(pair[0], "host", {}, false);
    const guest = side(pair[1], "guest", { score: NO_TAB });
    host.session.start();
    guest.session.start();
    openPair(pair);
    await settle(200);
    expect(guest.session.snapshot.phase).toBe("failed");
    expect(guest.session.snapshot.problem?.kind).toBe("score");
  });

  it("stops the transfer when the guest leaves in the middle", async () => {
    // A big tab on a slow line: after the offer went out, before the last piece is acknowledged.
    const { host, guest } = connect(NO_TAB, {}, 50);
    host.current = payload("host-tab", TAB_CHUNK_BYTES * 40);
    await settle(300);
    expect(host.session.snapshot.transfer).not.toBeNull();
    guest.session.leave();
    await settle(200);
    expect(host.session.snapshot.transfer ?? null).toBeNull();
    expect(host.session.snapshot.phase).toBe("waiting");
  });

  it("stops the transfer when the host leaves in the middle", async () => {
    const { host, guest } = connect(NO_TAB, {}, 50);
    host.current = payload("host-tab", TAB_CHUNK_BYTES * 40);
    await settle(300);
    expect(guest.session.snapshot.transfer).not.toBeNull();
    host.session.leave();
    await settle(200);
    expect(guest.session.snapshot.transfer ?? null).toBeNull();
    expect(guest.received).toHaveLength(0);
  });
});

describe("the host edits the tab", () => {
  it("sends the new version a moment after the last edit, once the guest has the first", async () => {
    const { host, guest } = connect();
    await settle(2_500);
    expect(guest.received).toHaveLength(1);

    host.current = payload("host-tab-v2", TAB_CHUNK_BYTES + 5);
    host.session.setScore({ key: "host-tab-v2", bars: 9 });
    // A second edit right after: still one version goes out.
    await settle(OFFER_DEBOUNCE_MS / 2);
    host.session.setScore({ key: "host-tab-v2", bars: 9 });
    expect(guest.received).toHaveLength(1);
    await settle(OFFER_DEBOUNCE_MS + 500);

    expect(guest.received).toHaveLength(2);
    expect(guest.received[1]).toMatchObject({ key: "host-tab-v2", bars: 8 });
    expect(host.session.snapshot.problem).toBeNull();
  });

  it("waits while the host plays and sends when it stops", async () => {
    const { host, guest } = connect();
    await settle(2_500);
    host.playing = true;
    host.current = payload("host-tab-v2", 2_000);
    host.session.setScore({ key: "host-tab-v2", bars: 9 });
    await settle(OFFER_DEBOUNCE_MS + 2_000);
    expect(guest.received).toHaveLength(1);

    host.playing = false;
    await settle(1_500);
    expect(guest.received).toHaveLength(2);
  });

  it("queues an edit made during a transfer", async () => {
    const { host, guest } = connect(NO_TAB, {}, 50);
    host.current = payload("host-tab", TAB_CHUNK_BYTES * 40);
    await settle(300);
    host.current = payload("host-tab-v3", 3_000);
    host.session.setScore({ key: "host-tab-v3", bars: 9 });
    await settle(6_000);
    expect(guest.received.map((t) => t.key)).toEqual(["host-tab", "host-tab-v3"]);
  });
});

describe("a guest that moves to the tab it received", () => {
  it("is welcomed again on the same connection, without the host seeing it leave", async () => {
    const { pair, host, guest } = connect();
    await settle(2_500);
    const hostEvents: string[] = [];
    host.session.subscribe((s) => hostEvents.push(s.phase));
    const before = host.session.snapshot.session;

    const { transport, session, peerName } = guest.session.release();
    expect(session).toBe(before);
    expect(peerName).toBe("Host");
    expect(guest.session.snapshot.phase).toBe("closed");

    // The new tab's workspace starts its own session on the connection that was left.
    const next = side(transport, "guest", { score: HOST_SCORE, resume: session ?? undefined });
    next.session.start("open");
    await settle(2_500);

    expect(hostEvents).not.toContain("waiting");
    expect(hostEvents).not.toContain("closed");
    expect(host.session.snapshot.session).toBe(before);
    expect(host.session.snapshot.phase).toBe("synchronized");
    expect(host.session.snapshot.problem).toBeNull();
    expect(next.session.snapshot.phase).toBe("synchronized");
    expect(next.session.snapshot.peerName).toBe("Host");
    expect(host.offers).toBe(1);
    expect(pair[1]).toBe(transport);
  });

  it("is not taken for a new guest when it says it is the one that was welcomed", async () => {
    const { guest } = connect();
    await settle(2_500);
    const { transport } = guest.session.release();
    // Without the session id the host sees a stranger and answers "busy".
    const stranger = side(transport, "guest", { score: HOST_SCORE, name: "Someone else" });
    stranger.session.start("open");
    await settle(300);
    expect(stranger.session.snapshot.problem?.kind).toBe("busy");
  });
});
