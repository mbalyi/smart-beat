/**
 * Practice together: sharing the host's tab with the guest. The tab travels as a Guitar Pro file
 * in small pieces (a frame holds 16 K characters), a few at a time, and is checked against a
 * SHA-256 before the guest opens it. This file has no clock and no network: the session plugs
 * in `send` and reads the progress.
 */
import {
  MAX_TAB_BYTES,
  TAB_CHUNK_BYTES,
  TAB_WINDOW,
  type Message,
} from "@/lib/practice-together/protocol";

/** What the host shares: the open score as a Guitar Pro file, and the fingerprint it matches. */
export interface TabPayload {
  /** The song's name, shown to the guest. */
  name: string;
  bytes: Uint8Array;
  /** The score fingerprint of this version (what both apps compare). */
  key: string;
  bars: number;
}

/** A tab the guest received whole and checked. */
export interface ReceivedTab extends TabPayload {
  /** The host's name. */
  from: string;
}

/** How far a transfer is, for the dialog. */
export interface TabProgress {
  direction: "send" | "receive";
  name: string;
  /** Pieces done: acknowledged (sending) or received. */
  done: number;
  total: number;
}

export type TabOffer = Extract<Message, { type: "tab-offer" }>;
export type TabChunk = Extract<Message, { type: "tab-chunk" }>;

interface Io {
  send(msg: Message): void;
  progress(progress: TabProgress): void;
}

export const chunkCount = (size: number): number => Math.ceil(size / TAB_CHUNK_BYTES);

export function toBase64(bytes: Uint8Array): string {
  let text = "";
  // Small steps keep `String.fromCharCode` far from the argument limit.
  for (let i = 0; i < bytes.length; i += 0x2000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  }
  return btoa(text);
}

/** The bytes of a base64 text, or null when it is not base64. */
export function fromBase64(text: string): Uint8Array | null {
  try {
    const raw = atob(text);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Why an offer cannot be taken (null when it can). The guest refuses an offer like this. */
export function checkOffer(offer: TabOffer): string | null {
  if (!Number.isInteger(offer.size) || offer.size <= 0) return "empty";
  if (offer.size > MAX_TAB_BYTES) return "too-big";
  if (offer.chunks !== chunkCount(offer.size)) return "malformed";
  return null;
}

/** The host's end: sends the offer, then the pieces as the guest keeps up. */
export class TabSender {
  readonly id: number;
  readonly total: number;
  private readonly payload: TabPayload;
  private readonly sha: string;
  private readonly io: Io;
  private next = 0;
  private acked = 0;
  private ended = false;

  constructor(id: number, payload: TabPayload, sha: string, io: Io) {
    this.id = id;
    this.payload = payload;
    this.sha = sha;
    this.io = io;
    this.total = chunkCount(payload.bytes.length);
  }

  /** The key of the version being sent. */
  get key(): string {
    return this.payload.key;
  }

  start() {
    this.io.send({
      type: "tab-offer",
      id: this.id,
      name: this.payload.name,
      size: this.payload.bytes.length,
      chunks: this.total,
      sha: this.sha,
      key: this.payload.key,
      bars: this.payload.bars,
    });
    this.report();
    this.pump();
  }

  /** The guest has the first `n` pieces. */
  ack(n: number) {
    if (this.ended) return;
    this.acked = Math.max(this.acked, Math.min(n, this.total));
    this.report();
    this.pump();
  }

  stop() {
    this.ended = true;
  }

  private pump() {
    while (!this.ended && this.next < this.total && this.next - this.acked < TAB_WINDOW) {
      const from = this.next * TAB_CHUNK_BYTES;
      const part = this.payload.bytes.subarray(from, from + TAB_CHUNK_BYTES);
      this.io.send({ type: "tab-chunk", id: this.id, i: this.next, data: toBase64(part) });
      this.next += 1;
    }
  }

  private report() {
    this.io.progress({
      direction: "send",
      name: this.payload.name,
      done: this.acked,
      total: this.total,
    });
  }
}

export type ChunkResult =
  | { status: "more" }
  | { status: "bad"; reason: string }
  | { status: "complete"; bytes: Uint8Array };

/** The guest's end: collects the pieces in order. */
export class TabReceiver {
  readonly offer: TabOffer;
  private readonly io: Io;
  private parts: Uint8Array[] = [];
  private received = 0;

  constructor(offer: TabOffer, io: Io) {
    this.offer = offer;
    this.io = io;
    this.report();
  }

  get id(): number {
    return this.offer.id;
  }

  /** Takes piece `msg.i`. Pieces come in order; anything else ends the transfer. */
  accept(msg: TabChunk): ChunkResult {
    if (msg.i !== this.parts.length) return { status: "bad", reason: "out-of-order" };
    const part = fromBase64(msg.data);
    const last = msg.i === this.offer.chunks - 1;
    const expected = last ? this.offer.size - msg.i * TAB_CHUNK_BYTES : TAB_CHUNK_BYTES;
    if (!part || part.length !== expected) return { status: "bad", reason: "corrupt" };
    this.parts.push(part);
    this.received += part.length;
    const n = this.parts.length;
    this.report();
    // Not every piece needs an answer; the host's window is much bigger than this step.
    if (n % 4 === 0 || last) this.io.send({ type: "tab-ack", id: this.id, n });
    if (!last) return { status: "more" };
    const bytes = new Uint8Array(this.received);
    let at = 0;
    for (const p of this.parts) {
      bytes.set(p, at);
      at += p.length;
    }
    this.parts = [];
    return { status: "complete", bytes };
  }

  private report() {
    this.io.progress({
      direction: "receive",
      name: this.offer.name,
      done: this.parts.length,
      total: this.offer.chunks,
    });
  }
}

/** A readable reason for a transfer that failed. */
export function tabFailureText(reason: string): string {
  switch (reason) {
    case "too-big":
      return "The tab is too big to share.";
    case "corrupt":
    case "out-of-order":
    case "malformed":
    case "checksum":
      return "The tab arrived damaged. Try again.";
    case "unreadable":
      return "The tab could not be opened on this computer.";
    case "unsupported":
      return "The other Smart Beat cannot receive a tab. Update both apps.";
    case "empty":
      return "The tab was empty.";
    default:
      return "The tab could not be shared.";
  }
}
