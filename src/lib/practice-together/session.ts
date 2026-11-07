/**
 * Practice together: one session between two apps. It speaks the protocol over a transport,
 * keeps the shared clock, picks the lead time from the measured network, and turns the host's
 * transport commands into starts that both apps make at the same moment.
 *
 * It never touches the player: the app plugs in `hooks` (prepare, schedule, cancel).
 */
import { ClockEstimator, toLocalTime, type SyncQuality } from "@/lib/practice-together/clock-sync";
import {
  LatencyTracker,
  leadTimeMs,
  tooPoor,
  type LatencyStats,
} from "@/lib/practice-together/latency";
import {
  PRESETS,
  resolvePreset,
  type QualityChoice,
  type QualityPreset,
} from "@/lib/practice-together/quality-presets";
import {
  CAPABILITIES,
  MAX_TAB_BYTES,
  PROTOCOL_VERSION,
  decode,
  encode,
  negotiate,
  type Command,
  type Message,
  type RequestAction,
  type RefuseReason,
  type ScoreFingerprint,
} from "@/lib/practice-together/protocol";
import {
  TabReceiver,
  TabSender,
  checkOffer,
  tabFailureText,
  type ReceivedTab,
  type TabOffer,
  type TabPayload,
  type TabProgress,
} from "@/lib/practice-together/tab-transfer";
import type { LinkState, PeerTransport } from "@/lib/practice-together/transport";
import { fileKey } from "@/lib/score/format";

export type SessionRole = "host" | "guest";

export type SessionPhase =
  /** The host is listening for a guest. */
  | "waiting"
  /** A guest asked to join and the host has to say yes. */
  | "approving"
  /** Connected; measuring the clock before the first start. */
  | "syncing"
  | "synchronized"
  | "reconnecting"
  | "closed"
  | "failed";

export type ProblemKind =
  | "score"
  | "version"
  | "declined"
  | "busy"
  | "dropped"
  | "poor"
  | "late"
  | "woke"
  | "peer-left"
  | "not-synchronized"
  /** The tab could not be shared (the message says why). */
  | "tab";

/** Something the people in the session need to be told. */
export interface Problem {
  kind: ProblemKind;
  message: string;
  /** The session cannot go on until it is solved (as opposed to a warning). */
  fatal: boolean;
}

export interface PeerReport {
  errorMs: number;
  rtt: number;
  driftMs: number;
}

export interface SessionState {
  role: SessionRole;
  phase: SessionPhase;
  session: string | null;
  peerName: string | null;
  quality: SyncQuality;
  latency: LatencyStats;
  preset: QualityPreset;
  /** The time ahead of a command at which it takes effect. */
  leadMs: number;
  problem: Problem | null;
  /** What the other app says about its own clock estimate and drift. */
  peer: PeerReport | null;
  /** The host's tab on its way to the guest (or a new version of it), for the dialog. */
  transfer?: TabProgress | null;
}

/** What the app does with a command. All three run on this computer's clock. */
export interface SessionHooks {
  /** Gets ready (seek, speed, loop, metronome). False means this app cannot start in time. */
  prepare(cmd: Command): Promise<boolean>;
  /** Starts at the local time `localAt`. Returns a way to take it back before it happens. */
  schedule(cmd: Command, localAt: number): () => void;
  /** The guest only: how far this app's playback is from the host's, in milliseconds. */
  driftMs?(): number;
  /** The host only: where playback is, in score milliseconds as heard (null: nothing to report). */
  position?(): { pos: number; playing: boolean } | null;
  /** The guest only: the host's position at the local time `localAt`. */
  hostState?(pos: number, localAt: number, playing: boolean): void;
  /** The host only: whether to let a guest in. */
  approve?(name: string): Promise<boolean>;
  /** The host only: the guest asks for Play, Pause, Stop or a position (the host decides). */
  request?(action: RequestAction, tick: number | undefined): void;
  /** Sharing the host's tab (#158). Without it the session works only on one shared file. */
  tab?: TabHooks;
}

export interface TabHooks {
  /** The host only: the open tab as it is now (null: nothing to share). */
  offer?(): Promise<TabPayload | null>;
  /**
   * The guest only: a tab arrived whole and checked. Reads it; null when it is fine, or the
   * reason it cannot be opened.
   */
  receive?(tab: ReceivedTab): Promise<string | null>;
  /** The guest only: the answer went out, so the app may now open the tab and move the session. */
  opened?(): void;
}

export interface SessionOptions {
  role: SessionRole;
  transport: PeerTransport;
  name: string;
  score: ScoreFingerprint;
  hooks: SessionHooks;
  quality?: QualityChoice;
  /** The monotonic clock, in milliseconds. */
  now?: () => number;
  /** For a host: the id guests are welcomed to. */
  session?: string;
  /**
   * For a guest that takes over a live connection from another session (it moved to the tab it
   * just received): the session id it was welcomed to. It says hello as a returning guest.
   */
  resume?: string;
}

/** A dropped connection is given this long to come back before the session ends. */
export const RECONNECT_MS = 20_000;
/** The computer slept when the ping timer was this late. */
export const SLEEP_GAP_MS = 3_000;
/** The pings sent at the start, to get a first estimate quickly. */
export const BURST_PINGS = 8;
export const BURST_GAP_MS = 120;
/** How often the host reports where playback is, so the guest can follow. */
export const STATE_MS = 1_000;
/** A start is called off when the other app is not ready this long before it. */
export const READY_MARGIN_MS = 30;
/** A command that arrives with less than this left cannot be prepared. */
export const MIN_PREPARE_MS = 20;
/** A new version of the host's tab is sent this long after the last edit. */
export const OFFER_DEBOUNCE_MS = 600;
/** While the host plays, a new version of its tab waits and asks again this often. */
export const OFFER_RETRY_MS = 500;
/** A version the guest could not take is offered this many times. */
export const MAX_OFFER_TRIES = 2;

const NO_QUALITY: SyncQuality = { errorMs: Infinity, bucket: "none" };

const describe = (kind: ProblemKind): string => {
  switch (kind) {
    case "score":
      return "The tab is not the same on both computers yet. The host's tab is being shared.";
    case "version":
      return "The other Smart Beat is too old or too new for this. Update both apps.";
    case "declined":
      return "The host did not let you in.";
    case "busy":
      return "The host already has someone connected.";
    case "dropped":
      return "The connection dropped. Trying to get it back…";
    case "poor":
      return "The connection is too unsteady to stay in sync. Move closer to the router or use a cable.";
    case "late":
      return "The other computer was not ready in time, so nothing started. Try again.";
    case "woke":
      return "This computer was asleep. Syncing the clocks again…";
    case "peer-left":
      return "The other player left the session.";
    case "not-synchronized":
      return "Wait until the clocks are in sync.";
    case "tab":
      return tabFailureText("failed");
  }
};

const fatalKinds: ProblemKind[] = ["version", "declined", "busy", "peer-left"];

export function problem(kind: ProblemKind): Problem {
  return { kind, message: describe(kind), fatal: fatalKinds.includes(kind) };
}

export class Session {
  readonly role: SessionRole;
  private readonly transport: PeerTransport;
  private readonly hooks: SessionHooks;
  private readonly now: () => number;
  private readonly name: string;
  private readonly clock = new ClockEstimator();
  private readonly latency = new LatencyTracker();
  private readonly listeners = new Set<(state: SessionState) => void>();
  private readonly unsubscribe: (() => void)[] = [];
  private score: ScoreFingerprint;
  private choice: QualityChoice;
  private seq = 0;
  private pingId = 0;
  private cmdId = 0;
  private version = PROTOCOL_VERSION;
  private peerKey: string | null = null;
  private link: LinkState = "connecting";
  private wasWelcomed = false;
  private pingTimer: ReturnType<typeof setTimeout> | undefined;
  private lastTick = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stateTimer: ReturnType<typeof setInterval> | undefined;
  /** Commands waiting for the other app's answer (host). */
  private waiting = new Map<number, (ok: boolean) => void>();
  /** Starts that were scheduled and can still be called off. */
  private cancels = new Map<number, () => void>();
  private state: SessionState;
  // Sharing the tab (#158).
  private peerCaps: string[] = [];
  private sender: TabSender | null = null;
  private receiver: TabReceiver | null = null;
  private offerId = 0;
  private offerTimer: ReturnType<typeof setTimeout> | undefined;
  private offering = false;
  /** How often each version was offered, so a guest that cannot take it is not asked forever. */
  private attempts = new Map<string, number>();
  private resumeId: string | undefined;

  constructor(options: SessionOptions) {
    this.role = options.role;
    this.transport = options.transport;
    this.hooks = options.hooks;
    this.now = options.now ?? (() => performance.now());
    this.name = options.name;
    this.score = options.score;
    this.resumeId = options.resume;
    this.choice = options.quality ?? "auto";
    this.state = {
      role: options.role,
      phase: options.role === "host" ? "waiting" : "syncing",
      session: options.session ?? options.resume ?? (options.role === "host" ? randomId() : null),
      peerName: null,
      quality: NO_QUALITY,
      latency: this.latency.stats(),
      preset: "balanced",
      leadMs: PRESETS.balanced.leadFloorMs,
      problem: null,
      peer: null,
      transfer: null,
    };
    this.unsubscribe.push(
      this.transport.onFrame((text) => this.receive(text)),
      this.transport.onState((link, detail) => this.linkChanged(link, detail)),
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

  /** The host's clock right now: the clock every command is timed on. */
  sessionNow(): number {
    const local = this.now();
    return this.role === "host" ? local : local + this.clock.offsetAt(local);
  }

  /** The local time at which the host's clock reads `at`. */
  localTimeOf(at: number): number {
    if (this.role === "host") return at;
    return toLocalTime(at, this.clock.offsetAt(this.now()));
  }

  setQuality(choice: QualityChoice) {
    this.choice = choice;
    this.recompute();
  }

  /** The open score changed: tell the other app, which checks it against its own. */
  setScore(score: ScoreFingerprint) {
    this.score = score;
    // A guest tells the host which tab it has; the host answers a difference with its own tab.
    if (this.wasWelcomed && this.role === "guest") this.sendHello();
    this.checkScore();
  }

  /**
   * Hands the live connection to another session (the guest moved to the tab it received).
   * Nothing is said to the other app and the transport stays open.
   */
  release(): { transport: PeerTransport; session: string | null; peerName: string | null } {
    const handoff = {
      transport: this.transport,
      session: this.state.session,
      peerName: this.state.peerName,
    };
    if (this.state.phase === "closed" || this.state.phase === "failed") return handoff;
    this.stopPings();
    clearTimeout(this.reconnectTimer);
    this.dropTransfers();
    for (const resolve of this.waiting.values()) resolve(false);
    this.waiting.clear();
    for (const cancel of this.cancels.values()) cancel();
    this.cancels.clear();
    this.patch({ phase: "closed", problem: null });
    for (const stop of this.unsubscribe.splice(0)) stop();
    return handoff;
  }

  /**
   * Starts talking. The guest says hello; the host waits to be spoken to. `link` is the state the
   * connection is already in: a guest joined over a LAN is connected before the session exists.
   */
  start(link: LinkState = this.link) {
    this.lastTick = this.now();
    this.link = link;
    if (link === "open") this.opened();
  }

  /** Leaves. The other app is told. */
  leave(reason = "left") {
    if (this.state.phase === "closed") return;
    this.send({ type: "bye", reason });
    this.finish("closed", null);
  }

  /**
   * The guest asks the host for Play, Pause, Stop or a new position; the host turns it into a
   * command both apps run at the same moment. False when it cannot be asked yet.
   */
  request(action: RequestAction, tick?: number): boolean {
    if (this.role !== "guest" || this.state.phase !== "synchronized") return false;
    this.send({ type: "request", action, ...(tick === undefined ? {} : { tick }) });
    return true;
  }

  /**
   * The host asks both apps to do something together a moment from now.
   * Resolves with `started` when both were ready, or the reason it was called off.
   */
  async command(
    partial: Omit<Command, "id" | "at">,
  ): Promise<"started" | "late" | "not-synchronized" | "score"> {
    if (this.role !== "host") return "not-synchronized";
    if (this.state.problem?.kind === "score") return "score";
    if (this.state.phase !== "synchronized") {
      this.setProblem(problem("not-synchronized"));
      return "not-synchronized";
    }
    const cmd: Command = { ...partial, id: (this.cmdId += 1), at: this.now() + this.state.leadMs };
    this.send({ type: "cmd", cmd });
    const peer = new Promise<boolean>((resolve) => {
      this.waiting.set(cmd.id, resolve);
      setTimeout(
        () => {
          if (this.waiting.delete(cmd.id)) resolve(false);
        },
        Math.max(0, cmd.at - this.now() - READY_MARGIN_MS),
      );
    });
    const mine = this.hooks.prepare(cmd).catch(() => false);
    const [mineOk, peerOk] = await Promise.all([mine, peer]);
    if (!mineOk || !peerOk) {
      this.send({ type: "abort", id: cmd.id, reason: mineOk ? "peer-late" : "host-late" });
      this.setProblem(problem("late"));
      return "late";
    }
    this.cancels.set(cmd.id, this.hooks.schedule(cmd, cmd.at));
    return "started";
  }

  // ----- link ------------------------------------------------------------------------------

  private linkChanged(link: LinkState, detail?: string) {
    const before = this.link;
    this.link = link;
    if (link === "open") {
      clearTimeout(this.reconnectTimer);
      this.opened();
      return;
    }
    if (this.state.phase === "closed" || this.state.phase === "failed") return;
    if (link === "closed") {
      // A refusal was already explained; do not overwrite it.
      if (this.state.problem?.fatal) return this.finish("failed", this.state.problem);
      if (this.wasWelcomed) {
        this.finish("closed", problem("peer-left"));
      } else {
        this.finish("failed", {
          kind: "dropped",
          message: detail ?? describe("dropped"),
          fatal: true,
        });
      }
      return;
    }
    if (link === "reconnecting" && before !== "reconnecting") {
      this.stopPings();
      this.dropTransfers();
      if (!this.wasWelcomed && this.role === "host") {
        this.patch({ phase: "waiting", peerName: null });
      }
      if (this.wasWelcomed) {
        this.patch({ phase: "reconnecting", problem: problem("dropped") });
        this.reconnectTimer = setTimeout(
          () => this.finish("failed", { ...problem("dropped"), fatal: true }),
          RECONNECT_MS,
        );
      }
    }
  }

  private opened() {
    // The host waits for the guest's hello; a guest that came back says it again.
    if (this.role === "guest") this.sendHello();
  }

  private sendHello() {
    this.send({
      type: "hello",
      name: this.name,
      role: this.role,
      caps: [...CAPABILITIES],
      score: this.score,
      session: this.wasWelcomed ? (this.state.session ?? undefined) : this.resumeId,
      ...(this.resumeId !== undefined && !this.wasWelcomed && { resume: true }),
    });
  }

  // ----- receiving -------------------------------------------------------------------------

  private receive(text: string) {
    const frame = decode(text);
    if (!frame || this.state.phase === "closed" || this.state.phase === "failed") return;
    const msg = frame.msg;
    switch (msg.type) {
      case "hello":
        return void this.onHello(msg, frame.v);
      case "welcome":
        return this.onWelcome(msg);
      case "refuse":
        return this.onRefuse(msg.reason);
      case "ping":
        return this.send({
          type: "pong",
          id: msg.id,
          t0: msg.t0,
          t1: this.now(),
          t2: this.now(),
        });
      case "pong":
        return this.onPong(msg);
      case "cmd":
        return void this.onCommand(msg.cmd);
      case "ready":
        this.waiting.get(msg.id)?.(msg.ok);
        this.waiting.delete(msg.id);
        return;
      case "abort":
        this.cancels.get(msg.id)?.();
        this.cancels.delete(msg.id);
        return this.setProblem(problem("late"));
      case "report":
        return this.onReport(msg);
      case "request":
        // Only a synchronized host acts on it, and the app decides whether it makes sense now.
        if (this.role === "host" && this.state.phase === "synchronized") {
          this.hooks.request?.(msg.action, msg.tick);
        }
        return;
      case "tab-offer":
        return void this.onTabOffer(msg);
      case "tab-chunk":
        return void this.onTabChunk(msg);
      case "tab-ack":
        if (this.sender?.id === msg.id) this.sender.ack(msg.n);
        return;
      case "tab-done":
        return this.onTabDone(msg);
      case "tab-abort":
        return this.onTabAbort(msg);
      case "bye":
        return this.role === "host"
          ? this.guestGone()
          : this.finish("closed", problem("peer-left"));
      case "state":
        if (this.role === "guest" && this.clock.ready) {
          this.hooks.hostState?.(msg.pos, this.localTimeOf(msg.at), msg.playing);
        }
        return;
    }
  }

  private async onHello(msg: Extract<Message, { type: "hello" }>, version: number) {
    this.peerKey = msg.score.key;
    if (this.role === "guest") return this.checkScore();
    this.peerCaps = msg.caps;
    if (negotiate(PROTOCOL_VERSION, version) < 1) return this.refuse("version");
    this.version = negotiate(PROTOCOL_VERSION, version);
    if (this.wasWelcomed) {
      // The guest moved the live connection to the tab it received: welcome it again.
      if (msg.resume && msg.session === this.state.session) {
        this.dropTransfers();
        return this.welcome(msg.name);
      }
      // The same guest saying hello again: it came back, or its score changed.
      if (msg.name !== this.state.peerName && msg.session !== this.state.session) {
        return this.refuse("busy");
      }
      this.checkScore();
      if (this.state.phase === "reconnecting") this.welcome(msg.name);
      return;
    }
    // A guest that cannot take a tab can only play the same file.
    if (msg.score.key !== this.score.key && (!this.hooks.tab?.offer || !msg.caps.includes("tab"))) {
      this.patch({ peerName: msg.name });
      return this.refuse("score");
    }
    this.patch({ phase: "approving", peerName: msg.name });
    const ok = (await this.hooks.approve?.(msg.name)) ?? true;
    if (!ok) return this.refuse("declined");
    this.welcome(msg.name);
  }

  private welcome(name: string) {
    this.wasWelcomed = true;
    this.send({
      type: "welcome",
      session: this.state.session ?? randomId(),
      version: this.version,
      name: this.name,
    });
    this.patch({ peerName: name, phase: "syncing", peer: null, problem: null });
    this.checkScore(0);
    this.beginSync();
  }

  private refuse(reason: RefuseReason) {
    this.send({ type: "refuse", reason });
    if (!this.wasWelcomed) this.patch({ phase: "waiting", peerName: null, problem: null });
  }

  private onWelcome(msg: Extract<Message, { type: "welcome" }>) {
    this.wasWelcomed = true;
    this.version = negotiate(PROTOCOL_VERSION, msg.version);
    this.patch({
      session: msg.session,
      peerName: msg.name,
      phase: "syncing",
      peer: null,
      problem: null,
    });
    this.beginSync();
  }

  private onRefuse(reason: RefuseReason) {
    const kind: ProblemKind = reason === "declined" ? "declined" : reason;
    this.finish("failed", problem(kind));
  }

  private onReport(report: PeerReport) {
    this.patch({ peer: { errorMs: report.errorMs, rtt: report.rtt, driftMs: report.driftMs } });
    this.promote();
  }

  private async onCommand(cmd: Command) {
    if (this.role !== "guest") return;
    const localAt = this.localTimeOf(cmd.at);
    if (!this.clock.ready || localAt - this.now() < MIN_PREPARE_MS) {
      return this.send({ type: "ready", id: cmd.id, ok: false, reason: "late" });
    }
    const ok = await this.hooks.prepare(cmd).catch(() => false);
    if (!ok || this.localTimeOf(cmd.at) - this.now() < 0) {
      return this.send({ type: "ready", id: cmd.id, ok: false, reason: "late" });
    }
    this.send({ type: "ready", id: cmd.id, ok: true });
    this.cancels.set(cmd.id, this.hooks.schedule(cmd, this.localTimeOf(cmd.at)));
  }

  // ----- clock -----------------------------------------------------------------------------

  private beginSync() {
    this.clock.reset();
    this.latency.reset();
    this.stopPings();
    this.lastTick = this.now();
    let sent = 0;
    const burst = () => {
      this.ping();
      sent += 1;
      if (sent < BURST_PINGS) this.pingTimer = setTimeout(burst, BURST_GAP_MS);
      else this.pingTimer = setTimeout(steady, this.preset().pingMs);
    };
    const steady = () => {
      const t = this.now();
      if (t - this.lastTick > SLEEP_GAP_MS) {
        // The computer slept: the clock estimate is from another life.
        this.patch({ phase: "syncing", problem: problem("woke") });
        return this.beginSync();
      }
      this.lastTick = t;
      this.ping();
      this.pingTimer = setTimeout(steady, this.preset().pingMs);
    };
    burst();
  }

  private stopPings() {
    clearTimeout(this.pingTimer);
    this.pingTimer = undefined;
    clearInterval(this.stateTimer);
    this.stateTimer = undefined;
  }

  /** The host tells the guest where playback is, every second. */
  private startState() {
    if (this.role !== "host" || this.stateTimer !== undefined) return;
    this.stateTimer = setInterval(() => {
      if (this.state.phase !== "synchronized") return;
      const position = this.hooks.position?.();
      if (position) {
        this.send({ type: "state", pos: position.pos, at: this.now(), playing: position.playing });
      }
    }, STATE_MS);
  }

  private ping() {
    this.send({ type: "ping", id: (this.pingId += 1), t0: this.now() });
  }

  private onPong(msg: Extract<Message, { type: "pong" }>) {
    const t3 = this.now();
    if (this.clock.add({ t0: msg.t0, t1: msg.t1, t2: msg.t2, t3 })) {
      this.latency.add(t3 - msg.t0 - (msg.t2 - msg.t1));
    }
    this.recompute();
    if (this.state.phase !== "closed") this.sendReport();
    this.promote();
  }

  private sendReport() {
    if (!this.clock.ready) return;
    const q = this.clock.quality();
    this.send({
      type: "report",
      errorMs: q.errorMs,
      rtt: this.latency.stats().p50,
      driftMs: this.hooks.driftMs?.() ?? 0,
    });
  }

  private preset(): { name: QualityPreset } & (typeof PRESETS)[QualityPreset] {
    const name = resolvePreset(this.choice, this.clock.quality(), this.latency.stats());
    return { name, ...PRESETS[name] };
  }

  /** Re-reads the measurements into the state. */
  private recompute() {
    const quality = this.clock.quality();
    const latency = this.latency.stats();
    const preset = this.preset();
    const leadMs = leadTimeMs(latency, preset.leadFloorMs, preset.jitterFactor);
    const poor = tooPoor(quality, latency);
    const keep =
      this.state.problem && this.state.problem.kind !== "poor" ? this.state.problem : null;
    this.patch({
      quality,
      latency,
      preset: preset.name,
      leadMs,
      problem: poor ? problem("poor") : keep,
    });
  }

  /** Both apps have a clock estimate: the session may start things. */
  private promote() {
    if (this.state.phase !== "syncing" && this.state.phase !== "synchronized") return;
    const mine = this.clock.ready;
    const theirs = this.state.peer !== null;
    const next = mine && theirs ? "synchronized" : "syncing";
    if (next === "synchronized" && this.state.problem?.kind === "woke") {
      this.patch({ phase: next, problem: null });
    } else if (next !== this.state.phase) {
      this.patch({ phase: next });
    }
    if (next === "synchronized") this.startState();
  }

  /**
   * Whether both apps have the same score open. A difference blocks starting together; the host
   * answers it by sending its tab (`delay`: edits come in bursts, so a new version waits a moment).
   */
  private checkScore(delay = OFFER_DEBOUNCE_MS) {
    if (this.peerKey === null) return;
    const same = this.peerKey === this.score.key;
    if (!same) {
      this.setProblem(problem("score"));
      this.offerSoon(delay);
    } else if (this.state.problem?.kind === "score") this.setProblem(null);
  }

  // ----- sharing the tab -------------------------------------------------------------------

  /** The host sends its tab soon, when the guest has another one. */
  private offerSoon(delay: number) {
    if (this.role !== "host" || !this.hooks.tab?.offer || !this.peerCaps.includes("tab")) return;
    clearTimeout(this.offerTimer);
    this.offerTimer = setTimeout(() => void this.offerTab(), delay);
  }

  private offerAgain = false;

  private async offerTab() {
    const offer = this.hooks.tab?.offer;
    const { phase } = this.state;
    if (this.role !== "host" || !offer || !this.wasWelcomed) return;
    if (phase === "closed" || phase === "failed" || phase === "reconnecting") return;
    // One at a time: when this one is done, the guest's answer shows whether another is needed.
    if (this.sender) return;
    if (this.offering) {
      this.offerAgain = true;
      return;
    }
    // Not while playing: a replaced tab stops the guest's playback.
    if (this.hooks.position?.()?.playing) return this.offerSoon(OFFER_RETRY_MS);
    this.offering = true;
    try {
      const payload = await offer();
      if (!payload || !this.wasWelcomed || payload.key === this.peerKey) return;
      if (payload.bytes.length > MAX_TAB_BYTES) {
        return this.setProblem({ kind: "tab", message: tabFailureText("too-big"), fatal: false });
      }
      const tries = this.attempts.get(payload.key) ?? 0;
      if (tries >= MAX_OFFER_TRIES) return;
      this.attempts.set(payload.key, tries + 1);
      const sha = await fileKey(payload.bytes);
      if (!this.wasWelcomed || this.sender) return;
      this.sender = new TabSender((this.offerId += 1), payload, sha, {
        send: (msg) => this.send(msg),
        progress: (transfer) => this.patch({ transfer }),
      });
      this.sender.start();
    } catch {
      this.setProblem({ kind: "tab", message: tabFailureText("failed"), fatal: false });
    } finally {
      this.offering = false;
      if (this.offerAgain) {
        this.offerAgain = false;
        this.offerSoon(0);
      }
    }
  }

  private onTabDone(msg: Extract<Message, { type: "tab-done" }>) {
    const sender = this.sender;
    if (this.role !== "host" || !sender || sender.id !== msg.id) return;
    this.sender = null;
    this.patch({ transfer: null });
    if (!msg.ok) {
      this.setProblem({ kind: "tab", message: tabFailureText(msg.reason ?? ""), fatal: false });
      return;
    }
    // The guest has this version; it says so again when it moves to it (and an edit made
    // meanwhile is offered next).
    this.peerKey = sender.key;
    this.checkScore();
  }

  private onTabAbort(msg: Extract<Message, { type: "tab-abort" }>) {
    if (this.sender?.id === msg.id) {
      this.sender.stop();
      this.sender = null;
      this.patch({ transfer: null });
      this.setProblem({ kind: "tab", message: tabFailureText(msg.reason), fatal: false });
    } else if (this.receiver?.id === msg.id) {
      this.receiver = null;
      this.patch({ transfer: null });
      this.setProblem({ kind: "tab", message: tabFailureText(msg.reason), fatal: false });
    }
  }

  private async onTabOffer(offer: TabOffer) {
    if (this.role !== "guest") return;
    if (this.receiver) this.send({ type: "tab-abort", id: this.receiver.id, reason: "replaced" });
    this.receiver = null;
    if (!this.hooks.tab?.receive) {
      return this.send({ type: "tab-abort", id: offer.id, reason: "unsupported" });
    }
    // Already the same tab: nothing to send.
    if (offer.key === this.score.key) {
      return this.send({ type: "tab-done", id: offer.id, ok: true, reason: "have" });
    }
    const bad = checkOffer(offer);
    if (bad) {
      this.send({ type: "tab-abort", id: offer.id, reason: bad });
      return this.setProblem({ kind: "tab", message: tabFailureText(bad), fatal: false });
    }
    this.receiver = new TabReceiver(offer, {
      send: (msg) => this.send(msg),
      progress: (transfer) => this.patch({ transfer }),
    });
  }

  private async onTabChunk(msg: Extract<Message, { type: "tab-chunk" }>) {
    const receiver = this.receiver;
    if (this.role !== "guest" || !receiver || receiver.id !== msg.id) return;
    const result = receiver.accept(msg);
    if (result.status === "more") return;
    if (result.status === "bad") return this.failReceiving(receiver, result.reason, "abort");
    this.receiver = null;
    const { offer } = receiver;
    if ((await fileKey(result.bytes)) !== offer.sha) {
      return this.failReceiving(receiver, "checksum", "abort");
    }
    const tab = {
      name: offer.name,
      bytes: result.bytes,
      key: offer.key,
      bars: offer.bars,
      from: this.state.peerName ?? "the host",
    };
    const reason = await this.hooks.tab?.receive?.(tab).catch(() => "unreadable");
    if (this.state.phase === "closed" || this.state.phase === "failed") return;
    if (reason) return this.failReceiving(receiver, reason, "done");
    this.send({ type: "tab-done", id: offer.id, ok: true });
    this.patch({ transfer: null });
    // The app opens the tab and moves this session along with it.
    this.hooks.tab?.opened?.();
  }

  private failReceiving(receiver: TabReceiver, reason: string, how: "abort" | "done") {
    if (this.receiver === receiver) this.receiver = null;
    const id = receiver.id;
    this.send(
      how === "abort"
        ? { type: "tab-abort", id, reason }
        : { type: "tab-done", id, ok: false, reason },
    );
    this.patch({ transfer: null });
    this.setProblem({ kind: "tab", message: tabFailureText(reason), fatal: false });
  }

  /** Stops whatever is being shared (the link dropped, the guest left, a new guest came). */
  private dropTransfers() {
    clearTimeout(this.offerTimer);
    this.sender?.stop();
    this.sender = null;
    this.receiver = null;
    this.offerAgain = false;
    if (this.state.transfer) this.patch({ transfer: null });
  }

  // ----- bookkeeping -----------------------------------------------------------------------

  private send(msg: Message) {
    this.transport.send(encode(msg, (this.seq += 1), this.version));
  }

  private setProblem(p: Problem | null) {
    this.patch({ problem: p });
  }

  private patch(change: Partial<SessionState>) {
    this.state = { ...this.state, ...change };
    for (const listener of [...this.listeners]) listener(this.state);
  }

  /** The host's guest left: listen for the next one. */
  private guestGone() {
    this.stopPings();
    this.dropTransfers();
    this.attempts.clear();
    this.peerCaps = [];
    clearTimeout(this.reconnectTimer);
    for (const cancel of this.cancels.values()) cancel();
    this.cancels.clear();
    this.wasWelcomed = false;
    this.peerKey = null;
    this.clock.reset();
    this.latency.reset();
    this.patch({
      phase: "waiting",
      peerName: null,
      peer: null,
      quality: NO_QUALITY,
      latency: this.latency.stats(),
      problem: problem("peer-left"),
    });
  }

  private finish(phase: "closed" | "failed", p: Problem | null) {
    this.stopPings();
    this.dropTransfers();
    clearTimeout(this.reconnectTimer);
    for (const resolve of this.waiting.values()) resolve(false);
    this.waiting.clear();
    for (const cancel of this.cancels.values()) cancel();
    this.cancels.clear();
    this.patch({ phase, problem: p ?? this.state.problem });
    for (const stop of this.unsubscribe.splice(0)) stop();
    this.transport.close();
  }
}

function randomId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
