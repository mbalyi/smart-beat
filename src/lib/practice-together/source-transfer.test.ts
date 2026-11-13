import {
  decode,
  encode,
  SOURCE_CHUNK_BYTES,
  SOURCE_WINDOW,
} from "@/lib/practice-together/protocol";
import type { SourceMessage } from "@/lib/practice-together/protocol";
import { MAX_SOURCE_FILES } from "@/lib/practice-together/protocol";
import {
  MAX_PARALLEL_DOWNLOADS,
  MAX_PARALLEL_UPLOADS,
  MAX_RETRIES,
  MISSING_GRACE_MS,
  RETRY_BACKOFF_MS,
  SourceSync,
  type SourceIo,
} from "@/lib/practice-together/source-transfer";

/** A file with a made-up content id (the real id is a SHA-256; here only its shape matters). */
const idOf = (n: number) => n.toString(16).padStart(64, "0");

/** One player's audio engine: files loaded, files being received. */
class FakeIo implements SourceIo {
  files = new Map<string, Uint8Array>();
  staged = new Map<string, Uint8Array>();
  badChecksum = false;
  /** The next finish fails as a damaged file (and the one after it is fine). */
  badChecksumOnce = false;
  /** The next piece written fails as a disk error (and the ones after it are fine). */
  failAppendOnce = false;
  /** The finish waits until this is released (a big file takes a while to check and load). */
  holdFinish: Promise<void> | null = null;
  finishes = 0;
  /** What a finished file decodes to (bytes), as the engine would say. */
  decoded: number | undefined = undefined;
  aborted: (string | undefined)[] = [];
  async size(id: string) {
    return this.files.get(id)?.length ?? null;
  }
  async chunk(id: string, offset: number, len: number) {
    return this.files.get(id)!.slice(offset, offset + len);
  }
  async stageBegin(id: string, size: number) {
    const have = this.staged.get(id);
    if (have && have.length > size) this.staged.delete(id);
    return this.staged.get(id)?.length ?? 0;
  }
  async stageAppend(id: string, offset: number, bytes: Uint8Array) {
    if (this.failAppendOnce) {
      this.failAppendOnce = false;
      throw new Error("No space left on device");
    }
    const have = this.staged.get(id) ?? new Uint8Array();
    if (have.length !== offset) throw new Error("offset");
    const next = new Uint8Array(have.length + bytes.length);
    next.set(have);
    next.set(bytes, have.length);
    this.staged.set(id, next);
    return next.length;
  }
  async stageFinish(id: string) {
    this.finishes += 1;
    if (this.holdFinish) await this.holdFinish;
    const bytes = this.staged.get(id)!;
    this.staged.delete(id);
    if (this.badChecksumOnce) {
      this.badChecksumOnce = false;
      throw new Error("It arrived damaged");
    }
    if (this.badChecksum) throw new Error("It arrived damaged");
    this.files.set(id, bytes);
    return this.decoded;
  }
  async stageAbort(id?: string) {
    this.aborted.push(id);
    if (id) this.staged.delete(id);
    else this.staged.clear();
  }
}

const bytesOf = (n: number, seed = 1) =>
  Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) % 256);

interface Player {
  io: FakeIo;
  sync: SourceSync;
  arrived: string[];
  paused: boolean;
}

/** A host and guests, linked through a queue: nothing arrives until `settle`. */
function network(
  options: { quota?: number; decodedQuota?: number; guests?: string[]; clock?: { t: number } } = {},
) {
  const queue: { to: string; from: string; text: string }[] = [];
  const sent: SourceMessage[] = [];
  /** Messages this test drops on the way. */
  let drop: ((msg: SourceMessage, from: string, to: string) => boolean) | null = null;
  const players = new Map<string, Player>();
  let maxInFlight = 0;
  const inFlight = new Map<string, number>();

  function add(id: string, role: "host" | "guest", quota?: number, decodedQuota?: number) {
    const io = new FakeIo();
    const player = { io, arrived: [] as string[], paused: false } as Player;
    player.sync = new SourceSync({
      io,
      role,
      quota,
      decodedQuota,
      now: options.clock ? () => options.clock!.t : undefined,
      link: {
        send: (peer, msg) => {
          // Every message must survive the real frame: encode and decode it.
          const text = encode(msg, 1);
          expect(text.length).toBeLessThanOrEqual(16 * 1024);
          sent.push(msg);
          if (drop?.(msg, id, peer)) return;
          queue.push({ to: peer, from: id, text });
        },
      },
      paused: () => player.paused,
      arrived: (file) => player.arrived.push(file),
      watchMs: 1_000_000,
    });
    players.set(id, player);
    return player;
  }
  const host = add("host", "host", options.quota, options.decodedQuota);
  const guests = (options.guests ?? ["g1"]).map((id) =>
    add(id, "guest", options.quota, options.decodedQuota),
  );
  // A guest talks to "host"; the host talks to a guest by its id.
  const ids = options.guests ?? ["g1"];
  for (const id of ids) {
    host.sync.peerJoined(id);
    players.get(id)!.sync.peerJoined("host");
  }

  async function settle(rounds = 400) {
    let quiet = 0;
    for (let i = 0; i < rounds && quiet < 3; i++) {
      const batch = queue.splice(0);
      for (const item of batch) {
        const msg = decode(item.text)!.msg as SourceMessage;
        if (msg.type === "src-chunk") {
          const key = `${item.from}>${item.to}:${msg.id}`;
          inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
          maxInFlight = Math.max(maxInFlight, inFlight.get(key)!);
        }
        if (msg.type === "src-ack") inFlight.set(`${item.to}>${item.from}:${msg.id}`, 0);
        // A guest's peer is "host", the host's peer is the guest: both read the sender's id as `from`.
        players.get(item.to)!.sync.receive(item.from, msg);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      quiet = batch.length === 0 && queue.length === 0 ? quiet + 1 : 0;
    }
  }
  return {
    host,
    guest: (id = "g1") => players.get(id)!,
    guests,
    settle,
    sent,
    setDrop: (fn: typeof drop) => (drop = fn),
    maxInFlight: () => maxInFlight,
    queue,
  };
}

const listed = (ids: number[], name = "Drums · HTDemucs") =>
  ids.map((n) => ({ id: idOf(n), name: `${name} ${n}` }));

describe("sharing audio files: one file, in pieces", () => {
  it("the host's file reaches a guest by its id, in pieces, and both have it", async () => {
    const net = network();
    const size = SOURCE_CHUNK_BYTES * 5 + 123;
    const bytes = bytesOf(size);
    net.host.io.files.set(idOf(1), bytes);
    net.host.sync.setNeeded(listed([1]), [idOf(1)]);
    net.guest().sync.setNeeded(listed([1]), []);
    // The guest has nothing yet: it waits for the file and the host is not complete.
    expect(net.guest().sync.state().waiting.has(idOf(1))).toBe(true);
    await net.settle();
    expect(net.guest().io.files.get(idOf(1))).toEqual(bytes);
    expect(net.guest().arrived).toEqual([idOf(1)]);
    expect(net.guest().sync.state().waiting.size).toBe(0);
    expect(net.guest().sync.complete).toBe(true);
    expect(net.host.sync.complete).toBe(true);
  });

  it("never has more than a window of pieces on the way", async () => {
    const net = network();
    net.host.io.files.set(idOf(1), bytesOf(SOURCE_CHUNK_BYTES * 60));
    net.host.sync.setNeeded(listed([1]), [idOf(1)]);
    net.guest().sync.setNeeded(listed([1]), []);
    await net.settle();
    expect(net.guest().io.files.has(idOf(1))).toBe(true);
    expect(net.maxInFlight()).toBeLessThanOrEqual(SOURCE_WINDOW);
  });

  it("a piece that goes missing is sent again and the file still arrives whole", async () => {
    const net = network();
    const bytes = bytesOf(SOURCE_CHUNK_BYTES * 30);
    net.host.io.files.set(idOf(1), bytes);
    let dropped = false;
    net.setDrop((msg) => {
      if (msg.type === "src-chunk" && msg.off === SOURCE_CHUNK_BYTES * 3 && !dropped) {
        dropped = true;
        return true;
      }
      return false;
    });
    net.host.sync.setNeeded(listed([1]), [idOf(1)]);
    net.guest().sync.setNeeded(listed([1]), []);
    await net.settle();
    expect(dropped).toBe(true);
    expect(net.guest().io.files.get(idOf(1))).toEqual(bytes);
  });

  it("goes on where it stopped when asked again", async () => {
    const net = network();
    const bytes = bytesOf(SOURCE_CHUNK_BYTES * 8);
    net.host.io.files.set(idOf(1), bytes);
    // A part of the file is staged already (the line dropped earlier).
    net.guest().io.staged.set(idOf(1), bytes.slice(0, SOURCE_CHUNK_BYTES * 5));
    net.host.sync.setNeeded(listed([1]), [idOf(1)]);
    net.guest().sync.setNeeded(listed([1]), []);
    await net.settle();
    expect(net.guest().io.files.get(idOf(1))).toEqual(bytes);
    // Only the rest was sent.
    const offsets = net.sent.flatMap((m) => (m.type === "src-chunk" ? [m.off] : []));
    expect(Math.min(...offsets)).toBe(SOURCE_CHUNK_BYTES * 5);
  });

  it("waits while the song plays and goes on afterwards", async () => {
    const net = network();
    net.host.io.files.set(idOf(1), bytesOf(SOURCE_CHUNK_BYTES * 4));
    net.host.sync.setNeeded(listed([1]), [idOf(1)]);
    net.host.paused = true;
    net.guest().sync.setNeeded(listed([1]), []);
    await net.settle(20);
    expect(net.sent.some((m) => m.type === "src-chunk")).toBe(false);
    net.host.paused = false;
    // The watchdog (or the next ack) restarts the sending; here the guest asks again.
    net.guest().sync.setNeeded(listed([1]), []);
    net.host.sync.receive("g1", { type: "src-ack", id: idOf(1), n: 0 });
    await net.settle();
    expect(net.guest().io.files.has(idOf(1))).toBe(true);
  });
});

describe("sharing audio files: who has what", () => {
  it("a file a guest adds goes to the host and from the host to the other guest", async () => {
    const net = network({ guests: ["g1", "g2"] });
    const bytes = bytesOf(SOURCE_CHUNK_BYTES * 3 + 5);
    net.guest("g1").io.files.set(idOf(2), bytes);
    const need = listed([2]);
    net.host.sync.setNeeded(need, []);
    net.guest("g1").sync.setNeeded(need, [idOf(2)]);
    net.guest("g2").sync.setNeeded(need, []);
    // Nobody can start: the host and g2 lack it.
    expect(net.host.sync.complete).toBe(false);
    await net.settle();
    expect(net.host.io.files.get(idOf(2))).toEqual(bytes);
    expect(net.guest("g2").io.files.get(idOf(2))).toEqual(bytes);
    expect(net.host.sync.complete).toBe(true);
    // g2 got it from the host, not from g1 (guests only talk to the host).
    expect(net.sent.every((m) => !("g2" in m))).toBe(true);
  });

  it("the host is not complete while one guest lacks a file, and says who", async () => {
    const net = network({ guests: ["g1", "g2"] });
    net.host.io.files.set(idOf(1), bytesOf(SOURCE_CHUNK_BYTES));
    net.host.sync.setNeeded(listed([1]), [idOf(1)]);
    net.guest("g1").sync.setNeeded(listed([1]), []);
    // g2 never asks (it has not seen the lane yet).
    await net.settle();
    expect(net.guest("g1").io.files.has(idOf(1))).toBe(true);
    expect(net.host.sync.complete).toBe(false);
    expect(net.host.sync.lacking()).toEqual([
      { peer: "g2", id: idOf(1), name: "Drums · HTDemucs 1" },
    ]);
    net.guest("g2").sync.setNeeded(listed([1]), []);
    await net.settle();
    expect(net.host.sync.complete).toBe(true);
    expect(net.host.sync.lacking()).toEqual([]);
  });

  it("a file nobody has is reported, not waited for for ever", async () => {
    const net = network();
    net.host.sync.setNeeded(listed([3]), []);
    net.guest().sync.setNeeded(listed([3]), []);
    // The guest waits for the host, which announced nothing.
    await net.settle();
    expect(net.guest().sync.state().waiting.has(idOf(3))).toBe(true);
    // The host says it does not have it (it asks for it by id).
    net.guest().sync.receive("host", { type: "src-have", ids: [idOf(3)] });
    await net.settle();
    expect(net.guest().sync.state().failed).toEqual([
      expect.objectContaining({ id: idOf(3), reason: "unavailable" }),
    ]);
    expect(net.guest().sync.state().waiting.size).toBe(0);
  });

  it("a player that leaves in the middle of a file is not waited for", async () => {
    const net = network({ guests: ["g1", "g2"] });
    net.guest("g1").io.files.set(idOf(4), bytesOf(SOURCE_CHUNK_BYTES * 10));
    net.host.sync.setNeeded(listed([4]), []);
    net.guest("g1").sync.setNeeded(listed([4]), [idOf(4)]);
    await net.settle(2);
    net.host.sync.peerLeft("g1");
    expect(net.host.sync.state().transfers).toEqual([]);
    // Nobody else has it: the host does not wait for it either.
    expect(net.host.sync.state().waiting.size).toBe(0);
  });

  it("ignores ids that are not content ids", () => {
    const net = network();
    net.host.sync.setNeeded(
      [
        { id: "legacy-1234", name: "x" },
        { id: "../x", name: "y" },
      ],
      [],
    );
    expect(net.host.sync.complete).toBe(true);
  });
});

describe("sharing audio files: limits and failures", () => {
  it("refuses a file over the session's quota", async () => {
    const net = network({ quota: SOURCE_CHUNK_BYTES * 2 });
    net.host.io.files.set(idOf(1), bytesOf(SOURCE_CHUNK_BYTES * 5));
    net.host.sync.setNeeded(listed([1]), [idOf(1)]);
    net.guest().sync.setNeeded(listed([1]), []);
    await net.settle();
    // The sender would not send past its quota: the guest is told so (the host has the file, so it
    // is not "nobody has it").
    expect(net.guest().io.files.has(idOf(1))).toBe(false);
    expect(net.guest().sync.state().failed).toEqual([
      expect.objectContaining({ id: idOf(1), reason: "quota" }),
    ]);
  });

  it("a file that arrives damaged is refused, not kept, and said so", async () => {
    const net = network();
    net.host.io.files.set(idOf(1), bytesOf(SOURCE_CHUNK_BYTES * 2));
    net.guest().io.badChecksum = true;
    net.host.sync.setNeeded(listed([1]), [idOf(1)]);
    net.guest().sync.setNeeded(listed([1]), []);
    await net.settle();
    expect(net.guest().io.files.has(idOf(1))).toBe(false);
    expect(net.guest().io.aborted).toContain(idOf(1));
    expect(net.guest().sync.state().failed[0]!.reason).toMatch(/damaged/);
  });

  it("ends cleanly: the staged parts are given up", async () => {
    const net = network();
    net.guest().sync.end();
    expect(net.guest().io.aborted).toContain(undefined);
  });

  it("a hostile piece (not base64, too long) fails the file instead of writing it", async () => {
    const net = network();
    net.host.io.files.set(idOf(1), bytesOf(SOURCE_CHUNK_BYTES * 2));
    net.host.sync.setNeeded(listed([1]), [idOf(1)]);
    net.guest().sync.setNeeded(listed([1]), []);
    await net.settle(3);
    net
      .guest()
      .sync.receive("host", { type: "src-chunk", id: idOf(1), off: 0, data: "%%%not base64" });
    await net.settle(3);
    expect(net.guest().io.files.has(idOf(1))).toBe(false);
  });

  it("answers a stranger's want for a file it does not have with 'nobody has it'", async () => {
    const net = network();
    net.host.sync.receive("g1", { type: "src-want", id: idOf(9) });
    await net.settle();
    expect(net.sent).toContainEqual({ type: "src-offer", id: idOf(9), size: 0 });
  });
});

describe("sharing audio files: quotas, failures and lost files", () => {
  it("every guest has a quota of its own: a file for two guests does not spend one quota twice", async () => {
    const size = SOURCE_CHUNK_BYTES * 5;
    // Room for the file once per guest, not twice in all.
    const net = network({ guests: ["g1", "g2"], quota: size + 100 });
    net.host.io.files.set(idOf(1), bytesOf(size));
    net.host.sync.setNeeded(listed([1]), [idOf(1)]);
    net.guest("g1").sync.setNeeded(listed([1]), []);
    net.guest("g2").sync.setNeeded(listed([1]), []);
    await net.settle();
    expect(net.guest("g1").io.files.has(idOf(1))).toBe(true);
    expect(net.guest("g2").io.files.has(idOf(1))).toBe(true);
    expect(net.host.sync.complete).toBe(true);
  });

  it("a file sent again to the same guest is not charged again", async () => {
    const size = SOURCE_CHUNK_BYTES * 5;
    const net = network({ quota: size + 100 });
    const bytes = bytesOf(size);
    net.host.io.files.set(idOf(1), bytes);
    net.host.sync.setNeeded(listed([1]), [idOf(1)]);
    net.guest().sync.setNeeded(listed([1]), []);
    await net.settle();
    expect(net.guest().io.files.get(idOf(1))).toEqual(bytes);
    // The guest lost its copy and asks again: what was sent before is not new bytes.
    net.guest().io.files.delete(idOf(1));
    net.host.sync.receive("g1", { type: "src-want", id: idOf(1) });
    await net.settle();
    expect(net.sent.filter((m) => m.type === "src-offer" && m.size === 0)).toEqual([]);
  });

  it("a quota refusal is said as such and the guest is not told 'nobody has it'", async () => {
    const net = network({ quota: SOURCE_CHUNK_BYTES });
    net.host.io.files.set(idOf(1), bytesOf(SOURCE_CHUNK_BYTES * 3));
    net.host.sync.setNeeded(listed([1]), [idOf(1)]);
    net.guest().sync.setNeeded(listed([1]), []);
    await net.settle();
    expect(net.sent).toContainEqual({ type: "src-offer", id: idOf(1), size: 0, refuse: "quota" });
    expect(
      net
        .guest()
        .sync.state()
        .failed.map((f) => f.reason),
    ).toEqual(["quota"]);
  });

  it("stops taking files in when the decoded audio of the session is over its budget", async () => {
    const net = network({ decodedQuota: 1_000 });
    for (const n of [1, 2, 3, 4]) net.host.io.files.set(idOf(n), bytesOf(SOURCE_CHUNK_BYTES));
    net.guest().io.decoded = 5_000; // each file decodes to more than the whole budget
    net.host.sync.setNeeded(listed([1, 2, 3, 4]), [1, 2, 3, 4].map(idOf));
    net.guest().sync.setNeeded(listed([1, 2, 3, 4]), []);
    await net.settle();
    // Only a few are taken in at a time, so a burst of announced files cannot all pass the
    // check before the first one is known to be big: the rest are refused for the budget.
    const have = [1, 2, 3, 4].filter((n) => net.guest().io.files.has(idOf(n)));
    expect(have.length).toBeLessThanOrEqual(MAX_PARALLEL_DOWNLOADS);
    expect(have.length).toBeGreaterThan(0);
    expect(
      net
        .guest()
        .sync.state()
        .failed.map((f) => f.reason),
    ).toEqual(["quota", "quota"].slice(0, 4 - have.length));
  });

  it("the host reports a file a guest could not take in, once, and not one it gave up on", async () => {
    const net = network({ guests: ["g1", "g2"] });
    net.host.io.files.set(idOf(1), bytesOf(SOURCE_CHUNK_BYTES * 2));
    net.guest("g1").io.badChecksum = true;
    net.host.sync.setNeeded(listed([1]), [idOf(1)]);
    net.guest("g1").sync.setNeeded(listed([1]), []);
    net.guest("g2").sync.setNeeded(listed([1]), []);
    await net.settle();
    expect(net.host.sync.complete).toBe(false);
    expect(net.host.sync.state().failed).toEqual([
      expect.objectContaining({ id: idOf(1), reason: "checksum" }),
    ]);
    // A guest that drops a file because no lane plays it any more has not failed.
    net.host.sync.receive("g2", { type: "src-done", id: idOf(1), ok: false, reason: "cancelled" });
    expect(net.host.sync.state().failed).toHaveLength(1);
    // When the guest has it later, the failure is over.
    net.host.sync.receive("g1", { type: "src-have", ids: [idOf(1)] });
    expect(net.host.sync.state().failed).toEqual([]);
  });

  it("a file nobody can provide is reported as lost after a moment, and is found again when a player has it", async () => {
    const clock = { t: 0 };
    const net = network({ clock });
    // The guest announced it, then left before the host had it.
    net.host.sync.setNeeded(listed([7]), []);
    net.host.sync.receive("g1", { type: "src-have", ids: [idOf(7)] });
    net.host.sync.peerLeft("g1");
    net.host.sync.peerJoined("g2");
    net.host.sync.watch();
    expect(net.host.sync.state().failed).toEqual([]);
    clock.t += MISSING_GRACE_MS + 1;
    net.host.sync.watch();
    expect(net.host.sync.state().failed).toEqual([
      expect.objectContaining({ id: idOf(7), reason: "unavailable" }),
    ]);
    expect(net.host.sync.state().waiting.size).toBe(0);
    net.host.sync.receive("g2", { type: "src-have", ids: [idOf(7)] });
    expect(net.host.sync.state().failed).toEqual([]);
  });

  it("a file that is only being opened on the host is not reported as lost", () => {
    const clock = { t: 0 };
    const net = network({ clock });
    net.host.sync.setNeeded(listed([8]), []);
    net.host.sync.watch();
    clock.t += MISSING_GRACE_MS - 10;
    net.host.sync.watch();
    // It opens (the lanes tell the transfer) before the moment is over.
    net.host.sync.setNeeded(listed([8]), [idOf(8)]);
    clock.t += 1_000;
    net.host.sync.watch();
    expect(net.host.sync.state().failed).toEqual([]);
  });
});

describe("sharing audio files: a failed transfer is not the end", () => {
  const SIZE = SOURCE_CHUNK_BYTES * 3;

  it("a disk error is tried again a moment later and the file arrives", async () => {
    const clock = { t: 0 };
    const net = network({ clock });
    net.host.io.files.set(idOf(1), bytesOf(SIZE));
    net.guest().io.failAppendOnce = true;
    net.host.sync.setNeeded(listed([1]), [idOf(1)]);
    net.guest().sync.setNeeded(listed([1]), []);
    await net.settle();
    // The first try failed: the file is waiting for its second, not failed for good.
    expect(net.guest().io.files.has(idOf(1))).toBe(false);
    expect(net.guest().sync.state().failed).toEqual([]);
    expect(net.guest().sync.state().waiting.has(idOf(1))).toBe(true);
    clock.t += RETRY_BACKOFF_MS + 1;
    net.guest().sync.watch();
    await net.settle();
    expect(net.guest().io.files.get(idOf(1))).toEqual(bytesOf(SIZE));
    expect(net.guest().sync.complete).toBe(true);
  });

  it("gives up after a few tries and then says so", async () => {
    const clock = { t: 0 };
    const net = network({ clock });
    net.host.io.files.set(idOf(1), bytesOf(SIZE));
    net.host.sync.setNeeded(listed([1]), [idOf(1)]);
    net.guest().sync.setNeeded(listed([1]), []);
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      net.guest().io.failAppendOnce = true;
      await net.settle();
      clock.t += RETRY_BACKOFF_MS * (attempt + 1) + 1;
      net.guest().sync.watch();
    }
    await net.settle();
    expect(net.guest().io.files.has(idOf(1))).toBe(false);
    expect(net.guest().sync.state().failed).toEqual([
      expect.objectContaining({ id: idOf(1), reason: expect.stringMatching(/space/) }),
    ]);
  });

  it("a file that arrived damaged is asked for from another player that has it", async () => {
    const net = network({ guests: ["g1", "g2"] });
    const bytes = bytesOf(SIZE);
    net.guest("g1").io.files.set(idOf(2), bytes);
    net.guest("g2").io.files.set(idOf(2), bytes);
    net.host.io.badChecksumOnce = true;
    net.host.sync.setNeeded(listed([2]), []);
    net.guest("g1").sync.setNeeded(listed([2]), [idOf(2)]);
    net.guest("g2").sync.setNeeded(listed([2]), [idOf(2)]);
    await net.settle();
    expect(net.host.io.files.get(idOf(2))).toEqual(bytes);
    expect(net.host.sync.state().failed).toEqual([]);
    // It was asked of both players, one after the other (the first one sent it damaged).
    const asked = net.sent.filter((m) => m.type === "src-want").length;
    expect(asked).toBeGreaterThanOrEqual(2);
  });

  it("a player that sent a file damaged is not asked again, and its leaving clears the failure", async () => {
    const net = network({ guests: ["g1", "g2"] });
    net.guest("g1").io.files.set(idOf(3), bytesOf(SIZE));
    net.host.io.badChecksum = true;
    net.host.sync.setNeeded(listed([3]), []);
    net.guest("g1").sync.setNeeded(listed([3]), [idOf(3)]);
    await net.settle();
    expect(net.host.sync.state().failed).toHaveLength(1);
    // The same player announces it again: it is not trusted with it a second time.
    net.host.sync.receive("g1", { type: "src-have", ids: [idOf(3)] });
    expect(net.host.sync.state().failed).toHaveLength(1);
    // It leaves: what failed because of it is over, and another player may now provide the file.
    net.host.sync.peerLeft("g1");
    expect(net.host.sync.state().failed).toEqual([]);
    net.host.io.badChecksum = false;
    net.guest("g2").io.files.set(idOf(3), bytesOf(SIZE));
    net.guest("g2").sync.setNeeded(listed([3]), [idOf(3)]);
    await net.settle();
    expect(net.host.io.files.has(idOf(3))).toBe(true);
  });

  it("a player that has the file turns up after it failed: it is tried again", async () => {
    const net = network({ guests: ["g1", "g2"] });
    net.guest("g1").io.files.set(idOf(4), bytesOf(SIZE));
    net.host.io.badChecksumOnce = true;
    net.host.sync.setNeeded(listed([4]), []);
    net.guest("g1").sync.setNeeded(listed([4]), [idOf(4)]);
    await net.settle();
    expect(net.host.sync.state().failed).toHaveLength(1);
    net.guest("g2").io.files.set(idOf(4), bytesOf(SIZE));
    net.guest("g2").sync.setNeeded(listed([4]), [idOf(4)]);
    await net.settle();
    expect(net.host.io.files.has(idOf(4))).toBe(true);
    expect(net.host.sync.state().failed).toEqual([]);
  });

  it("the host can try a failed file again from any player", async () => {
    const net = network();
    net.guest().io.files.set(idOf(5), bytesOf(SIZE));
    net.host.io.badChecksum = true;
    net.host.sync.setNeeded(listed([5]), []);
    net.guest().sync.setNeeded(listed([5]), [idOf(5)]);
    await net.settle();
    expect(net.host.sync.state().failed).toHaveLength(1);
    net.host.io.badChecksum = false;
    net.host.sync.retry(idOf(5));
    await net.settle();
    expect(net.host.io.files.has(idOf(5))).toBe(true);
    expect(net.host.sync.state().failed).toEqual([]);
  });

  it("a file that is still being checked and loaded is not started over by the watchdog", async () => {
    const clock = { t: 0 };
    const net = network({ clock });
    net.host.io.files.set(idOf(6), bytesOf(SIZE));
    let release: () => void = () => {};
    net.guest().io.holdFinish = new Promise<void>((resolve) => (release = resolve));
    net.host.sync.setNeeded(listed([6]), [idOf(6)]);
    net.guest().sync.setNeeded(listed([6]), []);
    await net.settle();
    expect(net.guest().io.finishes).toBe(1);
    const wantsBefore = net.sent.filter((m) => m.type === "src-want").length;
    // The check takes far longer than the watchdog's patience.
    clock.t += 60_000;
    net.guest().sync.watch();
    net.guest().sync.watch();
    await net.settle();
    expect(net.sent.filter((m) => m.type === "src-want").length).toBe(wantsBefore);
    release();
    await net.settle();
    expect(net.guest().io.files.get(idOf(6))).toEqual(bytesOf(SIZE));
    // The file arrived once, and was checked once.
    expect(net.guest().arrived).toEqual([idOf(6)]);
    expect(net.guest().io.finishes).toBe(1);
    expect(net.guest().sync.state().failed).toEqual([]);
  });
});

describe("sharing audio files: what other players may ask for", () => {
  it("sets the size of a file aside when it is accepted, so files announced together share the quota", async () => {
    const SIZE = SOURCE_CHUNK_BYTES * 4;
    // Room for one and a half files: the second one cannot fit while the first is on its way.
    const net = network({ quota: SIZE * 1.5 });
    for (const n of [1, 2]) net.host.io.files.set(idOf(n), bytesOf(SIZE, n));
    net.host.sync.setNeeded(listed([1, 2]), [idOf(1), idOf(2)]);
    net.guest().sync.setNeeded(listed([1, 2]), []);
    await net.settle();
    const files = [1, 2].filter((n) => net.guest().io.files.has(idOf(n)));
    expect(files).toHaveLength(1);
    expect(net.guest().sync.state().failed).toEqual([expect.objectContaining({ reason: "quota" })]);
  });

  it("serves only files the lanes play", async () => {
    const net = network();
    net.host.io.files.set(idOf(9), bytesOf(SOURCE_CHUNK_BYTES));
    // The host has it (it opened it earlier) but no lane plays it any more.
    net.host.sync.setNeeded([], [idOf(9)]);
    net.host.sync.receive("g1", { type: "src-want", id: idOf(9) });
    await net.settle();
    expect(net.sent).toContainEqual({ type: "src-offer", id: idOf(9), size: 0 });
    expect(net.sent.some((m) => m.type === "src-chunk")).toBe(false);
  });

  it("does not serve more files to one player at once than an honest player asks for", async () => {
    const net = network();
    const ids = Array.from({ length: 12 }, (_, i) => i + 20);
    for (const n of ids) net.host.io.files.set(idOf(n), bytesOf(SOURCE_CHUNK_BYTES * 2));
    net.host.sync.setNeeded(listed(ids), ids.map(idOf));
    for (const n of ids) net.host.sync.receive("g1", { type: "src-want", id: idOf(n) });
    await net.settle(5);
    const offered = net.sent.filter((m) => m.type === "src-offer" && m.size > 0);
    expect(offered.length).toBe(MAX_PARALLEL_UPLOADS);
  });

  it("keeps track of no more files for one player than a session holds", () => {
    const net = network();
    net.host.sync.setNeeded(listed([1]), []);
    // More announced ids than a session can use: the surplus is ignored.
    for (let start = 0; start < MAX_SOURCE_FILES + 300; start += 100) {
      net.host.sync.receive("g1", {
        type: "src-have",
        ids: Array.from({ length: 100 }, (_, i) => idOf(100 + start + i)),
      });
    }
    // The one the lanes need is still found when it is announced after the flood: not tracked, so
    // nothing is asked (the host would have no room for it, which is the point of the cap).
    net.host.sync.receive("g1", { type: "src-have", ids: [idOf(1)] });
    expect(net.sent.filter((m) => m.type === "src-want")).toEqual([]);
  });

  it("two last pieces of one file, or a restart in the middle of a piece, never write a piece twice", async () => {
    const clock = { t: 0 };
    const net = network({ clock });
    const bytes = bytesOf(SOURCE_CHUNK_BYTES * 6);
    net.host.io.files.set(idOf(5), bytes);
    net.host.sync.setNeeded(listed([5]), [idOf(5)]);
    net.guest().sync.setNeeded(listed([5]), []);
    await net.settle(3);
    // The watchdog starts the transfer over while pieces are still queued.
    clock.t += 10_000;
    net.guest().sync.watch();
    await net.settle();
    expect(net.guest().io.files.get(idOf(5))).toEqual(bytes);
  });
});
