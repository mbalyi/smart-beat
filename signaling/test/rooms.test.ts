import { describe, expect, it } from "vitest";
import {
  JOINED,
  MAX_AGE_MS,
  MAX_GUEST_MESSAGES,
  MAX_GUESTS,
  MAX_HOST_MESSAGES,
  MAX_MESSAGE,
  RoomState,
  TTL_MS,
} from "../src/rooms";

function pair(now = 0) {
  const room = new RoomState();
  const host = room.create(now, "host-token")!;
  const joined = room.join(now, "guest-token");
  if (typeof joined === "string") throw new Error(joined);
  return { room, host, guest: joined.token, peer: joined.peer };
}

describe("RoomState", () => {
  it("is made once and lets guests in, each at its own address", () => {
    const room = new RoomState();
    expect(room.create(0, "h")).toBe("h");
    expect(room.create(1, "other")).toBeNull();
    expect(room.join(1, "g1")).toEqual({ token: "g1", peer: "g1" });
    expect(room.join(2, "g2")).toEqual({ token: "g2", peer: "g2" });
    expect(room.hasGuest).toBe(true);
    expect(room.guestCount).toBe(2);
  });

  it("holds nine guests, ten players with the host, and then says it is full", () => {
    const room = new RoomState();
    room.create(0, "h");
    for (let i = 0; i < MAX_GUESTS; i += 1) {
      expect(room.join(1, `t${i}`, `0000000${i}`)).toMatchObject({ token: `t${i}` });
    }
    expect(MAX_GUESTS).toBe(9);
    expect(room.join(2, "late", "ffffffff")).toBe("full");
  });

  it("does not let anyone join a room that does not exist", () => {
    expect(new RoomState().join(0, "g")).toBe("unknown");
  });

  it("tells the host when a guest arrives", () => {
    const { room, host, peer } = pair();
    expect(room.read("host", host, 0, 1)).toEqual({
      messages: [JOINED],
      from: [peer],
      next: 1,
    });
  });

  it("carries messages to the other side, in order", () => {
    const { room, host, guest, peer } = pair();
    expect(room.send("host", host, "offer", 1, peer)).toBe("ok");
    expect(room.send("host", host, "candidate-1", 1, peer)).toBe("ok");
    expect(room.send("guest", guest, "answer", 2)).toBe("ok");
    expect(room.read("guest", guest, 0, 3)).toEqual({
      messages: ["offer", "candidate-1"],
      from: ["host", "host"],
      next: 2,
    });
    expect(room.read("host", host, 1, 3)).toEqual({
      messages: ["answer"],
      from: [peer],
      next: 2,
    });
  });

  it("keeps each guest's mail apart and tells the host who wrote", () => {
    const room = new RoomState();
    const host = room.create(0, "h")!;
    const a = room.join(0, "ta") as { token: string; peer: string };
    const b = room.join(0, "tb") as { token: string; peer: string };
    room.send("host", host, "for a", 1, a.peer);
    room.send("host", host, "for b", 1, b.peer);
    room.send("guest", b.token, "from b", 1);
    room.send("guest", a.token, "from a", 1);
    expect(room.read("guest", a.token, 0, 2)).toMatchObject({ messages: ["for a"] });
    expect(room.read("guest", b.token, 0, 2)).toMatchObject({ messages: ["for b"] });
    const mail = room.read("host", host, 2, 2);
    expect(mail).toMatchObject({ messages: ["from b", "from a"], from: [b.peer, a.peer] });
  });

  it("lets a host with one guest leave out the address, but not with several", () => {
    const { room, host } = pair();
    expect(room.send("host", host, "x", 1)).toBe("ok");
    room.join(1, "second");
    expect(room.send("host", host, "x", 1)).toBe("no-guest");
    expect(room.send("host", host, "x", 1, "g99")).toBe("no-guest");
  });

  it("reads only what is new", () => {
    const { room, host, guest, peer } = pair();
    room.send("host", host, "a", 1, peer);
    room.send("host", host, "b", 1, peer);
    expect(room.read("guest", guest, 1, 2)).toMatchObject({ messages: ["b"], next: 2 });
    expect(room.read("guest", guest, 2, 2)).toMatchObject({ messages: [], next: 2 });
    expect(room.read("guest", guest, -5, 2)).toMatchObject({ messages: ["a", "b"] });
  });

  it("refuses a wrong token or the other side's token", () => {
    const { room, host, guest } = pair();
    expect(room.send("host", "nope", "x", 1)).toBe("denied");
    expect(room.send("host", guest, "x", 1)).toBe("denied");
    expect(room.send("guest", host, "x", 1)).toBe("denied");
    expect(room.read("guest", host, 0, 1)).toBe("denied");
    expect(room.read("guest", "", 0, 1)).toBe("denied");
    expect(room.read("host", guest, 0, 1)).toBe("denied");
  });

  it("does not let a guest-less room be used as the guest", () => {
    const room = new RoomState();
    room.create(0, "h");
    expect(room.send("guest", "", "x", 1)).toBe("denied");
    expect(room.read("guest", "anything", 0, 1)).toBe("denied");
  });

  it("limits the size and the number of messages", () => {
    const { room, host, guest, peer } = pair();
    expect(room.send("host", host, "x".repeat(MAX_MESSAGE + 1), 1, peer)).toBe("too-big");
    expect(room.send("host", host, "x".repeat(MAX_MESSAGE), 1, peer)).toBe("ok");
    for (let i = 1; i < MAX_GUEST_MESSAGES; i += 1) room.send("host", host, "m", 1, peer);
    expect(room.send("host", host, "m", 1, peer)).toBe("full");
    // The host's mailbox (one slot is the arrival notice) has its own limit.
    for (let i = 1; i < MAX_HOST_MESSAGES; i += 1) room.send("guest", guest, "m", 1);
    expect(room.send("guest", guest, "m", 1)).toBe("full");
  });

  it("is gone ten minutes after the host was last heard, and the code can be used again", () => {
    const { room, host, guest, peer } = pair();
    expect(room.send("host", host, "x", TTL_MS - 1, peer)).toBe("ok");
    // That message moved the end of the room.
    expect(room.read("host", host, 0, 2 * TTL_MS - 2)).toMatchObject({ next: 1 });
    expect(room.send("host", host, "x", 3 * TTL_MS, peer)).toBe("gone");
    expect(room.read("guest", guest, 0, 3 * TTL_MS)).toBe("gone");
    expect(room.alive).toBe(false);
    expect(room.create(3 * TTL_MS + 1, "new")).toBe("new");
    expect(room.read("guest", guest, 0, 3 * TTL_MS + 2)).toBe("denied");
  });

  it("stays while the host keeps polling, up to twelve hours", () => {
    const { room, host } = pair();
    for (let t = 0; t < MAX_AGE_MS; t += 5 * 60 * 1000) {
      expect(room.read("host", host, 0, t)).not.toBe("gone");
    }
    expect(room.expiry).toBe(MAX_AGE_MS);
    expect(room.read("host", host, 0, MAX_AGE_MS)).toBe("gone");
  });

  it("is not kept alive by a guest alone", () => {
    const { room, guest } = pair();
    expect(room.read("guest", guest, 0, TTL_MS - 1)).not.toBe("gone");
    expect(room.read("guest", guest, 0, TTL_MS)).toBe("gone");
  });

  describe("coming back", () => {
    it("lets a guest with the same id take its place again, and stops its old token", () => {
      const room = new RoomState();
      room.create(0, "h");
      const first = room.join(1, "old", "abcdef01") as { token: string; peer: string };
      const again = room.join(5, "new", "abcdef01") as { token: string; peer: string };
      expect(again.peer).not.toBe(first.peer);
      expect(room.guestCount).toBe(1);
      expect(room.read("guest", "old", 0, 6)).toBe("denied");
      expect(room.read("guest", "new", 0, 6)).toMatchObject({ messages: [] });
    });

    it("takes the old place even when the room is full", () => {
      const room = new RoomState();
      room.create(0, "h");
      for (let i = 0; i < MAX_GUESTS; i += 1) room.join(1, `t${i}`, `1000000${i}`);
      expect(room.join(2, "back", "10000003")).toMatchObject({ token: "back" });
      expect(room.guestCount).toBe(MAX_GUESTS);
    });
  });

  describe("kicking and banning", () => {
    it("lets only the host remove a guest, and frees the place", () => {
      const { room, host, guest, peer } = pair();
      expect(room.kick(guest, peer, false, 1)).toBe("denied");
      expect(room.kick(host, "g404", false, 1)).toBe("unknown");
      expect(room.kick(host, peer, false, 1)).toBe("ok");
      expect(room.guestCount).toBe(0);
      expect(room.read("guest", guest, 0, 2)).toBe("denied");
    });

    it("lets a kicked guest join again", () => {
      const room = new RoomState();
      const host = room.create(0, "h")!;
      const first = room.join(1, "t1", "abcdef01") as { peer: string };
      room.kick(host, first.peer, false, 2);
      expect(room.join(3, "t2", "abcdef01")).toMatchObject({ token: "t2" });
    });

    it("turns a banned id away, but not another", () => {
      const room = new RoomState();
      const host = room.create(0, "h")!;
      const first = room.join(1, "t1", "abcdef01") as { peer: string };
      expect(room.kick(host, first.peer, true, 2)).toBe("ok");
      expect(room.join(3, "t2", "abcdef01")).toBe("banned");
      expect(room.join(3, "t3", "abcdef02")).toMatchObject({ token: "t3" });
    });

    it("cannot ban a guest that did not say its id, only remove it", () => {
      const room = new RoomState();
      const host = room.create(0, "h")!;
      const first = room.join(1, "t1") as { peer: string };
      expect(room.kick(host, first.peer, true, 2)).toBe("ok");
      expect(room.join(3, "t2")).toMatchObject({ token: "t2" });
    });
  });
});
