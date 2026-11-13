import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CAPABILITIES, decode, encode } from "@/lib/practice-together/protocol";
import type { SourceMessage } from "@/lib/practice-together/protocol";
import { Session, type SessionHooks } from "@/lib/practice-together/session";
import { memoryPair, openPair } from "@/lib/practice-together/transport";

const SCORE = { key: "score-a", bars: 16 };
const ID = "a".repeat(64);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function pairWithSourceHooks() {
  const heard = { host: [] as SourceMessage[], guest: [] as SourceMessage[] };
  const base: SessionHooks = {
    prepare: async () => true,
    schedule: () => () => {},
    approve: async () => true,
  };
  const pair = memoryPair({ up: 1, down: 1 });
  const host = new Session({
    role: "host",
    transport: pair[0],
    name: "Host",
    score: SCORE,
    hooks: { ...base, source: { receive: (m) => heard.host.push(m) } },
    now: () => performance.now(),
  });
  const guest = new Session({
    role: "guest",
    transport: pair[1],
    name: "Guest",
    score: SCORE,
    hooks: { ...base, source: { receive: (m) => heard.guest.push(m) } },
    now: () => performance.now(),
  });
  host.start();
  guest.start();
  openPair(pair);
  return { host, guest, heard };
}

describe("audio file messages", () => {
  it("this app says it shares audio lanes", () => {
    expect(CAPABILITIES).toContain("lanes");
  });

  it("go both ways between the two sessions", async () => {
    const { host, guest, heard } = pairWithSourceHooks();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.peerLanes).toBe(true);
    // The guest learns it from the host's hello, or it would never send or ask for anything.
    expect(guest.peerLanes).toBe(true);
    guest.sendSource({ type: "src-want", id: ID });
    host.sendSource({ type: "src-offer", id: ID, size: 100 });
    host.sendSource({ type: "src-chunk", id: ID, off: 0, data: "AAAA" });
    await vi.advanceTimersByTimeAsync(50);
    expect(heard.host).toEqual([{ type: "src-want", id: ID }]);
    expect(heard.guest).toEqual([
      { type: "src-offer", id: ID, size: 100 },
      { type: "src-chunk", id: ID, off: 0, data: "AAAA" },
    ]);
    host.leave();
  });
});

describe("audio file messages are checked like every frame", () => {
  const wire = (msg: unknown) => decode(JSON.stringify({ v: 1, n: 1, msg }));

  it("accepts the good ones", () => {
    expect(decode(encode({ type: "src-have", ids: [ID] }, 1))).not.toBeNull();
    expect(decode(encode({ type: "src-ack", id: ID, n: 10, rewind: true }, 1))).not.toBeNull();
    expect(
      decode(encode({ type: "src-offer", id: ID, size: 0, refuse: "quota" }, 1)),
    ).not.toBeNull();
    expect(
      decode(encode({ type: "src-done", id: ID, ok: false, reason: "quota" }, 1)),
    ).not.toBeNull();
  });

  it("refuses ids that are not hashes, huge sizes and offsets, and too many ids", () => {
    expect(wire({ type: "src-want", id: "../../etc/passwd" })).toBeNull();
    expect(wire({ type: "src-want", id: "A".repeat(64) })).toBeNull();
    expect(wire({ type: "src-offer", id: ID, size: 1e12 })).toBeNull();
    expect(wire({ type: "src-offer", id: ID, size: -1 })).toBeNull();
    expect(wire({ type: "src-ack", id: ID, n: 1e12 })).toBeNull();
    expect(wire({ type: "src-chunk", id: ID, off: -5, data: "AA" })).toBeNull();
    expect(wire({ type: "src-chunk", id: ID, off: 0, data: "A".repeat(20_000) })).toBeNull();
    expect(wire({ type: "src-have", ids: Array.from({ length: 101 }, () => ID) })).toBeNull();
    expect(wire({ type: "src-have", ids: ["x"] })).toBeNull();
    expect(wire({ type: "src-done", id: ID, ok: "yes" })).toBeNull();
    // A size or an offset is a whole number of bytes.
    expect(wire({ type: "src-offer", id: ID, size: 10.5 })).toBeNull();
    expect(wire({ type: "src-ack", id: ID, n: 0.5 })).toBeNull();
    expect(wire({ type: "src-chunk", id: ID, off: 1.25, data: "AA" })).toBeNull();
    expect(wire({ type: "src-offer", id: ID, size: 0, refuse: "everything" })).toBeNull();
  });
});
