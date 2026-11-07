import { act, renderHook, waitFor } from "@testing-library/react";

import { usePracticeTogether, type TogetherPlayer } from "@/hooks/use-practice-together";
import { hostOnLan } from "@/lib/practice-together/lan";
import {
  liveOwner,
  liveSession,
  liveSnapshot,
  resetLive,
  setLiveShower,
} from "@/lib/practice-together/live";
import { storeQualityChoice } from "@/lib/practice-together/quality-presets";
import type { Command } from "@/lib/practice-together/protocol";
import { Session, type SessionHooks } from "@/lib/practice-together/session";
import {
  memoryAcceptor,
  memoryPair,
  openPair,
  type GuestLink,
  type PeerTransport,
} from "@/lib/practice-together/transport";
import type { Score } from "@/lib/score/model";
import { initialPractice } from "@/lib/score/practice";
import { track } from "@/lib/telemetry";
import { toast } from "sonner";

/** Practice together across tabs: one session that moves between the open tabs of the app. */

vi.mock(import("@/lib/practice-together/lan"), () => ({
  hostOnLan: vi.fn(),
  joinOnLan: vi.fn(),
}));
vi.mock(import("@/lib/practice-together/rtc"), () => ({
  hostOverInternet: vi.fn(),
  joinOverInternet: vi.fn(),
  rtcSupported: vi.fn(() => false),
}));
// A tab's fingerprint is its `tag`, so two tabs are two different songs.
vi.mock(import("@/lib/practice-together/fingerprint"), () => ({
  scoreFingerprint: vi.fn(async (score: Score) => ({
    key: `score-${(score as unknown as { tag: string }).tag}`,
    bars: 8,
  })),
}));
vi.mock(import("@/lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  isTauri: vi.fn(() => false),
  practiceSignalAvailable: vi.fn(async () => false),
}));
vi.mock(import("sonner"), async (importOriginal) => ({
  ...(await importOriginal()),
  toast: Object.assign(vi.fn(), { info: vi.fn(), warning: vi.fn(), error: vi.fn() }) as never,
}));
vi.mock("@/lib/telemetry", () => ({ track: vi.fn() }));
// The tab the host offers is written to a file: a stand-in for the writer (the fake scores here
// are not real ones).
vi.mock(import("@/lib/export/gp7"), () => ({
  writeGp7: vi.fn(() => new Uint8Array([1, 2, 3])),
}));

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
    getTick: vi.fn(() => 960),
    barStartTick: vi.fn((index: number) => index * 3840),
  } satisfies TogetherPlayer;
}

/** A tab of the app: its own player and song (`tag`), shown or not. */
function tab(id: number, tag: string, initiallyActive = true) {
  const player = fakePlayer();
  const score = { masterBars: new Array(8).fill({}), tag } as unknown as Score;
  const hook = renderHook(
    ({ active }: { active: boolean }) =>
      usePracticeTogether({
        id,
        active,
        playerRef: { current: player },
        practice: initialPractice(),
        dispatchPractice: vi.fn(),
        score,
        revision: 0,
      }),
    { initialProps: { active: initiallyActive } },
  );
  return { id, player, ...hook };
}

/** The other computer: a guest session on the far end that records what happens to it. */
function guestOf(transport: PeerTransport, key = "score-A", log: Command[] = []) {
  const hooks: SessionHooks = {
    prepare: async (cmd) => {
      log.push(cmd);
      return true;
    },
    schedule: () => () => {},
  };
  const session = new Session({
    role: "guest",
    transport,
    name: "Bass laptop",
    score: { key, bars: 8 },
    hooks,
    quality: "tight",
  });
  return session;
}

beforeEach(() => {
  resetLive();
  localStorage.clear();
  storeQualityChoice("tight");
  vi.mocked(hostOnLan).mockReset();
  vi.mocked(track).mockClear();
});

/** Tab `host` hosts on the local network and a guest is let in; both are synchronized. */
async function hostingWithGuest(host: ReturnType<typeof tab>, log: Command[] = []) {
  const pair = memoryPair({ up: 1, down: 1 });
  const room = memoryAcceptor();
  vi.mocked(hostOnLan).mockResolvedValue({
    acceptor: room.acceptor,
    info: { code: "ABCD", link: "l", address: "a" },
  });
  await act(async () => {
    await host.result.current.host("lan");
  });
  const guest = guestOf(pair[1], "score-A", log);
  guest.start();
  openPair(pair);
  room.arrive(pair[0] as GuestLink);
  await waitFor(() => expect(host.result.current.approval).not.toBeNull());
  act(() => host.result.current.approval!.answer(true));
  await waitFor(() => expect(host.result.current.state?.phase).toBe("synchronized"), {
    timeout: 4000,
  });
  return { guest, pair, room };
}

const counted = (event: string) =>
  vi.mocked(track).mock.calls.filter(([name]) => name === event).length;

describe("a host's session moves to another tab", () => {
  it("is claimed by the new tab without leaving, and the guest stays in it", async () => {
    const first = tab(1, "A");
    const { guest } = await hostingWithGuest(first);
    const second = tab(2, "B", false);
    expect(second.result.current.elsewhere).toMatchObject({ role: "host", tabs: 1, here: false });
    expect(second.result.current.state).toBeNull();

    act(() => first.rerender({ active: false }));
    act(() => second.rerender({ active: true }));
    await act(async () => {
      await second.result.current.addToSession?.();
    });

    // The new tab shows the session; the old one does not.
    expect(liveOwner()?.id).toBe(2);
    expect(second.result.current.state?.phase).toBe("synchronized");
    expect(first.result.current.state).toBeNull();
    expect(first.result.current.elsewhere).toMatchObject({ role: "host", tabs: 2, here: true });
    expect(second.result.current.tabsInSession).toBe(2);
    // Nothing was left or asked again: the guest is still connected to the same session, and no
    // session was counted as started or as ended.
    expect(guest.snapshot.phase).not.toBe("closed");
    expect(guest.snapshot.phase).not.toBe("failed");
    expect(counted("practice_together_host")).toBe(1);
    expect(counted("practice_together_end")).toBe(0);
  });

  it("pauses the old tab's player before it moves, and carries the waiting guests over", async () => {
    const first = tab(1, "A");
    const { pair, room } = await hostingWithGuest(first);
    first.player.isPlaying.mockReturnValue(true);
    // A second guest asks to join while the host is on the first tab.
    const pair2 = memoryPair({ up: 1, down: 1 });
    const second = tab(2, "B");
    const late = guestOf(pair2[1]);
    late.start();
    openPair(pair2);
    room.arrive(pair2[0] as GuestLink);
    await waitFor(() => expect(first.result.current.approval?.name).toBe("Bass laptop"));
    void pair;

    await act(async () => {
      await second.result.current.addToSession?.();
    });

    expect(first.player.pause).toHaveBeenCalled();
    // The question is now asked in the tab that shows the session.
    expect(second.result.current.approval?.name).toBe("Bass laptop");
    expect(first.result.current.approval).toBeNull();
  });

  it("follows the host when it shows a tab that is in the session", async () => {
    const first = tab(1, "A");
    await hostingWithGuest(first);
    const second = tab(2, "B", false);
    act(() => first.rerender({ active: false }));
    act(() => second.rerender({ active: true }));
    await act(async () => {
      await second.result.current.addToSession?.();
    });
    expect(liveOwner()?.id).toBe(2);

    // The host goes back to the first tab: the session comes along on its own.
    act(() => second.rerender({ active: false }));
    act(() => first.rerender({ active: true }));
    await waitFor(() => expect(liveOwner()?.id).toBe(1));
    expect(first.result.current.state?.phase).toBe("synchronized");
    expect(second.result.current.state).toBeNull();
  });

  it("does not move when a tab that is not in the session is shown", async () => {
    const first = tab(1, "A");
    await hostingWithGuest(first);
    const other = tab(3, "C", false);
    act(() => other.rerender({ active: true }));
    await act(async () => {});
    expect(liveOwner()?.id).toBe(1);
    expect(other.result.current.state).toBeNull();
  });
});

describe("a host that switches tab while the song plays", () => {
  /** Tab 2 holds the session and plays; the host then shows tab 1. */
  async function playingInSecondTab() {
    const asked: Command[] = [];
    const first = tab(1, "A");
    const { guest } = await hostingWithGuest(first, asked);
    const second = tab(2, "B");
    act(() => first.rerender({ active: false }));
    await act(async () => {
      await second.result.current.addToSession?.();
    });
    expect(liveOwner()?.id).toBe(2);
    // The guest has received tab B (the host's other tab), so it can be started again.
    guest.setScore({ key: "score-B", bars: 8 });
    await waitFor(() => expect(second.result.current.state?.problem).toBeNull(), { timeout: 4000 });
    asked.length = 0;
    second.player.isPlaying.mockReturnValue(true);
    return { first, second, guest, asked };
  }

  it("stops it for the guests when the tab is hidden first, then the session moves", async () => {
    const { first, second, asked } = await playingInSecondTab();
    // The host's other tab comes to the front and starts taking the session (it is the first
    // effect that runs)...
    act(() => first.rerender({ active: true }));
    // ...and the tab that goes to the back still sends the shared pause, as the workspace does.
    act(() => {
      second.result.current.intercept({ kind: "playPause" });
    });
    act(() => second.rerender({ active: false }));
    await waitFor(() => expect(liveOwner()?.id).toBe(1), { timeout: 4000 });
    // The pause reached the guest (moving the session did not call it off), and it stopped here.
    await waitFor(() => expect(asked.map((c) => c.action)).toContain("pause"), { timeout: 4000 });
    expect(second.player.pause).toHaveBeenCalled();
  });

  it("also stops a Play that went out a moment ago and has not started here yet", async () => {
    const { first, second, asked } = await playingInSecondTab();
    // The host pressed Play and switched tab at once: the start is a moment ahead, so nothing
    // plays on this computer yet, but the guests were told.
    second.player.isPlaying.mockReturnValue(false);
    act(() => {
      second.result.current.intercept({ kind: "playPause" });
    });
    act(() => second.rerender({ active: false }));
    act(() => first.rerender({ active: true }));
    await waitFor(() => expect(liveOwner()?.id).toBe(1), { timeout: 4000 });
    await waitFor(() => expect(asked.map((c) => c.action)).toEqual(["play", "pause"]), {
      timeout: 4000,
    });
  });

  it("stops it for the guests when the session moves without the tab being hidden first", async () => {
    const { first, second, asked } = await playingInSecondTab();
    act(() => second.rerender({ active: false }));
    act(() => first.rerender({ active: true }));
    await waitFor(() => expect(liveOwner()?.id).toBe(1), { timeout: 4000 });
    await waitFor(() => expect(asked.map((c) => c.action)).toContain("pause"), { timeout: 4000 });
    expect(second.player.pause).toHaveBeenCalled();
  });
});

describe("closing the tab that holds the session", () => {
  it("moves it to another tab of the session", async () => {
    const shown: number[] = [];
    setLiveShower((id) => shown.push(id));
    const first = tab(1, "A");
    const { guest } = await hostingWithGuest(first);
    const second = tab(2, "B");
    await act(async () => {
      await second.result.current.addToSession?.();
    });
    expect(liveOwner()?.id).toBe(2);

    second.unmount();
    // The app is asked to show the tab, and the session goes there; the guest never left.
    expect(shown).toContain(1);
    await waitFor(() => expect(liveOwner()?.id).toBe(1));
    expect(first.result.current.state?.phase).toBe("synchronized");
    expect(guest.snapshot.phase).not.toBe("closed");
    expect(counted("practice_together_end")).toBe(0);
  });

  it("ends the session with its last tab", async () => {
    const first = tab(1, "A");
    const { guest } = await hostingWithGuest(first);
    first.unmount();
    await waitFor(() => expect(guest.snapshot.phase).toBe("closed"));
    expect(liveSession()).toBeNull();
    expect(liveSnapshot().live).toBe(false);
  });

  it("leaving ends the whole session, wherever it is shown", async () => {
    const first = tab(1, "A");
    const { guest } = await hostingWithGuest(first);
    const second = tab(2, "B");
    await act(async () => {
      await second.result.current.addToSession?.();
    });
    act(() => second.result.current.leave());
    await waitFor(() => expect(guest.snapshot.phase).toBe("closed"));
    expect(liveSnapshot().live).toBe(false);
    expect(first.result.current.elsewhere).toBeNull();
    expect(second.result.current.state).toBeNull();
  });
});

/**
 * A guest that joined with tab 1 (song A) and has tab 2 (song B) open as well; the host then moves
 * to song B, so the session moves to tab 2 and tab 1 stays in it without holding it.
 */
async function guestSessionMovedToSecondTab() {
  const shown: number[] = [];
  setLiveShower((id) => shown.push(id));
  const pair = memoryPair({ up: 1, down: 1 });
  const hostSession = new Session({
    role: "host",
    transport: pair[0],
    name: "Drummer",
    score: { key: "score-A", bars: 8 },
    hooks: {
      prepare: async () => true,
      schedule: () => () => {},
      approve: async () => true,
      tab: {
        offer: async () => ({
          name: "Song B",
          bytes: new Uint8Array([1, 2, 3]),
          key: "score-B",
          bars: 8,
        }),
      },
    },
    quality: "tight",
  });
  const first = tab(1, "A");
  const second = tab(2, "B", false);
  const { joinOnLan } = await import("@/lib/practice-together/lan");
  vi.mocked(joinOnLan).mockResolvedValue(pair[1]);
  hostSession.start();
  openPair(pair);
  await act(async () => {
    await first.result.current.join("lan", "ABCD");
  });
  await waitFor(() => expect(first.result.current.state?.phase).toBe("synchronized"), {
    timeout: 4000,
  });
  // Tab 2 is known to the app (its fingerprint is published while a session is live).
  await waitFor(() => expect(liveSnapshot().live).toBe(true));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });

  // The host moves to its song B: the guest has it in tab 2.
  hostSession.setScore({ key: "score-B", bars: 8 });
  await waitFor(() => expect(shown).toContain(2), { timeout: 4000 });
  act(() => second.rerender({ active: true }));
  await waitFor(() => expect(liveOwner()?.id).toBe(2), { timeout: 4000 });
  return { first, second, hostSession };
}

describe("a guest that has the tab the host moves to", () => {
  it("shows that tab instead of receiving a copy, and the session moves there", async () => {
    const { first, second } = await guestSessionMovedToSecondTab();
    expect(second.result.current.state?.phase).toBeDefined();
    expect(first.result.current.state).toBeNull();
    // Both tabs are read-only while the session lasts (a guest's tabs follow the host).
    expect(first.result.current.readOnly).toBe(true);
    expect(second.result.current.readOnly).toBe(true);
  });

  it("does not play a tab of the session that is not the one in play, on its own", async () => {
    const { first, second } = await guestSessionMovedToSecondTab();
    first.rerender({ active: true });
    // Tab 1 is in the session but the host plays song B in tab 2: Play here must not start
    // a local-only playback, and says why.
    let handled = false;
    act(() => {
      handled = first.result.current.intercept({ kind: "playPause" });
    });
    expect(handled).toBe(true);
    expect(first.player.playPause).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith(
      "This tab is not the one in play.",
      expect.objectContaining({ id: "together-not-in-play" }),
    );
    // The tab that holds the session still routes the request through it.
    act(() => {
      second.result.current.intercept({ kind: "playPause" });
    });
    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  it("leaves a tab that is not in the session alone", async () => {
    await guestSessionMovedToSecondTab();
    const outside = tab(3, "C", false);
    let handled = true;
    act(() => {
      handled = outside.result.current.intercept({ kind: "playPause" });
    });
    expect(handled).toBe(false);
  });
});
