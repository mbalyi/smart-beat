/**
 * Practice together: what a connection to the other app looks like to the session. A LAN
 * socket (Rust) and a WebRTC data channel both fit this, so the session does not care which.
 */

export type LinkState = "connecting" | "open" | "reconnecting" | "closed";

export interface PeerTransport {
  /** Sends one frame. Frames sent while the link is not open are dropped. */
  send(text: string): void;
  /** Ends the connection for good. */
  close(): void;
  /** Frames that arrive. Returns a function that stops listening. */
  onFrame(listener: (text: string) => void): () => void;
  /** The link going up or down. Returns a function that stops listening. */
  onState(listener: (state: LinkState, detail?: string) => void): () => void;
}

/** One guest's connection, as the host first sees it. */
export interface GuestLink extends PeerTransport {
  readonly state: LinkState;
}

/** What the host knows of a guest from the way it connected. */
export interface GuestInfo {
  /** Where it connected from (the same network only). */
  address?: string;
}

/** Who may be turned away from now on. */
export interface Block {
  guest?: string;
  address?: string;
}

/**
 * The host's side of "listening": new guests arrive here, each as a connection of its own. The
 * session decides who stays; this only carries the bytes and can end one guest's connection.
 */
export interface GuestAcceptor {
  /** A guest connected (it has not said hello yet). Returns a function that stops listening. */
  onGuest(listener: (link: GuestLink, info: GuestInfo) => void): () => void;
  /**
   * Ends one guest's connection. With `block`, that guest (or its address) is turned away from
   * now on where the transport can do it.
   */
  remove(link: GuestLink, block?: Block): void;
  /** Whether new guests can still arrive (an internet room can be lost while guests stay). */
  onListening(listener: (listening: boolean, detail?: string) => void): () => void;
  /** Stops listening and ends every connection. */
  close(): void;
}

/**
 * Two connected in-memory ends, for tests and for the browser (e2e) build. `latency` is the
 * one-way delay in milliseconds and may differ per direction.
 */
export function memoryPair(
  latency: { up?: number; down?: number } = {},
): [PeerTransport, PeerTransport] {
  class End implements PeerTransport {
    peer!: End;
    private frames = new Set<(text: string) => void>();
    private states = new Set<(state: LinkState, detail?: string) => void>();
    state: LinkState = "connecting";
    private readonly delay: number;
    constructor(delay: number) {
      this.delay = delay;
    }

    send(text: string) {
      if (this.state !== "open") return;
      setTimeout(() => this.peer.receive(text), this.delay);
    }
    receive(text: string) {
      // Frames already on the wire still arrive when the other end has just left.
      if (this.state === "closed") return;
      for (const listener of [...this.frames]) listener(text);
    }
    close() {
      this.set("closed");
      // The other end only learns the line went quiet; a "bye" tells it the rest.
      this.peer.set("reconnecting", "peer left");
    }
    set(state: LinkState, detail?: string) {
      this.state = state;
      for (const listener of [...this.states]) listener(state, detail);
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
  const a = new End(latency.up ?? 0);
  const b = new End(latency.down ?? latency.up ?? 0);
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** Opens a pair made by `memoryPair`. */
export function openPair(pair: [PeerTransport, PeerTransport]) {
  for (const end of pair) (end as unknown as { set(s: LinkState): void }).set("open");
}

/** Drops a pair made by `memoryPair`, as a network failure would (they may come back). */
export function dropPair(pair: [PeerTransport, PeerTransport]) {
  const ends = pair as unknown as { set(s: LinkState, d?: string): void }[];
  for (const end of ends) end.set("reconnecting", "connection lost");
}

/**
 * A host's listening side for tests and the browser (e2e) build: guests arrive when the test says
 * so (`arrive`), and what the host does to them is recorded.
 */
export function memoryAcceptor() {
  const arrivals = new Set<(link: GuestLink, info: GuestInfo) => void>();
  const listening = new Set<(listening: boolean, detail?: string) => void>();
  const removed: { link: GuestLink; block?: Block }[] = [];
  let closed = false;
  const acceptor: GuestAcceptor = {
    onGuest(listener) {
      arrivals.add(listener);
      return () => arrivals.delete(listener);
    },
    remove(link, block) {
      removed.push({ link, block });
      link.close();
    },
    onListening(listener) {
      listening.add(listener);
      return () => listening.delete(listener);
    },
    close() {
      closed = true;
    },
  };
  return {
    acceptor,
    /** A guest connects (its link: an end of a {@link memoryPair}). */
    arrive(link: GuestLink, info: GuestInfo = {}) {
      for (const listener of [...arrivals]) listener(link, info);
    },
    /** The room is lost (or back): `listening` false/true. */
    setListening(value: boolean, detail?: string) {
      for (const listener of [...listening]) listener(value, detail);
    },
    removed,
    get closed() {
      return closed;
    },
  };
}
