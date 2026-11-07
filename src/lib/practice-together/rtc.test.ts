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
import type { LinkState } from "@/lib/practice-together/transport";

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

/** Two signal ends joined by an in-memory mailbox, like the room: messages wait for a listener. */
function signals() {
  const listeners: Record<"host" | "guest", ((t: string) => void)[]> = { host: [], guest: [] };
  const mailbox: Record<"host" | "guest", string[]> = { host: [], guest: [] };
  const failed: Record<"host" | "guest", ((w: string) => void)[]> = { host: [], guest: [] };
  const sent: { from: string; text: string }[] = [];
  const left: string[] = [];
  const end = (me: "host" | "guest"): SignalApi => {
    const other = me === "host" ? "guest" : "host";
    return {
      create: async () => "ABCD-EFGH",
      join: async () => {},
      send: async (text) => {
        sent.push({ from: me, text });
        queueMicrotask(() => {
          if (listeners[other].length) listeners[other].forEach((l) => l(text));
          else mailbox[other].push(text);
        });
      },
      leave: async () => void left.push(me),
      onMessage: async (l) => {
        listeners[me].push(l);
        queueMicrotask(() => mailbox[me].splice(0).forEach((t) => l(t)));
        return () => void listeners[me].splice(listeners[me].indexOf(l), 1);
      },
      onFailed: async (l) => {
        failed[me].push(l);
        return () => void failed[me].splice(failed[me].indexOf(l), 1);
      },
    };
  };
  return { host: end("host"), guest: end("guest"), sent, left, failed };
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

async function connect() {
  const s = signals();
  const hostPeers: FakePeer[] = [];
  const guestPeers: FakePeer[] = [];
  const host = await hostOverInternet(env(s.host, hostPeers));
  const hostStates: LinkState[] = [];
  host.transport.onState((st) => hostStates.push(st));
  const guestTransport = await joinOverInternet(host.code, env(s.guest, guestPeers));
  const guestStates: LinkState[] = [];
  guestTransport.onState((st) => guestStates.push(st));
  await vi.advanceTimersByTimeAsync(50);
  return { s, host, hostPeers, hostStates, guest: guestTransport, guestPeers, guestStates };
}

describe("over the internet", () => {
  it("hands out a room code and uses only the public STUN server", async () => {
    const { host, hostPeers } = await connect();
    expect(host.code).toBe("ABCD-EFGH");
    expect(hostPeers[0]!.config.iceServers).toEqual([{ urls: STUN_URL }]);
  });

  it("connects the data channel and carries frames both ways", async () => {
    const { host, guest, hostStates, guestStates } = await connect();
    expect(hostStates).toContain("open");
    expect(guestStates).toContain("open");
    const heard: string[] = [];
    host.transport.onFrame((t) => heard.push(`host:${t}`));
    guest.onFrame((t) => heard.push(`guest:${t}`));
    guest.send("hello");
    host.transport.send("welcome");
    await vi.advanceTimersByTimeAsync(5);
    expect(heard.sort()).toEqual(["guest:welcome", "host:hello"]);
  });

  it("holds candidates until the description they belong to has arrived", async () => {
    const { guestPeers, hostPeers } = await connect();
    // The host's candidate came right behind its offer and was applied after it.
    expect(guestPeers[0]!.ice.map((c) => c.candidate)).toEqual([`cand-${hostPeers[0]!.id}`]);
  });

  it("only sends setup messages through the room", async () => {
    const { s } = await connect();
    const kinds = s.sent.map((m) => JSON.parse(m.text).k);
    expect(new Set(kinds)).toEqual(new Set(["offer", "answer", "ice"]));
  });

  it("gives up with an explanation when no direct connection can be made", async () => {
    const s = signals();
    const host = await hostOverInternet(env(s.host, []));
    const events: [LinkState, string | undefined][] = [];
    host.transport.onState((st, why) => events.push([st, why]));
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1);
    expect(events.at(-1)?.[0]).toBe("closed");
    expect(events.at(-1)?.[1]).toMatch(/firewall/);
    expect(s.left).toContain("host");
  });

  it("closes when the meeting room is gone before the connection opens", async () => {
    const s = signals();
    const host = await hostOverInternet(env(s.host, []));
    const events: LinkState[] = [];
    host.transport.onState((st) => events.push(st));
    s.failed.host.forEach((l) => l("The room has closed."));
    expect(events).toEqual(["closed"]);
  });

  it("ignores the room closing once the channel is open", async () => {
    const { s, hostStates } = await connect();
    s.failed.host.forEach((l) => l("The room has closed."));
    expect(hostStates).not.toContain("closed");
  });

  it("restarts the connection from the host when it fails", async () => {
    const { hostPeers, hostStates } = await connect();
    const peer = hostPeers[0]!;
    peer.connectionState = "failed";
    peer.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(5);
    expect(hostStates).toContain("reconnecting");
    expect(peer.offers.at(-1)).toEqual({ iceRestart: true });
  });

  it("leaves the room and closes the peer when closed", async () => {
    const { host, hostPeers, s } = await connect();
    host.transport.close();
    expect(hostPeers[0]!.closed).toBe(true);
    expect(s.left).toContain("host");
  });

  it("does not support WebRTC where the webview has none", () => {
    expect(rtcSupported()).toBe(false);
  });
});
