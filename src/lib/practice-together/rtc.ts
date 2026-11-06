/**
 * Practice together over the internet. The two apps meet through a tiny signaling room
 * (`signaling/`, reached from Rust so the page's CSP stays closed), swap a WebRTC offer and
 * answer, and then talk directly over a data channel. Nothing but those setup messages passes
 * through the room.
 */
import {
  onPracticeSignal,
  onPracticeSignalFailed,
  practiceSignalCreate,
  practiceSignalJoin,
  practiceSignalLeave,
  practiceSignalSend,
} from "@/lib/tauri";
import type { LinkState, PeerTransport } from "@/lib/practice-together/transport";

/** The public STUN server used to find this computer's address from outside (no TURN relay). */
export const STUN_URL = "stun:stun.cloudflare.com:3478";
/** The channel must open within this long, or the connection is called blocked. */
export const CONNECT_TIMEOUT_MS = 25_000;

/** How the page talks to the signaling room. The default goes through Rust. */
export interface SignalApi {
  create(): Promise<string>;
  join(code: string): Promise<void>;
  send(text: string): Promise<void>;
  leave(): Promise<void>;
  onMessage(listener: (text: string) => void): Promise<() => void>;
  onFailed(listener: (why: string) => void): Promise<() => void>;
}

export const tauriSignal: SignalApi = {
  create: practiceSignalCreate,
  join: practiceSignalJoin,
  send: practiceSignalSend,
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

class RtcTransport implements PeerTransport {
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

  constructor(env: RtcEnv, host: boolean) {
    this.env = env;
    this.host = host;
    this.pc = env.createPeer({ iceServers: [{ urls: STUN_URL }] });
    this.wire();
  }

  private emit(state: LinkState, detail?: string) {
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

  /** Starts listening to the room. Must run before the room is made or joined. */
  async listen() {
    this.stops.push(
      await this.env.signal.onMessage((text) => void this.receive(text)),
      await this.env.signal.onFailed((why) => {
        // Once the channel is open the room is no longer needed.
        if (!this.opened) this.fail(why);
      }),
    );
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
      await this.env.signal.send(JSON.stringify(message));
    } catch (error) {
      if (!this.opened)
        this.fail(error instanceof Error ? error.message : "Could not reach the meeting service.");
    }
  }

  private async receive(text: string) {
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
    void this.env.signal.leave().catch(() => {});
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

/** Makes a room and waits in it. Returns the transport (it opens when the guest arrives) and the code. */
export async function hostOverInternet(
  env: RtcEnv = defaultEnv,
): Promise<{ transport: PeerTransport; code: string }> {
  const transport = new RtcTransport(env, true);
  await transport.listen();
  try {
    const code = await env.signal.create();
    transport.expect();
    await transport.offer();
    return { transport, code };
  } catch (error) {
    transport.close();
    throw error;
  }
}

/** Joins a room by its code. */
export async function joinOverInternet(
  code: string,
  env: RtcEnv = defaultEnv,
): Promise<PeerTransport> {
  const transport = new RtcTransport(env, false);
  await transport.listen();
  try {
    await env.signal.join(code);
    transport.expect();
    return transport;
  } catch (error) {
    transport.close();
    throw error;
  }
}
