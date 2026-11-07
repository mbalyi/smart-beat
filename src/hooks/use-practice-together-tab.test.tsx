import { act, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";

import { usePracticeTogether, type TogetherPlayer } from "@/hooks/use-practice-together";
import type { ReceivedScore } from "@/hooks/use-tab-sharing";
import { clearHandoff, takeHandoff } from "@/lib/practice-together/handoff";
import { hostOnLan, joinOnLan } from "@/lib/practice-together/lan";
import { storeQualityChoice } from "@/lib/practice-together/quality-presets";
import { Session, type SessionHooks } from "@/lib/practice-together/session";
import type { TabPayload } from "@/lib/practice-together/tab-transfer";
import { memoryPair, openPair, type PeerTransport } from "@/lib/practice-together/transport";
import { loadSong } from "@/lib/import";
import { writeGp7 } from "@/lib/export/gp7";
import type { Score } from "@/lib/score/model";
import { initialPractice } from "@/lib/score/practice";
import { isTauri, practiceSignalAvailable } from "@/lib/tauri";
import { fixtureBytes } from "@/test/score";

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
  // Two scores for the two apps: the key follows the object the hook is given.
  scoreFingerprint: vi.fn(async (score: Score) => ({
    key: (score as unknown as { fakeKey?: string }).fakeKey ?? "guest-own",
    bars: 8,
  })),
}));
vi.mock(import("@/lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  isTauri: vi.fn(() => true),
  practiceSignalAvailable: vi.fn(async () => true),
}));
vi.mock(import("sonner"), async (importOriginal) => ({
  ...(await importOriginal()),
  toast: Object.assign(vi.fn(), { info: vi.fn(), warning: vi.fn(), error: vi.fn() }) as never,
}));

const CODE = "ABCD-EFGH-JKMN-PQRS-TVWX";

function fakePlayer() {
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
    getTick: vi.fn(() => 0),
    barStartTick: vi.fn((index: number) => index * 3840),
  } satisfies TogetherPlayer;
}

const guestScore = { fakeKey: "guest-own", masterBars: [] } as unknown as Score;

async function hostTab(): Promise<TabPayload> {
  const { score } = await loadSong(fixtureBytes("practice-song.gp"), "practice-song.gp");
  return { name: "Practice song", bytes: writeGp7(score), key: "host-tab", bars: 8 };
}

/** The other computer: the host, with a tab to share. */
function hostPeer(transport: PeerTransport, tab: () => Promise<TabPayload>) {
  const hooks: SessionHooks = {
    prepare: async () => true,
    schedule: () => () => {},
    approve: async () => true,
    tab: { offer: tab },
  };
  return new Session({
    role: "host",
    transport,
    name: "Drummer",
    score: { key: "host-tab", bars: 8 },
    hooks,
    quality: "tight",
  });
}

function setup(over: { received?: { key: string; from: string }; score?: Score } = {}) {
  const player = fakePlayer();
  const onReceiveTab = vi.fn<(tab: ReceivedScore) => void>();
  const hook = renderHook(() =>
    usePracticeTogether({
      playerRef: { current: player },
      practice: initialPractice(),
      dispatchPractice: vi.fn(),
      score: over.score ?? guestScore,
      revision: 0,
      title: "My song",
      received: over.received,
      onReceiveTab,
    }),
  );
  return { player, onReceiveTab, ...hook };
}

beforeEach(() => {
  localStorage.clear();
  storeQualityChoice("tight");
  clearHandoff();
  vi.mocked(hostOnLan).mockReset();
  vi.mocked(joinOnLan).mockReset();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(practiceSignalAvailable).mockResolvedValue(true);
  vi.mocked(toast.warning).mockClear();
});

describe("usePracticeTogether: a guest without the host's tab", () => {
  it("receives it, hands the connection over and opens the tab", async () => {
    const pair = memoryPair({ up: 1, down: 1 });
    const payload = await hostTab();
    const host = hostPeer(pair[0], async () => payload);
    vi.mocked(joinOnLan).mockResolvedValue(pair[1]);
    openPair(pair);
    host.start("open");
    const { result, onReceiveTab } = setup();

    await act(async () => {
      await result.current.join("lan", CODE);
    });
    await waitFor(() => expect(onReceiveTab).toHaveBeenCalledOnce(), { timeout: 4000 });

    const tab = onReceiveTab.mock.calls[0]![0];
    expect(tab).toMatchObject({ name: "Practice song", key: "host-tab", from: "Drummer" });
    // The connection waits for the tab that is about to open, and this tab lets go of it.
    expect(result.current.state).toBeNull();
    expect(result.current.readOnly).toBe(false);
    const handoff = takeHandoff("host-tab");
    expect(handoff?.transport).toBe(pair[1]);
    expect(handoff?.peerName).toBe("Drummer");
    // The host still has its guest: the connection never closed.
    expect(host.snapshot.peerName).toBe("Player");
    expect(host.snapshot.phase).not.toBe("waiting");
  });

  it("shows the progress while it comes", async () => {
    const pair = memoryPair({ up: 30, down: 30 });
    const payload = { ...(await hostTab()), bytes: new Uint8Array(8192 * 40).fill(7) };
    const host = hostPeer(pair[0], async () => payload);
    vi.mocked(joinOnLan).mockResolvedValue(pair[1]);
    openPair(pair);
    host.start("open");
    const { result } = setup();
    await act(async () => {
      await result.current.join("lan", CODE);
    });

    await waitFor(() => expect(result.current.transfer?.direction).toBe("receive"), {
      timeout: 4000,
    });
    expect(result.current.transfer!.total).toBe(40);
  });

  it("tells the guest when the tab could not be opened here", async () => {
    const pair = memoryPair({ up: 1, down: 1 });
    // Bytes that are not a score: they arrive whole and checked, then fail to open.
    const payload = {
      name: "Broken",
      bytes: new Uint8Array([1, 2, 3, 4, 5]),
      key: "host-tab",
      bars: 1,
    };
    const host = hostPeer(pair[0], async () => payload);
    vi.mocked(joinOnLan).mockResolvedValue(pair[1]);
    openPair(pair);
    host.start("open");
    const { result, onReceiveTab } = setup();
    await act(async () => {
      await result.current.join("lan", CODE);
    });

    await waitFor(
      () => expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining("opened")),
      {
        timeout: 4000,
      },
    );
    expect(onReceiveTab).not.toHaveBeenCalled();
  });
});

describe("usePracticeTogether: the tab that was received", () => {
  it("takes the connection left for it and carries on as the same guest", async () => {
    const pair = memoryPair({ up: 1, down: 1 });
    const payload = await hostTab();
    const host = hostPeer(pair[0], async () => payload);
    vi.mocked(joinOnLan).mockResolvedValue(pair[1]);
    openPair(pair);
    host.start("open");
    const first = setup();
    await act(async () => {
      await first.result.current.join("lan", CODE);
    });
    await waitFor(() => expect(first.onReceiveTab).toHaveBeenCalledOnce(), { timeout: 4000 });
    const sessionId = host.snapshot.session;

    // The new tab mounts with the host's key (the app opened it from the received tab).
    const second = setup({ received: { key: "host-tab", from: "Drummer" } });
    await waitFor(() => expect(second.result.current.state?.phase).toBe("synchronized"), {
      timeout: 5000,
    });

    expect(second.result.current.state?.role).toBe("guest");
    expect(second.result.current.state?.peerName).toBe("Drummer");
    expect(second.result.current.readOnly).toBe(true);
    expect(host.snapshot.session).toBe(sessionId);
    expect(host.snapshot.phase).toBe("synchronized");
    // Nothing more to send: the tab's version matches the host's.
    expect(host.snapshot.problem).toBeNull();
    expect(second.onReceiveTab).not.toHaveBeenCalled();
  });

  it("is read-only while the session lasts and editable after leaving", async () => {
    const pair = memoryPair({ up: 1, down: 1 });
    const payload = await hostTab();
    const host = hostPeer(pair[0], async () => payload);
    vi.mocked(joinOnLan).mockResolvedValue(pair[1]);
    openPair(pair);
    host.start("open");
    const first = setup();
    await act(async () => {
      await first.result.current.join("lan", CODE);
    });
    await waitFor(() => expect(first.onReceiveTab).toHaveBeenCalledOnce(), { timeout: 4000 });
    const second = setup({ received: { key: "host-tab", from: "Drummer" } });
    await waitFor(() => expect(second.result.current.readOnly).toBe(true), { timeout: 4000 });

    act(() => second.result.current.leave());
    expect(second.result.current.readOnly).toBe(false);
  });

  it("does nothing when no connection was left for it", async () => {
    const { result } = setup({ received: { key: "unknown", from: "Drummer" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current.state).toBeNull();
  });
});
