import { describe, expect, it } from "vitest";

import { CAPABILITIES, decode, encode, type Message } from "./protocol";

const roundTrip = (msg: Message) => decode(encode(msg, 1))?.msg;

describe("sharing the tab: messages", () => {
  const offer: Message = {
    type: "tab-offer",
    id: 3,
    name: "Song",
    size: 20_000,
    chunks: 3,
    sha: "abc",
    key: "def",
    bars: 12,
  };

  it("are told to the other app as a capability", () => {
    expect(CAPABILITIES).toContain("tab");
  });

  it.each<Message>([
    offer,
    { type: "tab-chunk", id: 3, i: 0, data: "AAAA" },
    { type: "tab-ack", id: 3, n: 4 },
    { type: "tab-done", id: 3, ok: true },
    { type: "tab-done", id: 3, ok: false, reason: "unreadable" },
    { type: "tab-abort", id: 3, reason: "corrupt" },
  ])("round-trip: $type", (msg) => {
    expect(roundTrip(msg)).toEqual(msg);
  });

  it("a returning guest says so", () => {
    const hello: Message = {
      type: "hello",
      name: "G",
      role: "guest",
      caps: [...CAPABILITIES],
      score: { key: "k", bars: 1 },
      session: "s",
      resume: true,
    };
    expect(roundTrip(hello)).toEqual(hello);
  });

  it.each([
    { ...offer, size: "big" },
    { ...offer, key: 5 },
    { type: "tab-chunk", id: 1, i: "0", data: "A" },
    { type: "tab-chunk", id: 1, i: 0, data: 7 },
    { type: "tab-ack", id: 1 },
    { type: "tab-done", id: 1, ok: "yes" },
    { type: "tab-done", id: 1, ok: true, reason: 3 },
    { type: "tab-abort", id: 1 },
  ])("drop a malformed message: %j", (msg) => {
    expect(decode(JSON.stringify({ v: 1, n: 1, msg }))).toBeNull();
  });

  it("drop a piece that does not fit in a frame", () => {
    const text = encode({ type: "tab-chunk", id: 1, i: 0, data: "A".repeat(17_000) }, 1);
    expect(decode(text)).toBeNull();
  });
});
