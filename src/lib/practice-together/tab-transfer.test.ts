import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_TAB_BYTES, TAB_CHUNK_BYTES, TAB_WINDOW, type Message } from "./protocol";
import {
  OFFER_WAIT_MS,
  TabReceiver,
  TabSender,
  checkOffer,
  chunkCount,
  fromBase64,
  tabFailureText,
  toBase64,
  type TabChunk,
  type TabOffer,
  type TabProgress,
} from "./tab-transfer";

const bytesOf = (length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (i * 31 + 7) % 256);

function wire(length: number) {
  const bytes = bytesOf(length);
  const toGuest: Message[] = [];
  const toHost: Message[] = [];
  const sent: TabProgress[] = [];
  const got: TabProgress[] = [];
  const sender = new TabSender(1, { name: "Song", bytes, key: "k", bars: 4 }, "sha", {
    send: (m) => toGuest.push(m),
    progress: (p) => sent.push(p),
  });
  return { bytes, sender, toGuest, toHost, sent, got };
}

const offerOf = (messages: Message[]) => messages[0] as TabOffer;
const chunksOf = (messages: Message[]) =>
  messages.filter((m): m is TabChunk => m.type === "tab-chunk");

describe("base64", () => {
  it("round-trips any bytes, including a long run", () => {
    const bytes = bytesOf(100_000);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it("reads text that is not base64 as null", () => {
    expect(fromBase64("not base64 !!")).toBeNull();
  });

  it("keeps a piece well inside a frame", () => {
    expect(toBase64(bytesOf(TAB_CHUNK_BYTES)).length + 200).toBeLessThan(16 * 1024);
  });
});

describe("the offer", () => {
  it("counts the pieces", () => {
    expect(chunkCount(1)).toBe(1);
    expect(chunkCount(TAB_CHUNK_BYTES)).toBe(1);
    expect(chunkCount(TAB_CHUNK_BYTES + 1)).toBe(2);
  });

  it("refuses an empty, an oversized and an inconsistent offer", () => {
    const offer = (over: Partial<TabOffer>): TabOffer => ({
      type: "tab-offer",
      id: 1,
      name: "x",
      size: 10,
      chunks: 1,
      sha: "s",
      key: "k",
      bars: 1,
      ...over,
    });
    expect(checkOffer(offer({}))).toBeNull();
    expect(checkOffer(offer({ size: 0 }))).toBe("empty");
    expect(
      checkOffer(offer({ size: MAX_TAB_BYTES + 1, chunks: chunkCount(MAX_TAB_BYTES + 1) })),
    ).toBe("too-big");
    expect(checkOffer(offer({ chunks: 5 }))).toBe("malformed");
  });

  it("has words for every reason", () => {
    for (const reason of ["too-big", "corrupt", "checksum", "unreadable", "unsupported", "x"]) {
      expect(tabFailureText(reason).length).toBeGreaterThan(5);
    }
  });
});

describe("sending and receiving", () => {
  it("delivers the same bytes, in pieces, with progress on both ends", () => {
    const { bytes, sender, toGuest, sent } = wire(TAB_CHUNK_BYTES * 2 + 100);
    sender.start();
    sender.ack(0);
    const offer = offerOf(toGuest);
    expect(offer).toMatchObject({ type: "tab-offer", size: bytes.length, chunks: 3, key: "k" });

    const got: TabProgress[] = [];
    const acks: Message[] = [];
    const receiver = new TabReceiver(offer, {
      send: (m) => acks.push(m),
      progress: (p) => got.push(p),
    });
    let result;
    for (const chunk of chunksOf(toGuest)) result = receiver.accept(chunk);
    expect(result).toEqual({ status: "complete", bytes });
    expect(got.at(-1)).toEqual({ direction: "receive", name: "Song", done: 3, total: 3 });
    expect(acks.at(-1)).toEqual({ type: "tab-ack", id: 1, n: 3 });

    sender.ack(3);
    expect(sent.at(-1)).toMatchObject({ direction: "send", done: 3, total: 3 });
  });

  it("sends a window of pieces and the rest as the guest keeps up", () => {
    const pieces = TAB_WINDOW * 2 + 3;
    const { sender, toGuest } = wire(TAB_CHUNK_BYTES * pieces);
    sender.start();
    // Nothing but the offer until the guest answers it.
    expect(chunksOf(toGuest)).toHaveLength(0);
    sender.ack(0);
    expect(chunksOf(toGuest)).toHaveLength(TAB_WINDOW);
    sender.ack(4);
    expect(chunksOf(toGuest)).toHaveLength(TAB_WINDOW + 4);
    sender.ack(pieces);
    expect(chunksOf(toGuest)).toHaveLength(pieces);
    expect(chunksOf(toGuest).map((c) => c.i)).toEqual(Array.from({ length: pieces }, (_, i) => i));
  });

  it("stops sending when stopped", () => {
    const { sender, toGuest } = wire(TAB_CHUNK_BYTES * 20);
    sender.start();
    const before = toGuest.length;
    sender.stop();
    sender.ack(20);
    expect(toGuest).toHaveLength(before);
  });

  it("refuses a piece out of order, of the wrong size or that is not base64", () => {
    const { sender, toGuest } = wire(TAB_CHUNK_BYTES * 2 + 5);
    sender.start();
    sender.ack(0);
    const offer = offerOf(toGuest);
    const [first, second] = chunksOf(toGuest);
    const fresh = () => new TabReceiver(offer, { send: () => {}, progress: () => {} });

    expect(fresh().accept(second!)).toEqual({ status: "bad", reason: "out-of-order" });
    expect(fresh().accept({ ...first!, data: toBase64(bytesOf(10)) })).toEqual({
      status: "bad",
      reason: "corrupt",
    });
    expect(fresh().accept({ ...first!, data: "###" })).toEqual({
      status: "bad",
      reason: "corrupt",
    });
  });

  it("does not answer every piece", () => {
    const { sender, toGuest } = wire(TAB_CHUNK_BYTES * 8);
    sender.start();
    sender.ack(0);
    const acks: Message[] = [];
    const receiver = new TabReceiver(offerOf(toGuest), {
      send: (m) => acks.push(m),
      progress: () => {},
    });
    for (const chunk of chunksOf(toGuest)) receiver.accept(chunk);
    expect(acks.map((a) => (a as { n: number }).n)).toEqual([4, 8]);
  });
});

describe("holding the pieces back", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends nothing but the offer to a guest that says it has the tab", () => {
    const { sender, toGuest } = wire(TAB_CHUNK_BYTES * 4);
    sender.start();
    // The guest answers "have" instead of asking: the host stops, no piece went out.
    sender.stop();
    vi.advanceTimersByTime(OFFER_WAIT_MS * 2);
    expect(toGuest.map((m) => m.type)).toEqual(["tab-offer"]);
  });

  it("sends the pieces after a short wait to a guest that never answers the offer", () => {
    const { sender, toGuest } = wire(TAB_CHUNK_BYTES * 4);
    sender.start();
    vi.advanceTimersByTime(OFFER_WAIT_MS - 1);
    expect(chunksOf(toGuest)).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(chunksOf(toGuest)).toHaveLength(4);
  });
});
