import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { normalize, type Env } from "../src/index";
import { Room } from "../src/room";

/** A stand-in for the Durable Object namespace: one `Room` per name, in memory. */
function fakeRooms(): Env["ROOMS"] {
  const rooms = new Map<string, Room>();
  const state = { storage: { setAlarm: async () => {} } } as unknown as DurableObjectState;
  return {
    idFromName: (name: string) => name,
    get: (id: string) => {
      let room = rooms.get(id);
      if (!room) rooms.set(id, (room = new Room(state)));
      return {
        fetch: (input: string | URL, init?: RequestInit) => room!.fetch(new Request(input, init)),
      };
    },
  } as unknown as Env["ROOMS"];
}

let env: Env;
beforeEach(() => {
  env = { ROOMS: fakeRooms() };
});
afterEach(() => vi.useRealTimers());

const call = (path: string, init?: RequestInit) =>
  worker.fetch(new Request(`https://x.test${path}`, init), env);
const post = (path: string, body?: unknown) =>
  call(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

async function open() {
  const made = (await (await post("/v1/rooms")).json()) as { code: string; token: string };
  const joined = (await (await post(`/v1/rooms/${made.code}/join`)).json()) as {
    token: string;
    peer: string;
  };
  return { code: made.code, host: made.token, guest: joined.token, peer: joined.peer };
}

describe("rooms over HTTP", () => {
  it("makes a room with an 8-character code and a token", async () => {
    const res = await post("/v1/rooms");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; token: string };
    expect(body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(body.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("lets nine guests in and tells the tenth the room is full", async () => {
    const { code } = await open();
    for (let i = 0; i < 8; i += 1) expect((await post(`/v1/rooms/${code}/join`)).status).toBe(200);
    expect((await post(`/v1/rooms/${code}/join`)).status).toBe(409);
  });

  it("gives a returning guest its place back, even in a full room", async () => {
    const { code } = await open();
    const id = "abcdef0123456789";
    const first = (await (await post(`/v1/rooms/${code}/join`, { guest: id })).json()) as {
      peer: string;
    };
    for (let i = 0; i < 7; i += 1) await post(`/v1/rooms/${code}/join`);
    expect((await post(`/v1/rooms/${code}/join`)).status).toBe(409);
    const again = await post(`/v1/rooms/${code}/join`, { guest: id });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { peer: string }).peer).not.toBe(first.peer);
  });

  it("ignores a guest id that is not hex", async () => {
    const { code } = await open();
    const res = await post(`/v1/rooms/${code}/join`, { guest: "<script>" });
    expect(res.status).toBe(200);
  });

  it("lets the host remove and ban a guest", async () => {
    const { code, host, guest, peer } = await open();
    const id = "00112233aabbccdd";
    const other = (await (await post(`/v1/rooms/${code}/join`, { guest: id })).json()) as {
      peer: string;
    };
    // Only the host may.
    expect((await post(`/v1/rooms/${code}/kick`, { token: guest, peer: other.peer })).status).toBe(
      403,
    );
    expect(
      (await post(`/v1/rooms/${code}/kick`, { token: host, peer: other.peer, ban: true })).status,
    ).toBe(200);
    expect((await post(`/v1/rooms/${code}/join`, { guest: id })).status).toBe(403);
    expect((await post(`/v1/rooms/${code}/kick`, { token: host, peer: "g99" })).status).toBe(404);
    expect((await post(`/v1/rooms/${code}/kick`, { token: host })).status).toBe(400);
    // The first guest is still in.
    await post(`/v1/rooms/${code}/send`, { role: "host", token: host, to: peer, msg: "hi" });
    const got = await call(`/v1/rooms/${code}/poll?role=guest&token=${guest}&after=0`);
    expect(await got.json()).toMatchObject({ messages: ["hi"] });
  });

  it("does not know a room that was never made", async () => {
    expect((await post("/v1/rooms/ABCDEFGH/join")).status).toBe(404);
  });

  it("accepts a code typed with dashes and lower case", async () => {
    const { code } = await open();
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
    expect((await post(`/v1/rooms/${typed}/join`)).status).toBe(200);
    expect(normalize("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalize("o1il")).toBe("0111");
  });

  it("relays messages both ways, and tells the host who wrote", async () => {
    const { code, host, guest, peer } = await open();
    await post(`/v1/rooms/${code}/send`, { role: "host", token: host, to: peer, msg: "offer" });
    const got = await call(`/v1/rooms/${code}/poll?role=guest&token=${guest}&after=0`);
    expect(await got.json()).toMatchObject({
      messages: ["offer"],
      from: ["host"],
      next: 1,
      guest: true,
    });
    await post(`/v1/rooms/${code}/send`, { role: "guest", token: guest, msg: "answer" });
    const back = await call(`/v1/rooms/${code}/poll?role=host&token=${host}&after=0`);
    expect(await back.json()).toMatchObject({
      messages: ['{"k":"joined"}', "answer"],
      from: [peer, peer],
      guests: 1,
    });
  });

  it("keeps two guests' mail apart", async () => {
    const { code, host, guest, peer } = await open();
    const second = (await (await post(`/v1/rooms/${code}/join`)).json()) as {
      token: string;
      peer: string;
    };
    await post(`/v1/rooms/${code}/send`, { role: "host", token: host, to: second.peer, msg: "2" });
    await post(`/v1/rooms/${code}/send`, { role: "host", token: host, to: peer, msg: "1" });
    const mine = await call(`/v1/rooms/${code}/poll?role=guest&token=${guest}&after=0`);
    expect(await mine.json()).toMatchObject({ messages: ["1"] });
    const theirs = await call(`/v1/rooms/${code}/poll?role=guest&token=${second.token}&after=0`);
    expect(await theirs.json()).toMatchObject({ messages: ["2"] });
    expect(peer).not.toBe(second.peer);
  });

  it("wakes a waiting poll when a message arrives", async () => {
    const { code, host, guest, peer } = await open();
    const waiting = call(`/v1/rooms/${code}/poll?role=guest&token=${guest}&after=0`);
    await new Promise((r) => setTimeout(r, 20));
    await post(`/v1/rooms/${code}/send`, {
      role: "host",
      token: host,
      to: peer,
      msg: "late offer",
    });
    expect(await (await waiting).json()).toMatchObject({ messages: ["late offer"] });
  });

  it("answers an empty poll after twenty seconds", async () => {
    vi.useFakeTimers();
    const { code, guest } = await open();
    const waiting = call(`/v1/rooms/${code}/poll?role=guest&token=${guest}&after=0`);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await (await waiting).json()).toMatchObject({ messages: [], next: 0 });
  });

  it("refuses the wrong token and bad requests", async () => {
    const { code, host } = await open();
    expect(
      (await post(`/v1/rooms/${code}/send`, { role: "host", token: "x", msg: "m" })).status,
    ).toBe(403);
    expect(
      (await post(`/v1/rooms/${code}/send`, { role: "boss", token: host, msg: "m" })).status,
    ).toBe(400);
    expect((await post(`/v1/rooms/${code}/send`, { role: "host", token: host })).status).toBe(400);
    expect((await call(`/v1/rooms/${code}/poll?role=host&token=x&after=0`)).status).toBe(403);
    expect((await call(`/v1/rooms/${code}/poll?role=nope&token=${host}`)).status).toBe(400);
    expect((await post(`/v1/rooms/${code}/send`, "not json" as unknown)).status).toBe(400);
  });

  it("refuses a message that is too long", async () => {
    const { code, host } = await open();
    const res = await post(`/v1/rooms/${code}/send`, {
      role: "host",
      token: host,
      msg: "x".repeat(9000),
    });
    expect(res.status).toBe(413);
  });

  it("rejects bad codes, wrong methods and other paths", async () => {
    expect((await post("/v1/rooms/UUUUUUUU/join")).status).toBe(400);
    expect((await post("/v1/rooms/SHORT/join")).status).toBe(400);
    expect((await call("/v1/rooms/ABCDEFGH/join")).status).toBe(405);
    expect((await call("/v1/rooms")).status).toBe(404);
    expect((await call("/")).status).toBe(404);
  });
});
