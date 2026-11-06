import { describe, expect, it } from "vitest";
import { MAX_MESSAGE, MAX_MESSAGES, RoomState, TTL_MS } from "../src/rooms";

function pair(now = 0) {
  const room = new RoomState();
  const host = room.create(now, "host-token")!;
  const guest = room.join(now, "guest-token") as string;
  return { room, host, guest };
}

describe("RoomState", () => {
  it("is made once and lets one guest in", () => {
    const room = new RoomState();
    expect(room.create(0, "h")).toBe("h");
    expect(room.create(1, "other")).toBeNull();
    expect(room.join(1, "g")).toBe("g");
    expect(room.join(2, "g2")).toBe("full");
    expect(room.hasGuest).toBe(true);
  });

  it("does not let anyone join a room that does not exist", () => {
    expect(new RoomState().join(0, "g")).toBe("unknown");
  });

  it("carries messages to the other side, in order", () => {
    const { room, host, guest } = pair();
    expect(room.send("host", host, "offer", 1)).toBe("ok");
    expect(room.send("host", host, "candidate-1", 1)).toBe("ok");
    expect(room.send("guest", guest, "answer", 2)).toBe("ok");
    expect(room.read("guest", guest, 0, 3)).toEqual({
      messages: ["offer", "candidate-1"],
      next: 2,
    });
    expect(room.read("host", host, 0, 3)).toEqual({ messages: ["answer"], next: 1 });
  });

  it("reads only what is new", () => {
    const { room, host, guest } = pair();
    room.send("host", host, "a", 1);
    room.send("host", host, "b", 1);
    expect(room.read("guest", guest, 1, 2)).toEqual({ messages: ["b"], next: 2 });
    expect(room.read("guest", guest, 2, 2)).toEqual({ messages: [], next: 2 });
    expect(room.read("guest", guest, -5, 2)).toMatchObject({ messages: ["a", "b"] });
  });

  it("refuses a wrong token or the other side's token", () => {
    const { room, host, guest } = pair();
    expect(room.send("host", "nope", "x", 1)).toBe("denied");
    expect(room.send("host", guest, "x", 1)).toBe("denied");
    expect(room.read("guest", host, 0, 1)).toBe("denied");
    expect(room.read("guest", "", 0, 1)).toBe("denied");
  });

  it("does not let a guest-less room be used as the guest", () => {
    const room = new RoomState();
    room.create(0, "h");
    expect(room.send("guest", "", "x", 1)).toBe("denied");
    expect(room.read("guest", "anything", 0, 1)).toBe("denied");
  });

  it("limits the size and the number of messages", () => {
    const { room, host } = pair();
    expect(room.send("host", host, "x".repeat(MAX_MESSAGE + 1), 1)).toBe("too-big");
    expect(room.send("host", host, "x".repeat(MAX_MESSAGE), 1)).toBe("ok");
    for (let i = 1; i < MAX_MESSAGES; i += 1) room.send("host", host, "m", 1);
    expect(room.send("host", host, "m", 1)).toBe("full");
  });

  it("is gone after ten minutes, and the code can be used again", () => {
    const { room, host, guest } = pair();
    expect(room.send("host", host, "x", TTL_MS - 1)).toBe("ok");
    expect(room.send("host", host, "x", TTL_MS)).toBe("gone");
    expect(room.read("guest", guest, 0, TTL_MS)).toBe("gone");
    expect(room.alive).toBe(false);
    expect(room.create(TTL_MS + 1, "new")).toBe("new");
    expect(room.read("guest", guest, 0, TTL_MS + 2)).toBe("denied");
  });
});
