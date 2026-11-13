import {
  decode,
  encode,
  SOURCE_CHUNK_BYTES,
  SOURCE_WINDOW,
} from "@/lib/practice-together/protocol";
import type { SourceMessage } from "@/lib/practice-together/protocol";
import { SourceSync, type SourceIo } from "@/lib/practice-together/source-transfer";

/** A file with a made-up content id (the real id is a SHA-256; here only its shape matters). */
const idOf = (n: number) => n.toString(16).padStart(64, "0");

/** One player's audio engine: files loaded, files being received. */
class FakeIo implements SourceIo {
  files = new Map<string, Uint8Array>();
  staged = new Map<string, Uint8Array>();
  badChecksum = false;
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
    const have = this.staged.get(id) ?? new Uint8Array();
    if (have.length !== offset) throw new Error("offset");
    const next = new Uint8Array(have.length + bytes.length);
    next.set(have);
    next.set(bytes, have.length);
    this.staged.set(id, next);
    return next.length;
  }
  async stageFinish(id: string) {
    const bytes = this.staged.get(id)!;
    this.staged.delete(id);
    if (this.badChecksum) throw new Error("It arrived damaged");
    this.files.set(id, bytes);
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
function network(options: { quota?: number; guests?: string[] } = {}) {
  const queue: { to: string; from: string; text: string }[] = [];
  const sent: SourceMessage[] = [];
  /** Messages this test drops on the way. */
  let drop: ((msg: SourceMessage, from: string, to: string) => boolean) | null = null;
  const players = new Map<string, Player>();
  let maxInFlight = 0;
  const inFlight = new Map<string, number>();

  function add(id: string, role: "host" | "guest", quota?: number) {
    const io = new FakeIo();
    const player = { io, arrived: [] as string[], paused: false } as Player;
    player.sync = new SourceSync({
      io,
      role,
      quota,
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
  const host = add("host", "host", options.quota);
  const guests = (options.guests ?? ["g1"]).map((id) => add(id, "guest", options.quota));
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
    // The sender would not send past its quota: the guest is told nobody has it.
    expect(net.guest().io.files.has(idOf(1))).toBe(false);
    expect(net.guest().sync.state().failed).toHaveLength(1);
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
