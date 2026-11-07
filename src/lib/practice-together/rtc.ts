/**
 * Practice together over the internet. The apps meet through a tiny signaling room
 * (`signaling/`, reached from Rust so the page's CSP stays closed), swap a WebRTC offer and
 * answer, and then talk directly over a data channel. Nothing but those setup messages passes
 * through the room. A host makes one connection (and one data channel) for each guest.
 */
import {
  onPracticeSignal,
  onPracticeSignalFailed,
  practiceSignalCreate,
  practiceSignalJoin,
  practiceSignalKick,
  practiceSignalLeave,
  practiceSignalSend,
} from "@/lib/tauri";
import type {
  Block,
  GuestAcceptor,
  GuestInfo,
  GuestLink,
  LinkState,
  PeerTransport,
} from "@/lib/practice-together/transport";

/** The public STUN server used to find this computer's address from outside (no TURN relay). */
export const STUN_URL = "stun:stun.cloudflare.com:3478";
/** The channel must open within this long, or the connection is called blocked. */
export const CONNECT_TIMEOUT_MS = 25_000;

/** How the page talks to the signaling room. The default goes through Rust. */
export interface SignalApi {
  create(): Promise<string>;
  /** `guest`: this app's stable id (to come back to its place, and for the host to ban it). */
  join(code: string, guest?: string): Promise<void>;
  /** A host names the guest (`to`, as it heard it in `onMessage`). */
  send(text: string, to?: string): Promise<void>;
  /** The host removes a guest from the room; with `ban`, its id can never come back. */
  kick(peer: string, ban: boolean): Promise<void>;
  leave(): Promise<void>;
  /** A host hears which guest wrote each message (`from`). */
  onMessage(listener: (text: string, from?: string) => void): Promise<() => void>;
  onFailed(listener: (why: string) => void): Promise<() => void>;
}

export const tauriSignal: SignalApi = {
  create: practiceSignalCreate,
  join: practiceSignalJoin,
  send: practiceSignalSend,
  kick: practiceSignalKick,
  leave: practiceSignalLeave,
  onMessage: onPracticeSignal,
  onFailed: onPracticeSignalFailed,
};

export interface RtcEnv {
  signal: SignalApi;
  createPeer(config: RTCConfiguration): RTCPeerConnection;
}

const defaultEnv: RtcEnv = {
  signal: tauriSignal,
  createPeer: (config) => new RTCPeerConnection(config),
};

/** Whether this webview can do WebRTC at all (some Linux webviews cannot). */
export const rtcSupported = (): boolean =>
  typeof RTCPeerConnection !== "undefined" &&
  typeof RTCPeerConnection.prototype.createDataChannel === "function";

type Setup =
  | { k: "offer"; sdp: string }
  | { k: "answer"; sdp: string }
  | { k: "ice"; c: RTCIceCandidateInit | null };

function parseSetup(text: string): Setup | null {
  try {
    const value = JSON.parse(text) as Setup;
    if (value && (value.k === "offer" || value.k === "answer") && typeof value.sdp === "string")
      return value;
    if (value && value.k === "ice") return value;
  } catch {
    // Not ours.
  }
  return null;
}

/** How one connection talks to the room. */
interface Wire {
  send(text: string): Promise<void>;
  /** The connection ends: a guest leaves the room, a host frees the guest's place. */
  leave(): void;
}

class RtcTransport implements GuestLink {
  /** Where the link stands: a host reads it when the first frame of a guest comes. */
  state: LinkState = "connecting";
  private readonly frames = new Set<(text: string) => void>();
  private readonly states = new Set<(state: LinkState, detail?: string) => void>();
  private readonly stops: (() => void)[] = [];
  private pc: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;
  private pendingIce: (RTCIceCandidateInit | null)[] = [];
  private remoteSet = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ended = false;
  private opened = false;

  private readonly env: RtcEnv;
  private readonly host: boolean;
  private readonly room: Wire;

  constructor(env: RtcEnv, host: boolean, wire: Wire) {
    this.env = env;
    this.host = host;
    this.room = wire;
    this.pc = env.createPeer({ iceServers: [{ urls: STUN_URL }] });
    this.wire();
  }

  private emit(state: LinkState, detail?: string) {
    this.state = state;
    for (const listener of [...this.states]) listener(state, detail);
  }

  private wire() {
    this.pc.onicecandidate = (event) => {
      void this.setup({ k: "ice", c: event.candidate ? event.candidate.toJSON() : null });
    };
    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (this.ended) return;
      if (state === "failed" || state === "disconnected") {
        this.emit("reconnecting", "the connection dropped");
        if (this.host && state === "failed") void this.offer(true);
      } else if (state === "connected" && this.opened && this.channel?.readyState === "open") {
        this.emit("open");
      }
    };
    if (this.host) {
      this.attach(this.pc.createDataChannel("practice", { ordered: true }));
    } else {
      this.pc.ondatachannel = (event) => this.attach(event.channel);
    }
  }

  private attach(channel: RTCDataChannel) {
    this.channel = channel;
    channel.onopen = () => {
      clearTimeout(this.timer);
      this.opened = true;
      this.emit("open");
    };
    channel.onclose = () => {
      if (!this.ended) this.emit("reconnecting", "the connection closed");
    };
    channel.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      for (const listener of [...this.frames]) listener(event.data);
    };
  }

  /** A guest starts listening to the room. Must run before the room is joined. */
  async listen() {
    this.stops.push(
      await this.env.signal.onMessage((text) => void this.receive(text)),
      await this.env.signal.onFailed((why) => this.roomFailed(why)),
    );
  }

  /** The room is gone or unreachable. Once the channel is open it is no longer needed. */
  roomFailed(why: string) {
    if (!this.opened) this.fail(why);
  }

  /** The host's first step: the offer. Also the way to restart a failed connection. */
  async offer(restart = false) {
    try {
      const offer = await this.pc.createOffer(restart ? { iceRestart: true } : undefined);
      await this.pc.setLocalDescription(offer);
      await this.setup({ k: "offer", sdp: offer.sdp ?? "" });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Could not start the connection.");
    }
  }

  /** Gives the connection `CONNECT_TIMEOUT_MS` to open. */
  expect() {
    this.emit("connecting");
    this.timer = setTimeout(
      () =>
        this.fail(
          "Could not connect directly. A strict firewall or network may be blocking it. Try the same network option, or another network.",
        ),
      CONNECT_TIMEOUT_MS,
    );
  }

  private async setup(message: Setup) {
    if (this.ended) return;
    try {
      await this.room.send(JSON.stringify(message));
    } catch (error) {
      if (!this.opened)
        this.fail(error instanceof Error ? error.message : "Could not reach the meeting service.");
    }
  }

  /** A setup message from the other end. */
  async receive(text: string) {
    const message = parseSetup(text);
    if (!message || this.ended) return;
    try {
      if (message.k === "ice") {
        if (message.c === null) return;
        if (!this.remoteSet) this.pendingIce.push(message.c);
        else await this.pc.addIceCandidate(message.c);
        return;
      }
      await this.pc.setRemoteDescription({ type: message.k, sdp: message.sdp });
      this.remoteSet = true;
      for (const c of this.pendingIce.splice(0)) if (c) await this.pc.addIceCandidate(c);
      if (message.k === "offer") {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        await this.setup({ k: "answer", sdp: answer.sdp ?? "" });
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "The connection setup failed.");
    }
  }

  private fail(why: string) {
    if (this.ended) return;
    this.release();
    this.emit("closed", why);
  }

  private release() {
    this.ended = true;
    clearTimeout(this.timer);
    for (const stop of this.stops.splice(0)) stop();
    try {
      this.channel?.close();
      this.pc.close();
    } catch {
      // Already closed.
    }
    this.room.leave();
  }

  send(text: string) {
    if (this.channel?.readyState === "open") this.channel.send(text);
  }

  close() {
    if (this.ended) return;
    this.release();
    this.emit("closed");
  }

  onFrame(listener: (text: string) => void) {
    this.frames.add(listener);
    return () => this.frames.delete(listener);
  }

  onState(listener: (state: LinkState, detail?: string) => void) {
    this.states.add(listener);
    return () => this.states.delete(listener);
  }
}

/** The host's room: a connection for every guest that joins it. */
class RtcHost implements GuestAcceptor {
  private readonly peers = new Map<string, RtcTransport>();
  private readonly arrivals = new Set<(link: GuestLink, info: GuestInfo) => void>();
  private readonly listening = new Set<(listening: boolean, detail?: string) => void>();
  private early: GuestLink[] = [];
  private readonly stops: (() => void)[] = [];
  private closed = false;

  private readonly env: RtcEnv;

  constructor(env: RtcEnv) {
    this.env = env;
  }

  /** Starts listening to the room. Must run before the room is made. */
  async listen() {
    this.stops.push(
      await this.env.signal.onMessage((text, from) => this.route(text, from)),
      await this.env.signal.onFailed((why) => this.lost(why)),
    );
  }

  private route(text: string, from?: string) {
    if (!from || this.closed) return;
    try {
      const value = JSON.parse(text) as { k?: unknown };
      if (value && value.k === "joined") return this.arrived(from);
    } catch {
      // Not ours.
    }
    void this.peers.get(from)?.receive(text);
  }

  /** A guest joined the room: start a connection to it. */
  private arrived(peer: string) {
    const transport = new RtcTransport(this.env, true, {
      send: (text) => this.env.signal.send(text, peer),
      // The connection ended: free the guest's place in the room.
      leave: () => {
        // (A guest the host removed has been freed, or banned, already.)
        if (this.peers.get(peer) !== transport) return;
        this.peers.delete(peer);
        if (!this.closed) void this.env.signal.kick(peer, false).catch(() => {});
      },
    });
    this.peers.set(peer, transport);
    if (this.arrivals.size === 0) this.early.push(transport);
    for (const listener of [...this.arrivals]) listener(transport, {});
    transport.expect();
    void transport.offer();
  }

  /** The room is gone: guests that are not connected yet cannot be; the connected ones stay. */
  private lost(why: string) {
    for (const transport of this.peers.values()) transport.roomFailed(why);
    for (const listener of [...this.listening]) listener(false, why);
  }

  onGuest(listener: (link: GuestLink, info: GuestInfo) => void) {
    this.arrivals.add(listener);
    for (const link of this.early.splice(0)) listener(link, {});
    return () => this.arrivals.delete(listener);
  }

  onListening(listener: (listening: boolean, detail?: string) => void) {
    this.listening.add(listener);
    return () => this.listening.delete(listener);
  }

  remove(link: GuestLink, block?: Block) {
    for (const [peer, transport] of this.peers) {
      if (transport !== link) continue;
      this.peers.delete(peer);
      // The room turns this guest's id away from now on (a ban), or just frees its place.
      void this.env.signal.kick(peer, block !== undefined).catch(() => {});
    }
    link.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const stop of this.stops.splice(0)) stop();
    for (const transport of [...this.peers.values()]) transport.close();
    this.peers.clear();
    void this.env.signal.leave().catch(() => {});
  }
}

/**
 * Makes a room and waits in it. Returns the acceptor (a connection for each guest that joins) and
 * the code to hand out.
 */
export async function hostOverInternet(
  env: RtcEnv = defaultEnv,
): Promise<{ acceptor: GuestAcceptor; code: string }> {
  const acceptor = new RtcHost(env);
  await acceptor.listen();
  try {
    const code = await env.signal.create();
    return { acceptor, code };
  } catch (error) {
    acceptor.close();
    throw error;
  }
}

/** Joins a room by its code. `guest` is this app's stable id. */
export async function joinOverInternet(
  code: string,
  env: RtcEnv = defaultEnv,
  guest?: string,
): Promise<PeerTransport> {
  const transport = new RtcTransport(env, false, {
    send: (text) => env.signal.send(text),
    leave: () => void env.signal.leave().catch(() => {}),
  });
  await transport.listen();
  try {
    await env.signal.join(code, guest);
    transport.expect();
    return transport;
  } catch (error) {
    transport.close();
    throw error;
  }
}
