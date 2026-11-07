/**
 * Practice together over the local network. The sockets live in Rust (`src-tauri/src/practice.rs`);
 * this is the page's end of them. A guest's link is a {@link PeerTransport}; a host's is a
 * {@link GuestAcceptor} that hands out one link per guest.
 */
import {
  onPracticeFrame,
  onPracticeState,
  practiceHost,
  practiceJoin,
  practiceKick,
  practiceLeave,
  practiceSend,
  type PracticeHostInfo,
} from "@/lib/tauri";
import type {
  Block,
  GuestAcceptor,
  GuestInfo,
  GuestLink,
  LinkState,
  PeerTransport,
} from "@/lib/practice-together/transport";

/** What a link says to the session, for either side. */
class Emitter {
  protected frames = new Set<(text: string) => void>();
  protected states = new Set<(state: LinkState, detail?: string) => void>();

  protected emitFrame(text: string) {
    for (const listener of [...this.frames]) listener(text);
  }

  protected emitState(state: LinkState, detail?: string) {
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

/** A guest's connection to its host. */
class LanTransport extends Emitter implements PeerTransport {
  private stops: (() => void)[] = [];
  private closed = false;

  /** Starts hearing the link. Call before the command that opens it, so no event is missed. */
  async listen() {
    this.stops = [
      await onPracticeFrame((text) => this.emitFrame(text)),
      await onPracticeState((state, detail) => {
        if (state === "closed") this.release();
        this.emitState(state, detail);
      }),
    ];
  }

  private release() {
    for (const stop of this.stops.splice(0)) stop();
  }

  send(text: string) {
    if (!this.closed) void practiceSend(text).catch(() => {});
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    void practiceLeave().catch(() => {});
    this.release();
  }
}

/** One guest of a host, as a link. */
class LanGuest extends Emitter implements GuestLink {
  state: LinkState = "open";

  readonly conn: number;

  constructor(conn: number) {
    super();
    this.conn = conn;
  }

  deliver(text: string) {
    if (this.state !== "closed") this.emitFrame(text);
  }

  /** The connection ended (the guest left, or the host removed it). */
  end(detail?: string) {
    if (this.state === "closed") return;
    this.state = "closed";
    this.emitState("closed", detail);
  }

  send(text: string) {
    if (this.state === "open") void practiceSend(text, this.conn).catch(() => {});
  }

  close() {
    if (this.state === "closed") return;
    void practiceKick(this.conn, false).catch(() => {});
    this.end();
  }
}

/** The host's listening socket: a link for every guest that connects. */
class LanHost implements GuestAcceptor {
  private readonly guests = new Map<number, LanGuest>();
  private readonly arrivals = new Set<(link: GuestLink, info: GuestInfo) => void>();
  private readonly listening = new Set<(listening: boolean, detail?: string) => void>();
  /** Guests that came before anyone listened for them. */
  private early: [LanGuest, GuestInfo][] = [];
  private stops: (() => void)[] = [];
  private closed = false;

  /** Starts hearing the socket. Call before the command that opens it, so no event is missed. */
  async listen() {
    this.stops = [
      await onPracticeFrame((text, conn) => this.guests.get(conn)?.deliver(text)),
      await onPracticeState((state, detail, conn) => this.state(state, detail, conn)),
    ];
  }

  private state(state: LinkState, detail: string | undefined, conn: number) {
    if (conn === 0) {
      if (state === "closed") this.finish(detail);
      return;
    }
    if (state === "open") {
      const guest = new LanGuest(conn);
      this.guests.set(conn, guest);
      const info: GuestInfo = detail ? { address: detail } : {};
      if (this.arrivals.size === 0) this.early.push([guest, info]);
      for (const listener of [...this.arrivals]) listener(guest, info);
    } else if (state === "closed") {
      const guest = this.guests.get(conn);
      this.guests.delete(conn);
      guest?.end(detail);
    }
  }

  /** The socket is gone: every guest is too. */
  private finish(detail?: string) {
    for (const guest of this.guests.values()) guest.end(detail);
    this.guests.clear();
    for (const stop of this.stops.splice(0)) stop();
    for (const listener of [...this.listening]) listener(false, detail);
  }

  onGuest(listener: (link: GuestLink, info: GuestInfo) => void) {
    this.arrivals.add(listener);
    for (const [guest, info] of this.early.splice(0)) listener(guest, info);
    return () => this.arrivals.delete(listener);
  }

  onListening(listener: (listening: boolean, detail?: string) => void) {
    this.listening.add(listener);
    return () => this.listening.delete(listener);
  }

  remove(link: GuestLink, block?: Block) {
    if (!(link instanceof LanGuest)) return;
    void practiceKick(link.conn, block !== undefined).catch(() => {});
    link.end();
    this.guests.delete(link.conn);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    void practiceLeave().catch(() => {});
    for (const guest of this.guests.values()) guest.end();
    this.guests.clear();
    for (const stop of this.stops.splice(0)) stop();
  }
}

/** Listens on the local network. The code goes to the other players. */
export async function hostOnLan(): Promise<{ acceptor: GuestAcceptor; info: PracticeHostInfo }> {
  const acceptor = new LanHost();
  await acceptor.listen();
  try {
    return { acceptor, info: await practiceHost() };
  } catch (error) {
    acceptor.close();
    throw error;
  }
}

/** Joins a host on the local network by its room code. */
export async function joinOnLan(code: string): Promise<PeerTransport> {
  const transport = new LanTransport();
  await transport.listen();
  try {
    await practiceJoin(code);
    return transport;
  } catch (error) {
    transport.close();
    throw error;
  }
}
