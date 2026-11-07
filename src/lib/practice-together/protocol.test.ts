import { describe, expect, it } from "vitest";

import {
  MAX_FRAME_CHARS,
  PROTOCOL_VERSION,
  decode,
  encode,
  negotiate,
  type Command,
  type Message,
} from "@/lib/practice-together/protocol";

const cmd: Command = {
  id: 7,
  action: "play",
  tick: 3840,
  at: 12_345.5,
  speed: 80,
  loop: { from: 2, to: 5 },
  metronome: true,
  countIn: true,
  countInBeats: 4,
};

const messages: Message[] = [
  {
    type: "hello",
    name: "Mark's MacBook",
    role: "guest",
    caps: ["transport"],
    score: { key: "abc", bars: 32 },
  },
  { type: "welcome", session: "K7P4", version: 1, name: "Host" },
  { type: "refuse", reason: "score" },
  { type: "ping", id: 1, t0: 10 },
  { type: "pong", id: 1, t0: 10, t1: 11, t2: 11.5 },
  { type: "cmd", cmd },
  { type: "cmd", cmd: { ...cmd, loop: null } },
  { type: "ready", id: 7, ok: false, reason: "late" },
  { type: "abort", id: 7, reason: "peer-late" },
  { type: "state", pos: 100, at: 5, playing: true },
  { type: "report", errorMs: 2.5, rtt: 4, driftMs: -1 },
  { type: "request", action: "play" },
  { type: "request", action: "seek", tick: 3840 },
  { type: "bye", reason: "left" },
];

describe("protocol", () => {
  it.each(messages)("round-trips a $type message", (msg) => {
    expect(decode(encode(msg, 3))).toEqual({ v: PROTOCOL_VERSION, n: 3, msg });
  });

  it.each([
    "",
    "not json",
    "null",
    "[]",
    '{"v":1,"n":1}',
    '{"v":1,"n":1,"msg":{"type":"nope"}}',
    '{"v":"1","n":1,"msg":{"type":"bye","reason":"x"}}',
    '{"v":1,"n":1,"msg":{"type":"ping","id":"1","t0":1}}',
    '{"v":1,"n":1,"msg":{"type":"cmd","cmd":{"id":1,"action":"explode"}}}',
    '{"v":1,"n":null,"msg":{"type":"bye","reason":"x"}}',
    '{"v":1,"n":1,"msg":{"type":"request","action":"settings"}}',
    '{"v":1,"n":1,"msg":{"type":"request","action":"play","tick":"3"}}',
  ])("drops a malformed frame: %s", (text) => {
    expect(decode(text)).toBeNull();
  });

  it("drops an oversized frame", () => {
    const big = encode({ type: "bye", reason: "x".repeat(MAX_FRAME_CHARS) }, 1);
    expect(decode(big)).toBeNull();
  });

  it("speaks the lower of two versions", () => {
    expect(negotiate(2, 1)).toBe(1);
    expect(negotiate(1, 3)).toBe(1);
  });
});
