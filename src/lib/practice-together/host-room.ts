/**
 * Practice together: the host's end of a session with up to nine guests (ten players with the
 * host). It keeps one {@link Session} per guest (each measures its own clock, shares the tab and
 * takes the guest's requests) and turns the host's transport commands into one start that every
 * guest and the host make at the same moment.
 *
 * Guests are told apart by their own id, which they say in their first hello. A guest that
 * comes back after a dropped connection or a dead battery presents the same id and takes its
 * place again: the host keeps the place for {@link SEAT_HOLD_MS}. The host can kick a guest (it can
 * come back) or ban it (it cannot, this session: by id, and by address where the transport knows
 * it).
 */
import { type SyncQuality } from "@/lib/practice-together/clock-sync";
import { LatencyTracker } from "@/lib/practice-together/latency";
import { PRESETS, type QualityChoice } from "@/lib/practice-together/quality-presets";
import {
  MAX_PLAYERS,
  decode,
  encode,
  type Command,
  type Message,
  type ScoreFingerprint,
} from "@/lib/practice-together/protocol";
import {
  Session,
  problem,
  type PeerInfo,
  type PeerReport,
  type Problem,
  type SessionHooks,
  type SessionState,
} from "@/lib/practice-together/session";
import type {
  Block,
  GuestAcceptor,
  GuestInfo,
  GuestLink,
  LinkState,
  PeerTransport,
} from "@/lib/practice-together/transport";

/** A guest that dropped out keeps its place this long. */
export const SEAT_HOLD_MS = 10 * 60_000;
/** A connection that has not said hello within this long is closed. */
export const HELLO_TIMEOUT_MS = 10_000;
/** A goodbye gets this long to reach the guest before its connection is closed. */
export const FLUSH_MS = 250;
/** A note about someone who left stays this long. */
export const NOTICE_MS = 10_000;

const NO_QUALITY: SyncQuality = { errorMs: Infinity, bucket: "none" };

/**
 * One guest's place on the host: a stable transport for its {@link Session}, behind which the
 * live connection can change. A dropped connection only makes the place wait; the connection a
 * returning guest arrives on takes it over.
 */
class SeatTransport implements PeerTransport {
  private raw: GuestLink | null = null;
  private off: (() => void)[] = [];
  private readonly frames = new Set<(text: string) => void>();
  private readonly states = new Set<(state: LinkState, detail?: string) => void>();
  private ended = false;

  private readonly release: (raw: GuestLink) => void;

  constructor(release: (raw: GuestLink) => void) {
    this.release = release;
  }

  get link(): GuestLink | null {
    return this.raw;
  }

  /** Makes `raw` the live connection; the one before it, if any, is let go. */
  bind(raw: GuestLink) {
    const before = this.raw;
    this.unbind();
    this.raw = raw;
    this.off = [
      raw.onFrame((text) => this.deliver(text)),
      raw.onState((state, detail) => {
        if (this.raw !== raw || state === "connecting") return;
        // A connection that was only unsteady may recover; one that is closed does not.
        if (state === "open") return this.emit("open");
        if (state === "closed") {
          this.raw = null;
          this.unbind();
        }
        this.emit("reconnecting", detail ?? "the guest disconnected");
      }),
    ];
    if (before && before !== raw) this.release(before);
    if (raw.state === "open") this.emit("open");
  }

  private unbind() {
    for (const stop of this.off.splice(0)) stop();
  }

  private emit(state: LinkState, detail?: string) {
    for (const listener of [...this.states]) listener(state, detail);
  }

  /** A frame the connection already delivered (the hello the room read first). */
  deliver(text: string) {
    if (this.ended) return;
    for (const listener of [...this.frames]) listener(text);
  }

  send(text: string) {
    if (!this.ended) this.raw?.send(text);
  }

  close() {
    if (this.ended) return;
    this.ended = true;
    const raw = this.raw;
    this.raw = null;
    this.unbind();
    // The goodbye that was just sent needs a moment to leave before the connection goes.
    if (raw) setTimeout(() => this.release(raw), FLUSH_MS);
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

interface Seat {
  id: string;
  session: Session;
  transport: SeatTransport;
  address?: string;
  /** Aborts a question to the host that is still open when the guest goes. */
  abort: AbortController;
  /** The name the guest gave (it is gone from the session once the guest has left). */
  name: string;
  /** The guest was in the session at some point (so its leaving is worth a note). */
  wasIn: boolean;
  retiring: boolean;
  /** Who to turn away at the connection, when the guest is banned. */
  block?: Block;
}

export interface HostRoomOptions {
  acceptor: GuestAcceptor;
  name: string;
  score: ScoreFingerprint;
  /** The host's hooks: what a command does here, the position, requests, approval and the tab. */
  hooks: SessionHooks;
  quality?: QualityChoice;
  now?: () => number;
  /** The session id guests are welcomed to. */
  session?: string;
  /** How long a guest that dropped out keeps its place. */
  seatHoldMs?: number;
  /** Players at most, the host included. */
  maxPlayers?: number;
}

export class HostRoom {
  readonly role = "host" as const;
  private readonly acceptor: GuestAcceptor;
  private readonly hostName: string;
  private readonly hooks: SessionHooks;
  private readonly now: () => number;
  private readonly sessionId: string;
  private readonly holdMs: number;
  private readonly maxPlayers: number;
  private readonly seats = new Map<string, Seat>();
  private readonly banned = new Set<string>();
  private readonly bannedAddresses = new Set<string>();
  private readonly listeners = new Set<(state: SessionState) => void>();
  private readonly stops: (() => void)[] = [];
  private readonly cancels = new Map<number, () => void>();
  private score: ScoreFingerprint;
  private choice: QualityChoice;
  private cmdId = 0;
  private anonymous = 0;
  private listening = true;
  private notice: Problem | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private ended = false;
  private state: SessionState;

  constructor(options: HostRoomOptions) {
    this.acceptor = options.acceptor;
    this.hostName = options.name;
    this.hooks = options.hooks;
    this.score = options.score;
    this.choice = options.quality ?? "auto";
    this.now = options.now ?? (() => performance.now());
    this.sessionId = options.session ?? randomId();
    this.holdMs = options.seatHoldMs ?? SEAT_HOLD_MS;
    this.maxPlayers = options.maxPlayers ?? MAX_PLAYERS;
    this.state = this.build();
    this.stops.push(
      this.acceptor.onGuest((link, info) => this.arrived(link, info)),
      this.acceptor.onListening((listening, detail) => {
        this.listening = listening;
        if (!listening) {
          this.say({
            kind: "dropped",
            message:
              detail && detail.length > 0
                ? `New players can no longer join: ${detail}`
                : "New players can no longer join. The players already in stay connected.",
            fatal: false,
          });
        }
        this.recompute();
      }),
    );
  }

  /** The state of the session; a new object whenever something changes. */
  get snapshot(): SessionState {
    return this.state;
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Only a guest asks the host: a host acts on its own. */
  request(): boolean {
    return false;
  }

  /** The room listens from the start; nothing to begin. Kept so a room and a session are used alike. */
  start(): void {}

  setQuality(choice: QualityChoice) {
    this.choice = choice;
    for (const seat of this.seats.values()) seat.session.setQuality(choice);
    this.recompute();
  }

  /** The open score changed: every guest checks it against its own. */
  setScore(score: ScoreFingerprint) {
    this.score = score;
    for (const seat of this.seats.values()) seat.session.setScore(score);
  }

  /** Leaves: every guest is told, and the room stops listening. */
  leave(reason = "left") {
    if (this.ended) return;
    this.ended = true;
    for (const seat of [...this.seats.values()]) {
      seat.abort.abort();
      seat.session.leave(reason);
    }
    this.seats.clear();
    for (const cancel of this.cancels.values()) cancel();
    this.cancels.clear();
    for (const stop of this.stops.splice(0)) stop();
    clearTimeout(this.noticeTimer);
    this.acceptor.close();
    this.state = { ...this.build(), phase: "closed" };
    this.emit();
  }

  /** The host removes a guest. It is told, and it may come back with the code. */
  kick(id: string) {
    this.seats.get(id)?.session.dismiss("kicked");
  }

  /**
   * The host bans a guest: its id (and its address, where the connection shows it) is turned away
   * for the rest of the session.
   */
  ban(id: string) {
    const seat = this.seats.get(id);
    if (!seat) return;
    this.banned.add(id);
    if (seat.address) this.bannedAddresses.add(seat.address);
    seat.block = { guest: id, ...(seat.address && { address: seat.address }) };
    seat.session.dismiss("banned");
  }

  // ----- starting things together ----------------------------------------------------------

  /**
   * The host asks everyone to do something together a moment from now. Every guest that is in sync
   * gets the same command; a guest that is not ready in time misses this one (the others start).
   * When no guest is ready, or the host is not, nothing starts.
   */
  async command(
    partial: Omit<Command, "id" | "at">,
  ): Promise<"started" | "late" | "not-synchronized" | "score"> {
    if (this.ended) return "not-synchronized";
    const synced = [...this.seats.values()].filter(
      (seat) => seat.session.snapshot.phase === "synchronized",
    );
    if (synced.length === 0) {
      this.say(problem("not-synchronized"));
      this.recompute();
      return "not-synchronized";
    }
    // A guest with another score waits for the host's tab: it is not part of the start.
    const targets = synced.filter((seat) => seat.session.snapshot.problem?.kind !== "score");
    if (targets.length === 0) return "score";
    const leadMs = Math.max(...targets.map((seat) => seat.session.snapshot.leadMs));
    const cmd: Command = { ...partial, id: (this.cmdId += 1), at: this.now() + leadMs };
    const answers = targets.map((seat) => seat.session.dispatch(cmd));
    const mine = this.hooks.prepare(cmd).catch(() => false);
    const [mineOk, ...ready] = await Promise.all([mine, ...answers]);
    const anyReady = ready.some(Boolean);
    targets.forEach((seat, i) => {
      if (!mineOk || !ready[i]) seat.session.callOff(cmd.id, mineOk ? "peer-late" : "host-late");
    });
    if (!mineOk || !anyReady) return "late";
    this.cancels.set(cmd.id, this.hooks.schedule(cmd, cmd.at));
    return "started";
  }

  // ----- guests ----------------------------------------------------------------------------

  /** A connection arrived. Nothing is decided until it says who it is. */
  private arrived(link: GuestLink, info: GuestInfo) {
    if (this.ended) return void this.acceptor.remove(link);
    const stop = () => {
      clearTimeout(timer);
      offFrame();
      offState();
    };
    const timer = setTimeout(() => {
      stop();
      this.acceptor.remove(link);
    }, HELLO_TIMEOUT_MS);
    const offFrame = link.onFrame((text) => {
      stop();
      this.first(link, info, text);
    });
    const offState = link.onState((state) => {
      if (state === "closed") stop();
    });
  }

  /** The first frame of a connection: it has to be a hello. */
  private first(link: GuestLink, info: GuestInfo, text: string) {
    const frame = decode(text);
    const hello = frame?.msg;
    if (!frame || !hello || hello.type !== "hello" || hello.role !== "guest") {
      return void this.acceptor.remove(link);
    }
    const id = hello.guest ?? `connection-${(this.anonymous += 1)}`;
    if (this.banned.has(id) || (info.address && this.bannedAddresses.has(info.address))) {
      return this.turnAway(link, { type: "bye", reason: "banned" });
    }
    let seat = this.seats.get(id);
    // A guest that was never let in and asks again starts over (its old question is withdrawn).
    if (seat && !seat.session.welcomed) {
      this.retire(seat);
      seat = undefined;
    }
    if (seat) {
      // A guest that comes back takes its place again.
      seat.address = info.address ?? seat.address;
      seat.transport.bind(link);
      seat.transport.deliver(text);
      return this.recompute();
    }
    if (this.seats.size >= this.maxPlayers - 1) {
      return this.turnAway(link, { type: "refuse", reason: "full" });
    }
    this.seat(id, link, info, text);
  }

  private turnAway(link: GuestLink, msg: Message) {
    link.send(encode(msg, 1));
    setTimeout(() => this.acceptor.remove(link), FLUSH_MS);
  }

  private seat(id: string, link: GuestLink, info: GuestInfo, firstFrame: string) {
    const transport = new SeatTransport((raw) => this.acceptor.remove(raw, seat.block));
    const abort = new AbortController();
    const session = new Session({
      role: "host",
      transport,
      name: this.hostName,
      score: this.score,
      quality: this.choice,
      now: this.now,
      session: this.sessionId,
      reconnectMs: this.holdMs,
      hooks: {
        // A start is made for everyone by the room: a guest's session only carries it.
        prepare: () => Promise.resolve(false),
        schedule: () => () => {},
        position: this.hooks.position,
        request: this.hooks.request,
        tab: this.hooks.tab,
        approve: (name) => this.approve(seat, name),
      },
    });
    const seat: Seat = {
      id,
      session,
      transport,
      address: info.address,
      abort,
      name: "A player",
      wasIn: false,
      retiring: false,
    };
    this.seats.set(id, seat);
    session.subscribe(() => this.watch(seat));
    // A connection lost before the guest was let in takes its place with it.
    transport.onState((state) => {
      if (state === "reconnecting" && !session.welcomed) this.retire(seat);
    });
    transport.bind(link);
    session.start("open");
    transport.deliver(firstFrame);
    this.recompute();
  }

  /** Asks the host whether to let the guest in; no answer is needed once the guest has gone. */
  private approve(seat: Seat, name: string): Promise<boolean> {
    const answer = this.hooks.approve?.(name, seat.abort.signal) ?? Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      seat.abort.signal.addEventListener("abort", () => resolve(false), { once: true });
      void answer.then(resolve, () => resolve(false));
    });
  }

  /** What a guest's session tells the room: it ended, went back to waiting, or changed. */
  private watch(seat: Seat) {
    const { phase, peerName } = seat.session.snapshot;
    if (peerName) seat.name = peerName;
    if (phase === "syncing" || phase === "synchronized") seat.wasIn = true;
    if (phase === "closed" || phase === "failed") {
      if (this.seats.get(seat.id) === seat) this.seats.delete(seat.id);
      seat.abort.abort();
      if (seat.wasIn && !this.ended) {
        if (phase === "failed") {
          this.say({
            kind: "dropped",
            message: `${seat.name} could not get back and was taken off the list.`,
            fatal: false,
          });
        }
      }
    } else if (phase === "waiting" && !seat.retiring) {
      // The guest left (or was refused): the session goes back to waiting; the place is freed.
      if (seat.wasIn) this.say(this.left(seat));
      this.retire(seat);
    }
    this.recompute();
  }

  private left(seat: Seat): Problem {
    return { kind: "peer-left", message: `${seat.name} left the session.`, fatal: false };
  }

  /** Frees a guest's place: its session ends (after the current update has been handled). */
  private retire(seat: Seat) {
    if (seat.retiring) return;
    seat.retiring = true;
    seat.abort.abort();
    queueMicrotask(() => seat.session.leave("done"));
  }

  /** A short note for the dialog and the chip (someone left); it fades. */
  private say(note: Problem) {
    this.notice = note;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice = null;
      if (!this.ended) this.recompute();
    }, NOTICE_MS);
  }

  // ----- the state everybody sees ----------------------------------------------------------

  private info(seat: Seat): PeerInfo {
    const s = seat.session.snapshot;
    return {
      id: seat.id,
      name: s.peerName ?? seat.name,
      phase: s.phase,
      quality: s.quality,
      latency: s.latency,
      peer: s.peer,
      problem: s.problem,
      address: seat.address,
      transfer: s.transfer ?? null,
    };
  }

  private build(): SessionState {
    const seats = [...this.seats.values()].filter((seat) => !seat.retiring);
    const states = seats.map((seat) => seat.session.snapshot);
    const synced = states.filter((s) => s.phase === "synchronized");
    const phase = synced.length
      ? "synchronized"
      : states.some((s) => s.phase === "approving")
        ? "approving"
        : states.some((s) => s.phase === "syncing")
          ? "syncing"
          : states.some((s) => s.phase === "reconnecting")
            ? "reconnecting"
            : "waiting";
    const live = states.filter((s) => s.phase !== "reconnecting");
    const names = states.map((s) => s.peerName).filter((n): n is string => Boolean(n));
    const worstPeer = synced
      .map((s) => s.peer)
      .filter((p): p is PeerReport => p !== null)
      .reduce<PeerReport | null>(
        (worst, p) => (!worst || p.errorMs > worst.errorMs ? p : worst),
        null,
      );
    const slowest = live.reduce<SessionState | null>(
      (worst, s) => (!worst || s.latency.p50 > worst.latency.p50 ? s : worst),
      null,
    );
    const first = states.find((s) => s.problem !== null);
    const one = states.length === 1;
    const problemOf = first?.problem
      ? one
        ? first.problem
        : { ...first.problem, message: `${first.peerName ?? "A player"}: ${first.problem.message}` }
      : null;
    return {
      role: "host",
      phase,
      session: this.sessionId,
      peerName:
        names.length === 0
          ? null
          : names.length <= 2
            ? names.join(" and ")
            : `${names[0]} and ${names.length - 1} others`,
      quality: synced.reduce<SyncQuality>(
        (worst, s) =>
          s.quality.errorMs > worst.errorMs || worst.bucket === "none" ? s.quality : worst,
        NO_QUALITY,
      ),
      latency: slowest?.latency ?? new LatencyTracker().stats(),
      preset: slowest?.preset ?? "balanced",
      leadMs: synced.length
        ? Math.max(...synced.map((s) => s.leadMs))
        : PRESETS.balanced.leadFloorMs,
      problem: problemOf ?? this.notice,
      peer: worstPeer,
      transfer: states.find((s) => s.transfer)?.transfer ?? null,
      peers: seats.map((seat) => this.info(seat)),
      listening: this.listening,
    };
  }

  private recompute() {
    if (this.ended) return;
    this.state = this.build();
    this.emit();
  }

  private emit() {
    for (const listener of [...this.listeners]) listener(this.state);
  }
}

function randomId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
