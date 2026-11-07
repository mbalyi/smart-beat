import { hostOnLan, joinOnLan } from "@/lib/practice-together/lan";
import type { LinkState } from "@/lib/practice-together/transport";
import {
  onPracticeFrame,
  onPracticeState,
  practiceHost,
  practiceJoin,
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
  practiceSend: vi.fn(),
  practiceLeave: vi.fn(),
}));

let frame: (text: string) => void;
let state: (state: PracticeLinkState, detail?: string) => void;
const stopFrame = vi.fn();
const stopState = vi.fn();

beforeEach(() => {
  stopFrame.mockClear();
  stopState.mockClear();
  vi.mocked(onPracticeFrame).mockImplementation(async (handler) => {
    frame = handler;
    return stopFrame;
  });
  vi.mocked(onPracticeState).mockImplementation(async (handler) => {
    state = handler;
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

  it("relays frames and link states to the session", async () => {
    const { transport } = await hostOnLan();
    const frames: string[] = [];
    const states: [LinkState, string | undefined][] = [];
    const offFrame = transport.onFrame((t) => frames.push(t));
    transport.onState((s, d) => states.push([s, d]));
    frame("one");
    state("open");
    state("reconnecting", "the guest disconnected");
    expect(frames).toEqual(["one"]);
    expect(states).toEqual([
      ["open", undefined],
      ["reconnecting", "the guest disconnected"],
    ]);
    offFrame();
    frame("two");
    expect(frames).toEqual(["one"]);
  });

  it("sends frames through Rust, and not after it is closed", async () => {
    const { transport } = await hostOnLan();
    transport.send("hello");
    expect(practiceSend).toHaveBeenCalledWith("hello");
    transport.close();
    transport.send("late");
    expect(practiceSend).toHaveBeenCalledTimes(1);
  });

  it("ends the session in Rust and stops listening on close, once", async () => {
    const { transport } = await hostOnLan();
    transport.close();
    transport.close();
    expect(practiceLeave).toHaveBeenCalledTimes(1);
    expect(stopFrame).toHaveBeenCalledTimes(1);
    expect(stopState).toHaveBeenCalledTimes(1);
  });

  it("stops listening when Rust reports the link closed", async () => {
    const { transport } = await hostOnLan();
    const states: LinkState[] = [];
    transport.onState((s) => states.push(s));
    state("closed", "too many wrong codes");
    expect(states).toEqual(["closed"]);
    expect(stopFrame).toHaveBeenCalled();
  });

  it("closes and rethrows when the host cannot listen", async () => {
    vi.mocked(practiceHost).mockRejectedValueOnce({ kind: "network", message: "no" });
    await expect(hostOnLan()).rejects.toMatchObject({ kind: "network" });
    expect(practiceLeave).toHaveBeenCalled();
    expect(stopFrame).toHaveBeenCalled();
  });

  it("does not fail when a send or leave fails", async () => {
    vi.mocked(practiceSend).mockRejectedValue(new Error("gone"));
    vi.mocked(practiceLeave).mockRejectedValue(new Error("gone"));
    const { transport } = await hostOnLan();
    transport.send("x");
    transport.close();
    await Promise.resolve();
    expect(practiceSend).toHaveBeenCalled();
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
