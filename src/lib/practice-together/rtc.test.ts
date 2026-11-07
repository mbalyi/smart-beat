import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONNECT_TIMEOUT_MS,
  STUN_URL,
  hostOverInternet,
  joinOverInternet,
  rtcSupported,
  type RtcEnv,
  type SignalApi,
} from "@/lib/practice-together/rtc";
import type { GuestLink, LinkState } from "@/lib/practice-together/transport";

let nextId = 1;

class FakeChannel {
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  other: FakeChannel | null = null;
  send(text: string) {
    const peer = this.other;
    if (this.readyState === "open" && peer) queueMicrotask(() => peer.onmessage?.({ data: text }));
  }
  close() {
    this.readyState = "closed";
    this.onclose?.();
    const peer = this.other;
    if (peer && peer.readyState === "open") {
      peer.readyState = "closed";
      peer.onclose?.();
    }
  }
}

/** Just enough of RTCPeerConnection: offers and answers are tags, and a channel opens when they meet. */
class FakePeer {
  static byAnswer = new Map<string, FakePeer>();
  id = nextId++;
  connectionState = "new";
  onicecandidate: ((e: { candidate: { toJSON(): RTCIceCandidateInit } | null }) => void) | null =
    null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((e: { channel: FakeChannel }) => void) | null = null;
  channel = new FakeChannel();
  remote: RTCSessionDescriptionInit | null = null;
  ice: RTCIceCandidateInit[] = [];
  offers: RTCOfferOptions[] = [];
  closed = false;

  readonly config: RTCConfiguration;
  constructor(config: RTCConfiguration) {
    this.config = config;
  }
  createDataChannel() {
    return this.channel;
  }
  async createOffer(options?: RTCOfferOptions) {
    this.offers.push(options ?? {});
    return { type: "offer" as const, sdp: `offer-${this.id}` };
  }
  async createAnswer() {
    return { type: "answer" as const, sdp: `answer-${this.id}` };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    if (description.type === "answer") FakePeer.byAnswer.set(description.sdp!, this);
    queueMicrotask(() => {
      this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: `cand-${this.id}` }) } });
      this.onicecandidate?.({ candidate: null });
    });
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remote = description;
    if (description.type === "answer") {
      const guest = FakePeer.byAnswer.get(description.sdp!)!;
      const mine = this.channel;
      const theirs = new FakeChannel();
      mine.other = theirs;
      theirs.other = mine;
      guest.ondatachannel?.({ channel: theirs });
      mine.readyState = theirs.readyState = "open";
      queueMicrotask(() => {
        theirs.onopen?.();
        mine.onopen?.();
      });
    }
  }
  async addIceCandidate(candidate: RTCIceCandidateInit) {
    if (!this.remote) throw new Error("no remote description yet");
    this.ice.push(candidate);
  }
  close() {
    this.closed = true;
  }
}

/**
 * The room, in memory: a host end and any number of guest ends. A guest that joins is announced to
 * the host (`joined`), like the Worker does; messages wait for a listener.
 */
function room() {
  type Mail = { text: string; from?: string };
  const host = {
    listeners: [] as ((t: string, from?: string) => void)[],
    box: [] as Mail[],
    failed: [] as ((w: string) => void)[],
  };
  const guests = new Map<
    string,
    { listeners: ((t: string) => void)[]; box: string[]; failed: ((w: string) => void)[] }
  >();
  const sent: { from: string; to?: string; text: string }[] = [];
  const left: string[] = [];
  const kicked: { peer: string; ban: boolean }[] = [];
  const joined: { peer: string; guest?: string }[] = [];
  let peers = 0;

  const toHost = (mail: Mail) =>
    queueMicrotask(() => {
      if (host.listeners.length) host.listeners.forEach((l) => l(mail.text, mail.from));
      else host.box.push(mail);
    });

  const hostEnd: SignalApi = {
    create: async () => "ABCD-EFGH",
    join: async () => {},
    send: async (text, to) => {
      sent.push({ from: "host", to, text });
      const guest = guests.get(to ?? "");
      if (!guest) return;
      queueMicrotask(() => {
        if (guest.listeners.length) guest.listeners.forEach((l) => l(text));
        else guest.box.push(text);
      });
    },
    kick: async (peer, ban) => void kicked.push({ peer, ban }),
    leave: async () => void left.push("host"),
    onMessage: async (l) => {
      host.listeners.push(l);
      queueMicrotask(() => host.box.splice(0).forEach((m) => l(m.text, m.from)));
      return () => void host.listeners.splice(host.listeners.indexOf(l), 1);
    },
    onFailed: async (l) => {
      host.failed.push(l);
      return () => void host.failed.splice(host.failed.indexOf(l), 1);
    },
  };

  /** A new guest end: it has not joined until its `join` runs. */
  const guestEnd = (): SignalApi => {
    peers += 1;
    const peer = `g${peers}`;
    const mine = {
      listeners: [] as ((t: string) => void)[],
      box: [] as string[],
      failed: [] as ((w: string) => void)[],
    };
    return {
      create: async () => "",
      join: async (_code, guest) => {
        guests.set(peer, mine);
        joined.push({ peer, guest });
        toHost({ text: JSON.stringify({ k: "joined" }), from: peer });
      },
      send: async (text) => {
        sent.push({ from: peer, text });
        toHost({ text, from: peer });
      },
      kick: async () => {},
      leave: async () => void left.push(peer),
      onMessage: async (l) => {
        mine.listeners.push(l);
        queueMicrotask(() => mine.box.splice(0).forEach((t) => l(t)));
        return () => void mine.listeners.splice(mine.listeners.indexOf(l), 1);
      },
      onFailed: async (l) => {
        mine.failed.push(l);
        return () => void mine.failed.splice(mine.failed.indexOf(l), 1);
      },
    };
  };
  return { host: hostEnd, guestEnd, sent, left, kicked, joined, hostFailed: host.failed, guests };
}

const env = (signal: SignalApi, made: FakePeer[]): RtcEnv => ({
  signal,
  createPeer: (config) => {
    const peer = new FakePeer(config);
    made.push(peer);
    return peer as unknown as RTCPeerConnection;
  },
});

beforeEach(() => {
  FakePeer.byAnswer.clear();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

/** A host and `count` guests that join, and the links the host got for them. */
async function connect(count = 1) {
  const r = room();
  const hostPeers: FakePeer[] = [];
  const host = await hostOverInternet(env(r.host, hostPeers));
  const links: GuestLink[] = [];
  const hostStates: LinkState[][] = [];
  host.acceptor.onGuest((link) => {
    links.push(link);
    const states: LinkState[] = [];
    hostStates.push(states);
    link.onState((st) => states.push(st));
  });
  const guests: Awaited<ReturnType<typeof joinOverInternet>>[] = [];
  const guestPeers: FakePeer[] = [];
  const guestStates: LinkState[][] = [];
  for (let i = 0; i < count; i += 1) {
    const guest = await joinOverInternet(
      host.code,
      env(r.guestEnd(), guestPeers),
      `0000000000000${i}ab`,
    );
    const states: LinkState[] = [];
    guestStates.push(states);
    guest.onState((st) => states.push(st));
    guests.push(guest);
  }
  await vi.advanceTimersByTimeAsync(50);
  return { r, host, hostPeers, links, hostStates, guests, guestPeers, guestStates };
}

describe("over the internet", () => {
  it("hands out a room code and uses only the public STUN server", async () => {
    const { host, hostPeers } = await connect();
    expect(host.code).toBe("ABCD-EFGH");
    expect(hostPeers[0]!.config.iceServers).toEqual([{ urls: STUN_URL }]);
  });

  it("tells the room which guest this app is, so it can come back to its place", async () => {
    const { r } = await connect();
    expect(r.joined).toEqual([{ peer: "g1", guest: "0000000000000" + "0ab" }]);
  });

  it("makes a connection when a guest joins, and carries frames both ways", async () => {
    const { links, guests, hostStates, guestStates } = await connect();
    expect(links).toHaveLength(1);
    expect(hostStates[0]).toContain("open");
    expect(guestStates[0]).toContain("open");
    expect(links[0]!.state).toBe("open");
    const heard: string[] = [];
    links[0]!.onFrame((t) => heard.push(`host:${t}`));
    guests[0]!.onFrame((t) => heard.push(`guest:${t}`));
    guests[0]!.send("hello");
    links[0]!.send("welcome");
    await vi.advanceTimersByTimeAsync(5);
    expect(heard.sort()).toEqual(["guest:welcome", "host:hello"]);
  });

  it("keeps several guests apart: each has its own connection and room address", async () => {
    const { links, guests, hostPeers, r } = await connect(3);
    expect(links).toHaveLength(3);
    expect(hostPeers).toHaveLength(3);
    const heard: string[][] = [[], [], []];
    links.forEach((link, i) => link.onFrame((t) => heard[i]!.push(t)));
    const got: string[][] = [[], [], []];
    guests.forEach((guest, i) => guest.onFrame((t) => got[i]!.push(t)));
    guests[1]!.send("from two");
    links[2]!.send("to three");
    await vi.advanceTimersByTimeAsync(5);
    expect(heard).toEqual([[], ["from two"], []]);
    expect(got).toEqual([[], [], ["to three"]]);
    // Each offer went to its own guest.
    const offers = r.sent.filter((m) => m.from === "host" && JSON.parse(m.text).k === "offer");
    expect(offers.map((m) => m.to)).toEqual(["g1", "g2", "g3"]);
  });

  it("holds candidates until the description they belong to has arrived", async () => {
    const { guestPeers, hostPeers } = await connect();
    // The host's candidate came right behind its offer and was applied after it.
    expect(guestPeers[0]!.ice.map((c) => c.candidate)).toEqual([`cand-${hostPeers[0]!.id}`]);
  });

  it("only sends setup messages through the room", async () => {
    const { r } = await connect();
    const kinds = r.sent.map((m) => JSON.parse(m.text).k);
    expect(new Set(kinds)).toEqual(new Set(["offer", "answer", "ice"]));
  });

  it("gives up on a guest with an explanation when no direct connection can be made", async () => {
    const r = room();
    const host = await hostOverInternet(env(r.host, []));
    const events: [LinkState, string | undefined][] = [];
    host.acceptor.onGuest((link) => link.onState((st, why) => events.push([st, why])));
    // A guest joins but never answers.
    const guest = r.guestEnd();
    await guest.join("ABCD-EFGH");
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1);
    expect(events.at(-1)?.[0]).toBe("closed");
    expect(events.at(-1)?.[1]).toMatch(/firewall/);
    // Its place in the room is freed, and the room stays for the others.
    expect(r.kicked).toEqual([{ peer: "g1", ban: false }]);
    expect(r.left).not.toContain("host");
  });

  it("closes a guest that is not connected yet when the meeting room is gone", async () => {
    const r = room();
    const host = await hostOverInternet(env(r.host, []));
    const events: LinkState[] = [];
    const listening: [boolean, string | undefined][] = [];
    host.acceptor.onListening((on, why) => listening.push([on, why]));
    host.acceptor.onGuest((link) => link.onState((st) => events.push(st)));
    await r.guestEnd().join("ABCD-EFGH");
    await vi.advanceTimersByTimeAsync(1);
    r.hostFailed.forEach((l) => l("The room has closed."));
    expect(events.at(-1)).toBe("closed");
    expect(listening).toEqual([[false, "The room has closed."]]);
  });

  it("ignores the room closing once a channel is open, and says no one else can join", async () => {
    const { r, hostStates, host } = await connect();
    const listening: boolean[] = [];
    host.acceptor.onListening((on) => listening.push(on));
    r.hostFailed.forEach((l) => l("The room has closed."));
    expect(hostStates[0]).not.toContain("closed");
    expect(listening).toEqual([false]);
  });

  it("restarts the connection from the host when it fails", async () => {
    const { hostPeers, hostStates } = await connect();
    const peer = hostPeers[0]!;
    peer.connectionState = "failed";
    peer.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(5);
    expect(hostStates[0]).toContain("reconnecting");
    expect(peer.offers.at(-1)).toEqual({ iceRestart: true });
  });

  it("removes one guest: its connection ends and the room frees its place", async () => {
    const { host, links, hostPeers, r } = await connect(2);
    host.acceptor.remove(links[0]!);
    expect(hostPeers[0]!.closed).toBe(true);
    expect(hostPeers[1]!.closed).toBe(false);
    expect(links[0]!.state).toBe("closed");
    expect(links[1]!.state).toBe("open");
    expect(r.kicked).toEqual([{ peer: "g1", ban: false }]);
    expect(r.left).not.toContain("host");
  });

  it("asks the room to turn a banned guest away", async () => {
    const { host, links, r } = await connect(2);
    host.acceptor.remove(links[1]!, { guest: "abc" });
    expect(r.kicked).toEqual([{ peer: "g2", ban: true }]);
  });

  it("leaves the room and closes every connection when the host closes", async () => {
    const { host, hostPeers, links, r } = await connect(2);
    host.acceptor.close();
    host.acceptor.close();
    expect(hostPeers.every((p) => p.closed)).toBe(true);
    expect(links.map((l) => l.state)).toEqual(["closed", "closed"]);
    expect(r.left.filter((who) => who === "host")).toHaveLength(1);
  });

  it("closes and leaves the room when a guest closes", async () => {
    const { guests, guestPeers, r } = await connect();
    guests[0]!.close();
    expect(guestPeers[0]!.closed).toBe(true);
    expect(r.left).toContain("g1");
  });

  it("does not support WebRTC where the webview has none", () => {
    expect(rtcSupported()).toBe(false);
  });
});
