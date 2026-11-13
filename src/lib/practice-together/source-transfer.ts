/**
 * Practice together: sharing the audio files of the lanes (ADR 0005). The lanes themselves travel
 * as operations (see `audio-lanes/collab.ts`); the files they play are too big for that, so each
 * one moves once, by its content id (the SHA-256 of its bytes), in pieces, on its own.
 *
 * Every player runs a {@link SourceSync}. It knows which files the shared lanes need and which of
 * them are loaded here, tells the others what it has (`src-have`), asks a player that has a missing
 * file for it (`src-want`) and serves the files the others ask for. A guest only talks to the
 * host; the host talks to every guest, so a file a guest adds goes to the host first and the host
 * hands it on to the others. The receiver says how far it got (`src-ack`), so a transfer that
 * stops starts again where it stopped, and the sender never has more than a window of pieces on
 * the way.
 *
 * The host also knows who has what, which is what lets it hold the start back until everyone has
 * every file ({@link SourceSync.everyoneHas}).
 */
import {
  MAX_SOURCE_BYTES,
  MAX_SOURCE_FILES,
  SESSION_DECODED_QUOTA,
  SESSION_SOURCE_QUOTA,
  SOURCE_CHUNK_BYTES,
  SOURCE_IDS_PER_MESSAGE,
  SOURCE_WINDOW,
  type SourceMessage,
} from "@/lib/practice-together/protocol";
import { fromBase64, toBase64 } from "@/lib/practice-together/tab-transfer";

/** What the transfer needs from the audio engine's side (Rust commands in the app). */
export interface SourceIo {
  /** The size of a file loaded here, null when it is not. */
  size(id: string): Promise<number | null>;
  chunk(id: string, offset: number, len: number): Promise<Uint8Array>;
  /** Starts or continues an incoming file: the bytes staged already. */
  stageBegin(id: string, size: number): Promise<number>;
  /** Adds the piece at `offset`: the bytes staged now. */
  stageAppend(id: string, offset: number, bytes: Uint8Array): Promise<number>;
  /**
   * Checks the staged file against its id and loads it. Resolves with the bytes the decoded file
   * holds, when known (the session counts them against {@link SESSION_DECODED_QUOTA}).
   */
  stageFinish(id: string, name: string): Promise<number | undefined | void>;
  stageAbort(id?: string): Promise<void>;
}

export interface SourceLink {
  /** Says something to one player (a guest: the host is the only one). */
  send(peer: string, msg: SourceMessage): void;
}

export interface SourceSyncOptions {
  io: SourceIo;
  link: SourceLink;
  /** The host also starts the files other players send, and holds starts back. */
  role: "host" | "guest";
  /** True while the pieces should wait (the song plays: its timing comes first). */
  paused?: () => boolean;
  /** Something changed that the page shows (progress, who has what). */
  changed?: () => void;
  /** A file arrived and is loaded here. */
  arrived?: (id: string) => void;
  now?: () => number;
  /** The most bytes taken in from, and sent to, each player in a session (default {@link SESSION_SOURCE_QUOTA}). */
  quota?: number;
  /** The most decoded audio taken in (default {@link SESSION_DECODED_QUOTA}). */
  decodedQuota?: number;
  /** How often stuck transfers are looked at (ms). */
  watchMs?: number;
}

/** One file coming in. */
interface Download {
  peer: string;
  name: string;
  size: number;
  /** Bytes staged. */
  have: number;
  asked: number;
  lastProgress: number;
  /** Pieces arrive in order: they are handled one after the other. */
  queue: Promise<void>;
  sinceAck: number;
  /** The place a lost piece was reported at (so it is reported once). */
  rewoundAt: number;
}

/** One file going out. */
interface Upload {
  peer: string;
  id: string;
  size: number;
  sent: number;
  acked: number;
  lastAck: number;
  busy: boolean;
}

/** A transfer as the page shows it. */
export interface TransferInfo {
  id: string;
  name: string;
  direction: "in" | "out";
  /** The other player (a guest's id; "host" for a guest). */
  peer: string;
  done: number;
  size: number;
}

export interface SourceSyncState {
  /** Files the lanes need that are not loaded here and are on their way (or will be). */
  waiting: ReadonlySet<string>;
  /** Files that could not be moved, with why (each file once; a player's failure counts too). */
  failed: { id: string; name: string; reason: string }[];
  transfers: TransferInfo[];
  /** The host: whether every player has every file. A guest: whether this player has them all. */
  complete: boolean;
}

const HOST = "host";
const REASONS: Record<string, string> = {
  quota: "too much audio has been sent in this session",
  "too-big": "the file is too large",
  unavailable: "nobody has it",
  checksum: "it arrived damaged",
  failed: "it could not be taken in",
};

/** How many files are taken in at once. */
export const MAX_PARALLEL_DOWNLOADS = 2;

/** How long a file that nobody has stays "on the way" before it is reported as lost. */
export const MISSING_GRACE_MS = 8_000;

export const sourceReasonText = (reason: string): string => REASONS[reason] ?? reason;

/** The short code a failure is told to the other end as (never a message with a path in it). */
function codeOf(reason: string): string {
  if (reason in REASONS) return reason;
  if (/damaged|not the file that was offered/i.test(reason)) return "checksum";
  if (/too much audio/i.test(reason)) return "quota";
  return "failed";
}

export class SourceSync {
  private readonly io: SourceIo;
  private readonly link: SourceLink;
  private readonly role: "host" | "guest";
  private readonly options: SourceSyncOptions;
  private readonly now: () => number;
  private readonly quota: number;
  private readonly decodedQuota: number;

  /** What the shared lanes need (id to the name a lane calls it). */
  private needed = new Map<string, string>();
  /** The name each file is loaded under (with its extension: the audio engine reads the type from it). */
  private files = new Map<string, string>();
  /** Files loaded here. */
  private readonly have = new Set<string>();
  private readonly peers = new Set<string>();
  private readonly theirHave = new Map<string, Set<string>>();
  private readonly told = new Map<string, Set<string>>();
  private readonly downloads = new Map<string, Download>();
  private readonly uploads = new Map<string, Upload>();
  private readonly failed = new Map<string, string>();
  /** The host: a file that a player could not take in (`peer:id`), as that player said. */
  private readonly peerFailed = new Map<string, { peer: string; id: string; reason: string }>();
  /** The host: since when a needed file has nobody who can provide it. */
  private readonly missingSince = new Map<string, number>();
  /** Bytes taken in (the session's quota) and the decoded audio they came to. */
  private bytesIn = 0;
  private decodedIn = 0;
  /** Bytes sent to each player, and how far each file was sent to each (a resend is not new). */
  private readonly bytesOut = new Map<string, number>();
  private readonly charged = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ended = false;
  private cached: SourceSyncState | null = null;
  private lastWaiting: ReadonlySet<string> = new Set();
  private readonly listeners = new Set<() => void>();

  constructor(options: SourceSyncOptions) {
    this.options = options;
    this.io = options.io;
    this.link = options.link;
    this.role = options.role;
    this.now = options.now ?? (() => Date.now());
    this.quota = options.quota ?? SESSION_SOURCE_QUOTA;
    this.decodedQuota = options.decodedQuota ?? SESSION_DECODED_QUOTA;
    this.timer = setInterval(() => this.watch(), options.watchMs ?? 2_000);
  }

  /** Stops: transfers in progress are given up and the staged parts go. */
  end(): void {
    this.ended = true;
    clearInterval(this.timer);
    this.downloads.clear();
    this.uploads.clear();
    void this.io.stageAbort().catch(() => {});
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    this.cached = null;
    this.options.changed?.();
    for (const listener of [...this.listeners]) listener();
  }

  // ----- what the lanes need -------------------------------------------------------------------

  /**
   * The shared lanes' files (only ones with a content id) and which of them are loaded here.
   * Called whenever either changes.
   */
  setNeeded(
    sources: readonly { id: string; name: string; file?: string }[],
    loaded: Iterable<string>,
  ): void {
    if (this.ended) return;
    const next = new Map<string, string>();
    const files = new Map<string, string>();
    for (const source of sources) {
      if (/^[0-9a-f]{64}$/.test(source.id) && next.size < MAX_SOURCE_FILES) {
        next.set(source.id, source.name);
        files.set(source.id, source.file ?? source.name);
      }
    }
    this.needed = next;
    this.files = files;
    for (const id of [...this.failed.keys()]) if (!next.has(id)) this.failed.delete(id);
    for (const [key, failure] of this.peerFailed)
      if (!next.has(failure.id)) this.peerFailed.delete(key);
    for (const id of [...this.missingSince.keys()]) if (!next.has(id)) this.missingSince.delete(id);
    for (const id of loaded) {
      this.have.add(id);
      // The file turned up here after all (it only took a while to open).
      if (this.failed.get(id) === "unavailable") this.failed.delete(id);
    }
    // A file a lane no longer plays is not transferred any more.
    for (const [id, download] of this.downloads) {
      if (!next.has(id)) this.dropDownload(id, download);
    }
    this.reconcile();
  }

  /** A player joined (or came back): it hears what this one has. */
  peerJoined(peer: string): void {
    if (this.ended) return;
    this.peers.add(peer);
    this.told.set(peer, new Set());
    this.reconcile();
  }

  peerLeft(peer: string): void {
    this.peers.delete(peer);
    this.theirHave.delete(peer);
    this.told.delete(peer);
    for (const [key, failure] of this.peerFailed)
      if (failure.peer === peer) this.peerFailed.delete(key);
    for (const [key, upload] of this.uploads) if (upload.peer === peer) this.uploads.delete(key);
    for (const [id, download] of this.downloads) {
      if (download.peer === peer) this.dropDownload(id, download);
    }
    this.reconcile();
  }

  private dropDownload(id: string, download: Download) {
    this.downloads.delete(id);
    void this.io.stageAbort(id).catch(() => {});
    this.link.send(download.peer, { type: "src-done", id, ok: false, reason: "cancelled" });
  }

  // ----- deciding what to do ---------------------------------------------------------------------

  private reconcile() {
    if (this.ended) return;
    this.announce();
    for (const [id, name] of this.needed) {
      if (this.have.has(id) || this.downloads.has(id) || this.failed.has(id)) continue;
      const peer = [...this.peers].find((p) => this.theirHave.get(p)?.has(id));
      if (peer === undefined) continue;
      // A few files at a time: the next one starts when one ends, so the quotas are checked with
      // what the earlier ones came to (hundreds announced at once would all pass the check).
      if (this.downloads.size >= MAX_PARALLEL_DOWNLOADS) break;
      if (this.bytesIn >= this.quota || this.decodedIn >= this.decodedQuota) {
        this.failed.set(id, "quota");
        continue;
      }
      this.downloads.set(id, {
        peer,
        name,
        size: 0,
        have: 0,
        asked: this.now(),
        lastProgress: this.now(),
        queue: Promise.resolve(),
        sinceAck: 0,
        rewoundAt: -1,
      });
      this.link.send(peer, { type: "src-want", id });
    }
    this.changed();
  }

  /** Tells every player which of the needed files this one has, once each. */
  private announce() {
    const mine = [...this.have].filter((id) => this.needed.has(id));
    for (const peer of this.peers) {
      const told = this.told.get(peer) ?? new Set<string>();
      this.told.set(peer, told);
      const fresh = mine.filter((id) => !told.has(id));
      for (let i = 0; i < fresh.length; i += SOURCE_IDS_PER_MESSAGE) {
        const ids = fresh.slice(i, i + SOURCE_IDS_PER_MESSAGE);
        this.link.send(peer, { type: "src-have", ids });
        for (const id of ids) told.add(id);
      }
    }
  }

  // ----- messages ----------------------------------------------------------------------------------

  receive(peer: string, msg: SourceMessage): void {
    if (this.ended) return;
    switch (msg.type) {
      case "src-have": {
        const set = this.theirHave.get(peer) ?? new Set<string>();
        this.theirHave.set(peer, set);
        for (const id of msg.ids) {
          set.add(id);
          // This player has it now: whatever went wrong before is over, and a file nobody had is found.
          this.peerFailed.delete(`${peer}:${id}`);
          if (this.failed.get(id) === "unavailable") this.failed.delete(id);
        }
        this.reconcile();
        return;
      }
      case "src-want":
        return void this.serve(peer, msg.id);
      case "src-offer":
        return void this.onOffer(peer, msg.id, msg.size, msg.refuse);
      case "src-ack":
        return this.onAck(peer, msg.id, msg.n, msg.rewind === true);
      case "src-chunk":
        return this.onChunk(peer, msg.id, msg.off, msg.data);
      case "src-done": {
        this.uploads.delete(`${peer}:${msg.id}`);
        const key = `${peer}:${msg.id}`;
        if (msg.ok) this.peerFailed.delete(key);
        // A player that gave a file up because no lane plays it any more has not failed.
        else if (msg.reason !== "cancelled" && this.needed.has(msg.id)) {
          this.peerFailed.set(key, { peer, id: msg.id, reason: codeOf(msg.reason ?? "failed") });
        }
        this.changed();
        return;
      }
    }
  }

  /** A player asks for a file. */
  private async serve(peer: string, id: string) {
    const size = this.have.has(id) ? await this.io.size(id).catch(() => null) : null;
    if (this.ended) return;
    if (size === null || size <= 0) {
      this.link.send(peer, { type: "src-offer", id, size: 0 });
      return;
    }
    // Each player has a quota of its own, and what was sent to it already does not count twice.
    const sentBefore = Math.min(this.charged.get(`${peer}:${id}`) ?? 0, size);
    if ((this.bytesOut.get(peer) ?? 0) + (size - sentBefore) > this.quota) {
      this.link.send(peer, { type: "src-offer", id, size: 0, refuse: "quota" });
      return;
    }
    this.uploads.set(`${peer}:${id}`, {
      peer,
      id,
      size,
      sent: 0,
      acked: 0,
      lastAck: this.now(),
      busy: false,
    });
    this.link.send(peer, { type: "src-offer", id, size });
    this.changed();
  }

  private async onOffer(peer: string, id: string, size: number, refuse?: "quota") {
    const download = this.downloads.get(id);
    if (!download || download.peer !== peer) return;
    if (size <= 0 && refuse === "quota") {
      // The sender has sent this player all it may: asking again will not change that, and it
      // does have the file, so this is not "nobody has it".
      return this.fail(id, download, "quota", false);
    }
    if (size <= 0) {
      // That player does not have it after all: ask another one, or give up.
      this.downloads.delete(id);
      this.theirHave.get(peer)?.delete(id);
      const another = [...this.peers].some((p) => p !== peer && this.theirHave.get(p)?.has(id));
      if (!another) this.failed.set(id, "unavailable");
      this.reconcile();
      return;
    }
    if (size > MAX_SOURCE_BYTES) return this.fail(id, download, "too-big");
    if (this.bytesIn + size > this.quota || this.decodedIn >= this.decodedQuota) {
      return this.fail(id, download, "quota");
    }
    try {
      download.size = size;
      download.have = await this.io.stageBegin(id, size);
    } catch (error) {
      return this.fail(id, download, error instanceof Error ? error.message : "failed");
    }
    download.lastProgress = this.now();
    if (download.have >= size) return void this.finish(id, download);
    this.link.send(peer, { type: "src-ack", id, n: download.have });
    this.changed();
  }

  private onChunk(peer: string, id: string, off: number, data: string) {
    const download = this.downloads.get(id);
    if (!download || download.peer !== peer || download.size === 0) return;
    // One piece at a time, in the order they came.
    download.queue = download.queue.then(() => this.takePiece(id, download, off, data));
  }

  private async takePiece(id: string, download: Download, off: number, data: string) {
    if (this.ended || this.downloads.get(id) !== download) return;
    if (off !== download.have) {
      // A piece went missing or came twice: say how far this end got, once for each place it
      // stopped at (the pieces already on the way would otherwise each say it again).
      if (off > download.have && download.rewoundAt !== download.have) {
        download.rewoundAt = download.have;
        this.link.send(download.peer, { type: "src-ack", id, n: download.have, rewind: true });
      }
      return;
    }
    const bytes = fromBase64(data);
    if (!bytes || bytes.length === 0 || bytes.length > SOURCE_CHUNK_BYTES) {
      return this.fail(id, download, "malformed");
    }
    if (off + bytes.length > download.size) return this.fail(id, download, "too-big");
    try {
      download.have = await this.io.stageAppend(id, off, bytes);
    } catch (error) {
      return this.fail(id, download, error instanceof Error ? error.message : "failed");
    }
    this.bytesIn += bytes.length;
    download.lastProgress = this.now();
    download.sinceAck += 1;
    if (download.have >= download.size) return void (await this.finish(id, download));
    if (download.sinceAck >= SOURCE_WINDOW / 2) {
      download.sinceAck = 0;
      this.link.send(download.peer, { type: "src-ack", id, n: download.have });
    }
    this.changed();
  }

  private async finish(id: string, download: Download) {
    try {
      const decoded = await this.io.stageFinish(id, this.files.get(id) ?? download.name);
      // The decoded size when the engine says it; else a generous guess from the file's size.
      this.decodedIn += typeof decoded === "number" ? decoded : download.size * 12;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "checksum";
      return this.fail(id, download, reason);
    }
    if (this.ended) return;
    this.downloads.delete(id);
    this.have.add(id);
    this.link.send(download.peer, { type: "src-done", id, ok: true });
    this.options.arrived?.(id);
    // A file this end has now is told to the others (the host hands a guest's file on).
    this.reconcile();
  }

  private fail(id: string, download: Download, reason: string, tell = true) {
    if (this.downloads.get(id) === download) this.downloads.delete(id);
    if (tell) {
      this.link.send(download.peer, { type: "src-done", id, ok: false, reason: codeOf(reason) });
    }
    this.failed.set(id, reason);
    void this.io.stageAbort(id).catch(() => {});
    this.changed();
  }

  private onAck(peer: string, id: string, n: number, rewind: boolean) {
    const upload = this.uploads.get(`${peer}:${id}`);
    if (!upload) return;
    upload.lastAck = this.now();
    upload.acked = Math.min(n, upload.size);
    // The receiver has more than was sent (a transfer that goes on where it stopped), or says a
    // piece went missing: sending goes on from where it is.
    if (upload.sent < upload.acked || rewind) upload.sent = upload.acked;
    void this.pump(upload);
  }

  /** Sends pieces while fewer than a window are unacknowledged. */
  private async pump(upload: Upload) {
    if (upload.busy) return;
    upload.busy = true;
    try {
      while (
        !this.ended &&
        this.uploads.get(`${upload.peer}:${upload.id}`) === upload &&
        upload.sent < upload.size &&
        upload.sent - upload.acked < SOURCE_WINDOW * SOURCE_CHUNK_BYTES &&
        !this.options.paused?.()
      ) {
        const at = upload.sent;
        const bytes = await this.io.chunk(upload.id, at, SOURCE_CHUNK_BYTES);
        if (this.ended || this.uploads.get(`${upload.peer}:${upload.id}`) !== upload) break;
        // The receiver may have said it is behind while this piece was read.
        if (at !== upload.sent || bytes.length === 0) break;
        this.link.send(upload.peer, {
          type: "src-chunk",
          id: upload.id,
          off: at,
          data: toBase64(bytes),
        });
        upload.sent += bytes.length;
        // Only bytes this player has not been sent before count (a resend is free).
        const key = `${upload.peer}:${upload.id}`;
        const before = this.charged.get(key) ?? 0;
        if (upload.sent > before) {
          this.charged.set(key, upload.sent);
          this.bytesOut.set(
            upload.peer,
            (this.bytesOut.get(upload.peer) ?? 0) + upload.sent - before,
          );
        }
      }
    } catch {
      this.link.send(upload.peer, { type: "src-offer", id: upload.id, size: 0 });
      this.uploads.delete(`${upload.peer}:${upload.id}`);
    } finally {
      upload.busy = false;
      this.changed();
    }
  }

  /**
   * Looks for transfers that stopped (asks again, or sends the pieces again) and, on the host, for
   * a file nobody can provide any more. Runs on a timer; public so a test can run it.
   */
  watch(): void {
    if (this.ended) return;
    const now = this.now();
    this.checkMissing(now);
    for (const [id, download] of this.downloads) {
      if (now - download.lastProgress > 6_000) {
        download.lastProgress = now;
        // Starting again continues where the staged file ends.
        download.queue = Promise.resolve();
        download.size = 0;
        this.link.send(download.peer, { type: "src-want", id });
      }
    }
    for (const upload of this.uploads.values()) {
      if (this.options.paused?.()) continue;
      if (upload.sent > upload.acked && now - upload.lastAck > 6_000) {
        upload.lastAck = now;
        upload.sent = upload.acked;
      }
      void this.pump(upload);
    }
  }

  /**
   * The host: a needed file that it does not have, is not being sent and that no player has
   * announced (its only holder left, or never had it) is reported as lost after a moment, so Play's
   * message can say what to do instead of "still on the way" for ever. The moment lets a file that
   * is only being opened here, or announced by a player a little later, turn up first.
   */
  private checkMissing(now: number) {
    if (this.role !== "host" || this.peers.size === 0) return;
    let changed = false;
    for (const id of this.needed.keys()) {
      const providable =
        this.have.has(id) ||
        this.downloads.has(id) ||
        this.failed.has(id) ||
        [...this.peers].some((p) => this.theirHave.get(p)?.has(id));
      if (providable) {
        this.missingSince.delete(id);
        continue;
      }
      const since = this.missingSince.get(id) ?? now;
      this.missingSince.set(id, since);
      if (now - since >= MISSING_GRACE_MS) {
        this.failed.set(id, "unavailable");
        this.missingSince.delete(id);
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  // ----- what the page shows ---------------------------------------------------------------------

  /** Files the lanes need that this player does not have yet and does not know to be lost. */
  private waiting(): Set<string> {
    const ids = new Set<string>();
    for (const id of this.needed.keys()) {
      if (this.have.has(id) || this.failed.has(id)) continue;
      // A guest gets everything from the host; the host only waits for a file it is being sent.
      if (this.role === "guest" || this.downloads.has(id)) ids.add(id);
    }
    return ids;
  }

  /** The host: every player has every file. A guest: this player has them all. */
  get complete(): boolean {
    for (const id of this.needed.keys()) {
      if (!this.have.has(id)) return false;
      if (this.role === "host") {
        for (const peer of this.peers) if (!this.theirHave.get(peer)?.has(id)) return false;
      }
    }
    return true;
  }

  /** Who still lacks what, for the host's message ("Dana is still getting Drums"). */
  lacking(): { peer: string; id: string; name: string }[] {
    const list: { peer: string; id: string; name: string }[] = [];
    for (const [id, name] of this.needed) {
      for (const peer of this.peers) {
        if (this.role === "host" && !this.theirHave.get(peer)?.has(id))
          list.push({ peer, id, name });
      }
      if (!this.have.has(id)) list.push({ peer: HOST, id, name });
    }
    return list;
  }

  /** Each file that could not be moved once: this player's own failure first, then a player's. */
  private failedList(): SourceSyncState["failed"] {
    const list = new Map<string, string>(this.failed);
    for (const failure of this.peerFailed.values()) {
      if (!list.has(failure.id)) list.set(failure.id, failure.reason);
    }
    return [...list].map(([id, reason]) => ({
      id,
      name: this.needed.get(id) ?? "audio file",
      reason,
    }));
  }

  /** What the page needs to draw (the same object until something changes). */
  state(): SourceSyncState {
    if (this.cached) return this.cached;
    const transfers: TransferInfo[] = [
      ...[...this.downloads].map(([id, d]) => ({
        id,
        name: d.name,
        direction: "in" as const,
        peer: d.peer,
        done: d.have,
        size: d.size,
      })),
      ...[...this.uploads.values()].map((u) => ({
        id: u.id,
        name: this.needed.get(u.id) ?? "audio file",
        direction: "out" as const,
        peer: u.peer,
        done: u.acked,
        size: u.size,
      })),
    ];
    // The set keeps its identity until it really changes: the lanes open files again whenever it
    // is a new object.
    const waiting = this.waiting();
    if (
      waiting.size !== this.lastWaiting.size ||
      [...waiting].some((id) => !this.lastWaiting.has(id))
    ) {
      this.lastWaiting = waiting;
    }
    this.cached = {
      waiting: this.lastWaiting,
      failed: this.failedList(),
      transfers,
      complete: this.complete,
    };
    return this.cached;
  }
}

/** Keeps what the other end said about audio files until the sharing that listens is ready. */
export class SourceInbox {
  private handler: ((msg: SourceMessage) => void) | null = null;
  private queue: SourceMessage[] = [];

  private welcomeHandler: (() => void) | null = null;

  /** The host welcomed this guest (and said what its app can do). */
  welcomed(): void {
    this.welcomeHandler?.();
  }

  onWelcome(handler: (() => void) | null): void {
    this.welcomeHandler = handler;
  }

  push(msg: SourceMessage): void {
    if (this.handler) return this.handler(msg);
    this.queue.push(msg);
    if (this.queue.length > 300) this.queue.shift();
  }

  /** Starts (or, with null, stops) listening; what arrived before is handed over now. */
  listen(handler: ((msg: SourceMessage) => void) | null): void {
    this.handler = handler;
    if (!handler) return;
    for (const msg of this.queue.splice(0)) handler(msg);
  }

  clear(): void {
    this.queue = [];
  }
}
