import { act, renderHook, waitFor } from "@testing-library/react";

import { usePracticeTogether, type TogetherPlayer } from "@/hooks/use-practice-together";
import { playerRemoved, rejoined } from "@/lib/practice-together/analytics";
import { hostOnLan, joinOnLan } from "@/lib/practice-together/lan";
import { LAST_SESSION_TTL_MS, guestId, readLastSession } from "@/lib/practice-together/identity";
import { storeQualityChoice } from "@/lib/practice-together/quality-presets";
import { hostOverInternet, joinOverInternet, rtcSupported } from "@/lib/practice-together/rtc";
import { Session } from "@/lib/practice-together/session";
import {
  memoryAcceptor,
  memoryPair,
  openPair,
  type GuestLink,
} from "@/lib/practice-together/transport";
import type { Score } from "@/lib/score/model";
import { initialPractice } from "@/lib/score/practice";
import { isTauri, practiceSignalAvailable } from "@/lib/tauri";

vi.mock(import("@/lib/practice-together/lan"), () => ({
  hostOnLan: vi.fn(),
  joinOnLan: vi.fn(),
}));
vi.mock(import("@/lib/practice-together/rtc"), () => ({
  hostOverInternet: vi.fn(),
  joinOverInternet: vi.fn(),
  rtcSupported: vi.fn(() => true),
}));
vi.mock(import("@/lib/practice-together/fingerprint"), () => ({
  scoreFingerprint: vi.fn(async () => ({ key: "score-a", bars: 8 })),
}));
vi.mock(import("@/lib/practice-together/analytics"), async (importOriginal) => ({
  ...(await importOriginal()),
  playerRemoved: vi.fn(),
  rejoined: vi.fn(),
}));
vi.mock(import("@/lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  isTauri: vi.fn(() => true),
  practiceSignalAvailable: vi.fn(async () => true),
}));

const CODE = "ABCD-EFGH-JKMN-PQRS-TVWX";

function fakePlayer(): TogetherPlayer {
  return {
    isPlaying: vi.fn(() => false),
    playPause: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(() => false),
    seekToTick: vi.fn(),
    heardTimeMs: vi.fn((): number | null => null),
    outputLatencyMs: vi.fn(() => 0),
    isReady: vi.fn(() => true),
    warmUpAudio: vi.fn(async () => {}),
    getTick: vi.fn(() => 960),
    barStartTick: vi.fn((index: number) => index * 3840),
  };
}

function setup() {
  const player = fakePlayer();
  return renderHook(() =>
    usePracticeTogether({
      playerRef: { current: player },
      practice: initialPractice(),
      dispatchPractice: vi.fn(),
      score: {} as Score,
      revision: 0,
    }),
  );
}

/** A guest app that connects to the hosting hook. */
function guestOf(room: ReturnType<typeof memoryAcceptor>, name: string, id: string) {
  const pair = memoryPair({ up: 1, down: 1 });
  const session = new Session({
    role: "guest",
    transport: pair[1],
    name,
    score: { key: "score-a", bars: 8 },
    guest: id,
    quality: "tight",
    hooks: { prepare: async () => true, schedule: () => () => {} },
  });
  session.start();
  openPair(pair);
  room.arrive(pair[0] as GuestLink, { address: "10.0.0.9" });
  return { session, pair };
}

beforeEach(() => {
  localStorage.clear();
  storeQualityChoice("tight");
  vi.mocked(hostOnLan).mockReset();
  vi.mocked(joinOnLan).mockReset();
  vi.mocked(hostOverInternet).mockReset();
  vi.mocked(joinOverInternet).mockReset();
  vi.mocked(rtcSupported).mockReturnValue(true);
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(practiceSignalAvailable).mockResolvedValue(true);
  vi.mocked(playerRemoved).mockClear();
  vi.mocked(rejoined).mockClear();
});

async function hostWith(names: string[]) {
  const room = memoryAcceptor();
  vi.mocked(hostOnLan).mockResolvedValue({
    acceptor: room.acceptor,
    info: { code: CODE, link: "l", address: "a" },
  });
  const context = setup();
  await act(async () => {
    await context.result.current.host("lan");
  });
  const guests = names.map((name) => guestOf(room, name, `${name.toLowerCase()}000000000000`));
  return { ...context, room, guests };
}

describe("usePracticeTogether: a host with several guests", () => {
  it("asks about the guests one at a time, and says how many wait", async () => {
    const { result, guests } = await hostWith(["Ann", "Bob", "Cy"]);
    await waitFor(() => expect(result.current.approval?.name).toBe("Ann"));
    expect(result.current.approvalsWaiting).toBe(2);
    expect(result.current.state?.phase).toBe("approving");
    act(() => result.current.approval!.answer(true));
    await waitFor(() => expect(result.current.approval?.name).toBe("Bob"));
    expect(result.current.approvalsWaiting).toBe(1);
    act(() => result.current.approval!.answer(false));
    await waitFor(() => expect(result.current.approval?.name).toBe("Cy"));
    act(() => result.current.approval!.answer(true));
    await waitFor(() => expect(result.current.approval).toBeNull());
    await waitFor(
      () => expect(result.current.state?.peers?.map((p) => p.name)).toEqual(["Ann", "Cy"]),
      {
        timeout: 4000,
      },
    );
    expect(guests[1]!.session.snapshot.problem?.kind).toBe("declined");
    await waitFor(() => expect(result.current.state?.phase).toBe("synchronized"), {
      timeout: 4000,
    });
  });

  it("takes a question back when the guest goes away before the answer", async () => {
    const { result, guests } = await hostWith(["Ann", "Bob"]);
    await waitFor(() => expect(result.current.approval?.name).toBe("Ann"));
    guests[0]!.pair[1].close();
    await waitFor(() => expect(result.current.approval?.name).toBe("Bob"));
    expect(result.current.approvalsWaiting).toBe(0);
  });

  it("kicks and bans from the host, counting each, and does nothing for a guest", async () => {
    const { result, guests } = await hostWith(["Ann", "Bob"]);
    for (let i = 0; i < 2; i += 1) {
      await waitFor(() => expect(result.current.approval).not.toBeNull());
      act(() => result.current.approval!.answer(true));
    }
    await waitFor(() => expect(result.current.state?.phase).toBe("synchronized"), {
      timeout: 4000,
    });
    const [ann, bob] = result.current.state!.peers!;
    act(() => result.current.kick(ann!.id));
    await waitFor(() => expect(guests[0]!.session.snapshot.problem?.kind).toBe("kicked"));
    expect(playerRemoved).toHaveBeenCalledWith("kick");
    act(() => result.current.ban(bob!.id));
    await waitFor(() => expect(guests[1]!.session.snapshot.problem?.kind).toBe("banned"));
    expect(playerRemoved).toHaveBeenCalledWith("ban");
    await waitFor(() => expect(result.current.state?.peers).toEqual([]));
  });

  it("leaves nothing to kick when it is only a guest", async () => {
    const pair = memoryPair();
    vi.mocked(joinOnLan).mockResolvedValue(pair[1]);
    const { result } = setup();
    await act(async () => {
      await result.current.join("lan", CODE);
    });
    act(() => result.current.kick("anyone"));
    act(() => result.current.ban("anyone"));
    expect(playerRemoved).not.toHaveBeenCalled();
  });
});

describe("usePracticeTogether: coming back", () => {
  it("remembers the session it joined, with its kind and code and no one else's details", async () => {
    const pair = memoryPair();
    vi.mocked(joinOnLan).mockResolvedValue(pair[1]);
    const { result } = setup();
    expect(result.current.lastSession).toBeNull();
    await act(async () => {
      await result.current.join("lan", CODE);
    });
    expect(result.current.lastSession).toMatchObject({ kind: "lan", code: CODE });
    expect(readLastSession()).toMatchObject({ kind: "lan", code: CODE });
    expect(Object.keys(readLastSession()!).sort()).toEqual(["at", "code", "kind"]);
  });

  it("rejoins the same session with the same code, counting it as a rejoin", async () => {
    const pair = memoryPair();
    vi.mocked(joinOnLan).mockResolvedValue(pair[1]);
    const { result } = setup();
    await act(async () => {
      await result.current.join("lan", CODE);
    });
    act(() => result.current.leave());
    // Leaving on purpose forgets it: a drop is what rejoin is for.
    expect(result.current.lastSession).toBeNull();
    await act(async () => {
      await result.current.rejoin();
    });
    expect(joinOnLan).toHaveBeenCalledTimes(1);

    const second = memoryPair();
    vi.mocked(joinOnLan).mockResolvedValue(second[1]);
    await act(async () => {
      await result.current.join("lan", CODE);
    });
    // The connection dropped for good: the session is over, but it is still remembered.
    act(() => second[1].close());
    const again = memoryPair();
    vi.mocked(joinOnLan).mockResolvedValue(again[1]);
    await act(async () => {
      await result.current.rejoin();
    });
    expect(joinOnLan).toHaveBeenLastCalledWith(CODE);
    expect(rejoined).toHaveBeenCalledWith("lan");
    expect(result.current.state?.role).toBe("guest");
  });

  it("rejoins over the internet with its own id", async () => {
    vi.mocked(joinOverInternet).mockResolvedValue(memoryPair()[1]);
    const { result } = setup();
    await act(async () => {
      await result.current.join("internet", "ABCD-EFGH");
    });
    await act(async () => {
      await result.current.rejoin();
    });
    expect(joinOverInternet).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(joinOverInternet).mock.calls) {
      expect(call[0]).toBe("ABCD-EFGH");
      expect(call[2]).toBe(guestId());
    }
    expect(rejoined).toHaveBeenCalledWith("internet");
  });

  it("does nothing to rejoin when there is nothing remembered, or it is too old", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.rejoin();
    });
    expect(joinOnLan).not.toHaveBeenCalled();
    localStorage.setItem(
      "smart-beat:practice-together:last",
      JSON.stringify({ kind: "lan", code: CODE, at: Date.now() - LAST_SESSION_TTL_MS - 1000 }),
    );
    await act(async () => {
      await result.current.rejoin();
    });
    expect(joinOnLan).not.toHaveBeenCalled();
  });

  it("keeps a session when the guest was kicked, and forgets a ban or a session the host ended", async () => {
    const check = async (kind: "kicked" | "banned" | "peer-left") => {
      localStorage.clear();
      const pair = memoryPair({ up: 1, down: 1 });
      vi.mocked(joinOnLan).mockResolvedValue(pair[1]);
      const { result, unmount } = setup();
      await act(async () => {
        await result.current.join("lan", CODE);
      });
      expect(readLastSession()).not.toBeNull();
      // The far end says goodbye with a reason.
      openPair(pair);
      pair[0].send(JSON.stringify({ v: 1, n: 1, msg: { type: "bye", reason: kind } }));
      await waitFor(() =>
        expect(["closed", "failed"]).toContain(result.current.state?.phase ?? "none"),
      );
      const kept = readLastSession() !== null;
      unmount();
      return kept;
    };
    expect(await check("kicked")).toBe(true);
    expect(await check("banned")).toBe(false);
    expect(await check("peer-left")).toBe(false);
  });
});

describe("the guest's own id", () => {
  it("is the same every time, and a new one is made only when the storage is gone", () => {
    const first = guestId();
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(guestId()).toBe(first);
  });
});
