import { hostOnLan, joinOnLan } from "@/lib/practice-together/lan";
import type { GuestLink, LinkState } from "@/lib/practice-together/transport";
import {
  onPracticeFrame,
  onPracticeState,
  practiceHost,
  practiceJoin,
  practiceKick,
  practiceLeave,
  practiceSend,
  type PracticeLinkState,
} from "@/lib/tauri";

vi.mock(import("@/lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  onPracticeFrame: vi.fn(),
  onPracticeState: vi.fn(),
  practiceHost: vi.fn(),
  practiceJoin: vi.fn(),
  practiceKick: vi.fn(),
  practiceSend: vi.fn(),
  practiceLeave: vi.fn(),
}));

let frame: (text: string, conn?: number) => void;
let state: (state: PracticeLinkState, detail?: string, conn?: number) => void;
const CODE = "ABCD-EFGH-JKMN-PQRS-TVWX";
const stopFrame = vi.fn();
const stopState = vi.fn();

beforeEach(() => {
  stopFrame.mockClear();
  stopState.mockClear();
  vi.mocked(onPracticeFrame).mockImplementation(async (handler) => {
    frame = (text, conn = 1) => handler(text, conn);
    return stopFrame;
  });
  vi.mocked(onPracticeState).mockImplementation(async (handler) => {
    state = (next, detail, conn = 1) => handler(next, detail, conn);
    return stopState;
  });
  vi.mocked(practiceHost).mockResolvedValue({
    code: "ABCD-EFGH-JKMN-PQRS-TVWX",
    link: "smartbeat://join/ABCD-EFGH-JKMN-PQRS-TVWX",
    address: "192.168.1.5:50000",
  });
  vi.mocked(practiceJoin).mockResolvedValue(undefined);
  vi.mocked(practiceSend).mockResolvedValue(true);
  vi.mocked(practiceLeave).mockResolvedValue(undefined);
  vi.mocked(practiceKick).mockResolvedValue(undefined);
  vi.mocked(practiceSend).mockClear();
  vi.mocked(practiceKick).mockClear();
  vi.mocked(practiceLeave).mockClear();
});

describe("hostOnLan", () => {
  it("returns the room code and starts listening before the host opens", async () => {
    const order: string[] = [];
    vi.mocked(onPracticeFrame).mockImplementationOnce(async () => {
      order.push("listen");
      return stopFrame;
    });
    vi.mocked(practiceHost).mockImplementationOnce(async () => {
      order.push("host");
      return { code: "C", link: "l", address: "a" };
    });
    const { info } = await hostOnLan();
    expect(info.code).toBe("C");
    expect(order).toEqual(["listen", "host"]);
  });

  it("hands out a link for every guest that connects, with where it came from", async () => {
    const { acceptor } = await hostOnLan();
    const links: GuestLink[] = [];
    const infos: unknown[] = [];
    acceptor.onGuest((link, info) => {
      links.push(link);
      infos.push(info);
    });
    state("open", "192.168.1.20", 4);
    state("open", undefined, 7);
    expect(links).toHaveLength(2);
    expect(infos).toEqual([{ address: "192.168.1.20" }, {}]);
    expect(links.map((l) => l.state)).toEqual(["open", "open"]);
  });

  it("holds guests that came before anyone listened", async () => {
    const { acceptor } = await hostOnLan();
    state("open", "10.0.0.8", 2);
    const links: GuestLink[] = [];
    acceptor.onGuest((link) => links.push(link));
    expect(links).toHaveLength(1);
  });

  it("delivers each frame to the guest it came on, and sends to that guest only", async () => {
    const { acceptor } = await hostOnLan();
    const links: GuestLink[] = [];
    acceptor.onGuest((link) => links.push(link));
    state("open", undefined, 4);
    state("open", undefined, 7);
    const heard: string[][] = [[], []];
    links.forEach((link, i) => link.onFrame((t) => heard[i]!.push(t)));
    frame("to four", 4);
    frame("to seven", 7);
    frame("nobody", 99);
    expect(heard).toEqual([["to four"], ["to seven"]]);
    links[1]!.send("hello");
    expect(practiceSend).toHaveBeenCalledWith("hello", 7);
  });

  it("tells a guest's link when its connection ends, and sends nothing after", async () => {
    const { acceptor } = await hostOnLan();
    const links: GuestLink[] = [];
    acceptor.onGuest((link) => links.push(link));
    state("open", undefined, 4);
    const states: [LinkState, string | undefined][] = [];
    links[0]!.onState((s, d) => states.push([s, d]));
    state("closed", "the guest disconnected", 4);
    expect(states).toEqual([["closed", "the guest disconnected"]]);
    expect(links[0]!.state).toBe("closed");
    links[0]!.send("late");
    expect(practiceSend).not.toHaveBeenCalled();
  });

  it("removes one guest in Rust, and asks for the address to be turned away on a ban", async () => {
    const { acceptor } = await hostOnLan();
    const links: GuestLink[] = [];
    acceptor.onGuest((link) => links.push(link));
    state("open", undefined, 4);
    state("open", undefined, 7);
    acceptor.remove(links[0]!);
    expect(practiceKick).toHaveBeenCalledWith(4, false);
    acceptor.remove(links[1]!, { guest: "abc" });
    expect(practiceKick).toHaveBeenCalledWith(7, true);
    expect(links.map((l) => l.state)).toEqual(["closed", "closed"]);
    // The other connections are untouched, and the socket stays open.
    expect(practiceLeave).not.toHaveBeenCalled();
  });

  it("ends one guest by closing its link", async () => {
    const { acceptor } = await hostOnLan();
    const links: GuestLink[] = [];
    acceptor.onGuest((link) => links.push(link));
    state("open", undefined, 4);
    links[0]!.close();
    links[0]!.close();
    expect(practiceKick).toHaveBeenCalledTimes(1);
  });

  it("ends the session in Rust and stops listening on close, once", async () => {
    const { acceptor } = await hostOnLan();
    const links: GuestLink[] = [];
    acceptor.onGuest((link) => links.push(link));
    state("open", undefined, 4);
    acceptor.close();
    acceptor.close();
    expect(practiceLeave).toHaveBeenCalledTimes(1);
    expect(stopFrame).toHaveBeenCalledTimes(1);
    expect(stopState).toHaveBeenCalledTimes(1);
    expect(links[0]!.state).toBe("closed");
  });

  it("ends every guest and says it is no longer listening when Rust closes the link", async () => {
    const { acceptor } = await hostOnLan();
    const links: GuestLink[] = [];
    acceptor.onGuest((link) => links.push(link));
    const heard: [boolean, string | undefined][] = [];
    acceptor.onListening((on, detail) => heard.push([on, detail]));
    state("open", undefined, 4);
    state("open", undefined, 7);
    state("closed", "too many wrong codes", 0);
    expect(links.map((l) => l.state)).toEqual(["closed", "closed"]);
    expect(heard).toEqual([[false, "too many wrong codes"]]);
    expect(stopFrame).toHaveBeenCalled();
  });

  it("closes and rethrows when the host cannot listen", async () => {
    vi.mocked(practiceHost).mockRejectedValueOnce({ kind: "network", message: "no" });
    await expect(hostOnLan()).rejects.toMatchObject({ kind: "network" });
    expect(practiceLeave).toHaveBeenCalled();
    expect(stopFrame).toHaveBeenCalled();
  });

  it("does not fail when a send, kick or leave fails", async () => {
    vi.mocked(practiceSend).mockRejectedValue(new Error("gone"));
    vi.mocked(practiceKick).mockRejectedValue(new Error("gone"));
    vi.mocked(practiceLeave).mockRejectedValue(new Error("gone"));
    const { acceptor } = await hostOnLan();
    const links: GuestLink[] = [];
    acceptor.onGuest((link) => links.push(link));
    state("open", undefined, 4);
    links[0]!.send("x");
    links[0]!.close();
    acceptor.close();
    await Promise.resolve();
    expect(practiceSend).toHaveBeenCalled();
  });
});

describe("a guest's link", () => {
  it("relays frames and link states to the session", async () => {
    const transport = await joinOnLan(CODE);
    const frames: string[] = [];
    const states: [LinkState, string | undefined][] = [];
    const offFrame = transport.onFrame((t) => frames.push(t));
    transport.onState((s, d) => states.push([s, d]));
    frame("one");
    state("open");
    state("reconnecting", "the connection dropped", 0);
    expect(frames).toEqual(["one"]);
    expect(states).toEqual([
      ["open", undefined],
      ["reconnecting", "the connection dropped"],
    ]);
    offFrame();
    frame("two");
    expect(frames).toEqual(["one"]);
  });

  it("sends frames through Rust, and not after it is closed", async () => {
    const transport = await joinOnLan(CODE);
    transport.send("hello");
    expect(practiceSend).toHaveBeenCalledWith("hello");
    transport.close();
    transport.send("late");
    expect(practiceSend).toHaveBeenCalledTimes(1);
  });

  it("leaves in Rust and stops listening on close, once", async () => {
    const transport = await joinOnLan(CODE);
    transport.close();
    transport.close();
    expect(practiceLeave).toHaveBeenCalledTimes(1);
    expect(stopFrame).toHaveBeenCalledTimes(1);
    expect(stopState).toHaveBeenCalledTimes(1);
  });

  it("stops listening when Rust reports the link closed", async () => {
    const transport = await joinOnLan(CODE);
    const states: LinkState[] = [];
    transport.onState((s) => states.push(s));
    state("closed", "the host did not come back", 0);
    expect(states).toEqual(["closed"]);
    expect(stopFrame).toHaveBeenCalled();
  });
});

describe("joinOnLan", () => {
  it("joins with the typed code", async () => {
    const transport = await joinOnLan("abcd-efgh");
    expect(practiceJoin).toHaveBeenCalledWith("abcd-efgh");
    const frames: string[] = [];
    transport.onFrame((t) => frames.push(t));
    frame("from host");
    expect(frames).toEqual(["from host"]);
  });

  it("closes the transport and rethrows when the code is refused", async () => {
    vi.mocked(practiceJoin).mockRejectedValueOnce({ kind: "invalid-code", message: "bad" });
    await expect(joinOnLan("nope")).rejects.toMatchObject({ kind: "invalid-code" });
    expect(practiceLeave).toHaveBeenCalled();
    expect(stopFrame).toHaveBeenCalled();
    expect(stopState).toHaveBeenCalled();
  });
});
