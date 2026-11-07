import { act, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";

import { usePracticeTogether, type TogetherPlayer } from "@/hooks/use-practice-together";
import { hostOnLan, joinOnLan } from "@/lib/practice-together/lan";
import { storeQualityChoice } from "@/lib/practice-together/quality-presets";
import { hostOverInternet, joinOverInternet, rtcSupported } from "@/lib/practice-together/rtc";
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
import { initialPractice, type PracticeState } from "@/lib/score/practice";
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
vi.mock(import("@/lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  isTauri: vi.fn(() => true),
  practiceSignalAvailable: vi.fn(async () => true),
}));
vi.mock(import("sonner"), async (importOriginal) => ({
  ...(await importOriginal()),
  toast: Object.assign(vi.fn(), {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }) as never,
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
    getTick: vi.fn(() => 960),
    barStartTick: vi.fn((index: number) => index * 3840),
  } satisfies TogetherPlayer;
}

/** The app listens on the local network; `arrive` lets a pair's host end connect as a guest. */
function listening(
  pair: [PeerTransport, PeerTransport],
  info = { code: CODE, link: "l", address: "a" },
) {
  const room = memoryAcceptor();
  vi.mocked(hostOnLan).mockResolvedValue({ acceptor: room.acceptor, info });
  return { ...room, connect: () => room.arrive(pair[0] as GuestLink) };
}

/** The other computer: a real session on the far end of the pipe, recording what it is asked. */
function peer(role: "host" | "guest", transport: PeerTransport, name = "Other") {
  const log = {
    prepared: [] as Command[],
    scheduled: [] as Command[],
    cancelled: 0,
    requested: [] as [string, number | undefined][],
  };
  const hooks: SessionHooks = {
    async prepare(cmd) {
      log.prepared.push(cmd);
      return true;
    },
    schedule(cmd) {
      log.scheduled.push(cmd);
      return () => void (log.cancelled += 1);
    },
    request(action, tick) {
      log.requested.push([action, tick]);
    },
  };
  const session = new Session({
    role,
    transport,
    name,
    score: { key: "score-a", bars: 8 },
    hooks,
    quality: "tight",
  });
  return { session, log };
}

interface Props {
  practice: PracticeState;
}

function setup() {
  const player = fakePlayer();
  const dispatchPractice = vi.fn();
  const hook = renderHook(
    ({ practice }: Props) =>
      usePracticeTogether({
        playerRef: { current: player },
        practice,
        dispatchPractice,
        score: {} as Score,
        revision: 0,
      }),
    { initialProps: { practice: initialPractice() } },
  );
  return { player, dispatchPractice, ...hook };
}

type Setup = ReturnType<typeof setup>;

/** The app hosts on the local network and `guest` joins; both are synchronized when this returns. */
async function hosting(): Promise<Setup & { guest: ReturnType<typeof peer> }> {
  const pair = memoryPair({ up: 1, down: 1 });
  const room = listening(pair, {
    code: CODE,
    link: `smartbeat://join/${CODE}`,
    address: "10.0.0.2:5000",
  });
  const context = setup();
  await act(async () => {
    await context.result.current.host("lan");
  });
  const guest = peer("guest", pair[1], "Bass laptop");
  openPair(pair);
  room.connect();
  await waitFor(() => expect(context.result.current.approval).not.toBeNull());
  act(() => context.result.current.approval!.answer(true));
  await waitFor(() => expect(context.result.current.state?.phase).toBe("synchronized"), {
    timeout: 4000,
  });
  return { ...context, guest };
}

/** The app joins a host (a real session on the far end); both are synchronized when this returns. */
async function joining(): Promise<Setup & { host: ReturnType<typeof peer> }> {
  const pair = memoryPair({ up: 1, down: 1 });
  const host = peer("host", pair[0], "Drummer");
  vi.mocked(joinOnLan).mockResolvedValue(pair[1]);
  openPair(pair);
  const context = setup();
  await act(async () => {
    await context.result.current.join("lan", CODE);
  });
  await waitFor(() => expect(context.result.current.state?.phase).toBe("synchronized"), {
    timeout: 4000,
  });
  await waitFor(() => expect(host.session.snapshot.phase).toBe("synchronized"), {
    timeout: 4000,
  });
  return { ...context, host };
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
  vi.mocked(toast.info).mockClear();
  vi.mocked(toast.warning).mockClear();
});

describe("usePracticeTogether: hosting", () => {
  it("exposes the room code and waits for a guest", async () => {
    const pair = memoryPair();
    listening(pair, { code: CODE, link: `smartbeat://join/${CODE}`, address: "10.0.0.2:5000" });
    const { result } = setup();
    expect(result.current.state).toBeNull();
    await act(async () => {
      await result.current.host("lan");
    });
    expect(result.current.hostCode).toEqual({ kind: "lan", code: CODE, address: "10.0.0.2:5000" });
    expect(result.current.state).toMatchObject({ role: "host", phase: "waiting" });
    expect(result.current.starting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("hosts over the internet with the short code", async () => {
    vi.mocked(hostOverInternet).mockResolvedValue({
      acceptor: memoryAcceptor().acceptor,
      code: "ABCD-EFGH",
    });
    const { result } = setup();
    await act(async () => {
      await result.current.host("internet");
    });
    expect(result.current.hostCode).toEqual({ kind: "internet", code: "ABCD-EFGH" });
    expect(result.current.state?.role).toBe("host");
  });

  it("asks before letting a guest in, and lets them in on yes", async () => {
    const { result, guest } = await hosting();
    expect(result.current.approval).toBeNull();
    expect(result.current.state).toMatchObject({ phase: "synchronized", peerName: "Bass laptop" });
    expect(guest.session.snapshot.phase).toBe("synchronized");
  });

  it("keeps a guest out on no", async () => {
    const pair = memoryPair({ up: 1, down: 1 });
    const room = listening(pair);
    const { result } = setup();
    await act(async () => {
      await result.current.host("lan");
    });
    const guest = peer("guest", pair[1], "Stranger");
    openPair(pair);
    room.connect();
    await waitFor(() => expect(result.current.approval?.name).toBe("Stranger"));
    expect(result.current.state?.phase).toBe("approving");
    act(() => result.current.approval!.answer(false));
    await waitFor(() => expect(guest.session.snapshot.phase).toBe("failed"));
    expect(guest.session.snapshot.problem?.kind).toBe("declined");
    expect(result.current.approval).toBeNull();
    expect(result.current.state?.phase).toBe("waiting");
  });

  it("shows an error when it cannot listen", async () => {
    vi.mocked(hostOnLan).mockRejectedValue({ kind: "network", message: "Could not listen: no" });
    const { result } = setup();
    await act(async () => {
      await result.current.host("lan");
    });
    expect(result.current.error).toBe("Could not listen: no");
    expect(result.current.state).toBeNull();
    expect(result.current.hostCode).toBeNull();
    expect(result.current.starting).toBe(false);
  });

  it("shows the message of an Error too", async () => {
    vi.mocked(hostOverInternet).mockRejectedValue(new Error("No meeting service."));
    const { result } = setup();
    await act(async () => {
      await result.current.host("internet");
    });
    expect(result.current.error).toBe("No meeting service.");
  });
});

describe("usePracticeTogether: joining", () => {
  it("joins on the local network and reaches synchronized", async () => {
    const { result, host } = await joining();
    expect(joinOnLan).toHaveBeenCalledWith(CODE);
    expect(result.current.state).toMatchObject({
      role: "guest",
      phase: "synchronized",
      peerName: "Drummer",
    });
    expect(host.session.snapshot.peerName).toBe("Player");
  });

  it("joins over the internet", async () => {
    const pair = memoryPair();
    vi.mocked(joinOverInternet).mockResolvedValue(pair[1]);
    const { result } = setup();
    await act(async () => {
      await result.current.join("internet", "ABCD-EFGH");
    });
    expect(joinOverInternet).toHaveBeenCalledWith(
      "ABCD-EFGH",
      undefined,
      expect.stringMatching(/^[0-9a-f]{16}$/),
    );
    expect(result.current.state?.role).toBe("guest");
    expect(result.current.state?.phase).toBe("syncing");
  });

  it("shows why joining failed", async () => {
    vi.mocked(joinOnLan).mockRejectedValue({
      kind: "invalid-code",
      message: "That is not a room code.",
    });
    const { result } = setup();
    await act(async () => {
      await result.current.join("lan", "nope");
    });
    expect(result.current.error).toBe("That is not a room code.");
    expect(result.current.state).toBeNull();
    expect(result.current.starting).toBe(false);
  });

  it("clears an earlier error when it tries again", async () => {
    vi.mocked(joinOnLan).mockRejectedValueOnce(new Error("First failure"));
    const { result } = setup();
    await act(async () => {
      await result.current.join("lan", "x");
    });
    expect(result.current.error).toBe("First failure");
    const pair = memoryPair();
    vi.mocked(joinOnLan).mockResolvedValue(pair[1]);
    await act(async () => {
      await result.current.join("lan", "y");
    });
    expect(result.current.error).toBeNull();
  });
});

describe("usePracticeTogether: the host's transport", () => {
  it("is not handled without a session", () => {
    const { result, player } = setup();
    expect(result.current.intercept({ kind: "playPause" })).toBe(false);
    expect(player.playPause).not.toHaveBeenCalled();
  });

  it("is not handled while a host is still waiting for a guest", async () => {
    const pair = memoryPair();
    listening(pair);
    const { result } = setup();
    await act(async () => {
      await result.current.host("lan");
    });
    expect(result.current.intercept({ kind: "playPause" })).toBe(false);
  });

  it("starts both players together on Play, at the agreed time", async () => {
    const { result, player, guest } = await hosting();
    let handled = false;
    act(() => {
      handled = result.current.intercept({ kind: "playPause" });
    });
    expect(handled).toBe(true);
    await waitFor(() => expect(guest.log.scheduled).toHaveLength(1), { timeout: 3000 });
    await waitFor(() => expect(player.playPause).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const cmd = guest.log.scheduled[0]!;
    expect(cmd).toMatchObject({ action: "play", tick: 960, speed: 100, loop: null });
    expect(player.seekToTick).toHaveBeenCalledWith(960);
  });

  it("pauses both when it is already playing", async () => {
    const { result, player, guest } = await hosting();
    player.isPlaying.mockReturnValue(true);
    act(() => {
      result.current.intercept({ kind: "playPause" });
    });
    await waitFor(() => expect(guest.log.scheduled[0]?.action).toBe("pause"), { timeout: 3000 });
    await waitFor(() => expect(player.pause).toHaveBeenCalled(), { timeout: 3000 });
  });

  it("stops both", async () => {
    const { result, player, guest } = await hosting();
    act(() => {
      result.current.intercept({ kind: "stop" });
    });
    await waitFor(() => expect(guest.log.scheduled[0]?.action).toBe("stop"), { timeout: 3000 });
    await waitFor(() => expect(player.stop).toHaveBeenCalled(), { timeout: 3000 });
  });

  it("moves both to a bar, and plays from a bar", async () => {
    const { result, player, guest } = await hosting();
    act(() => {
      result.current.intercept({ kind: "seekBar", bar: 3 });
    });
    await waitFor(() => expect(guest.log.scheduled).toHaveLength(1), { timeout: 3000 });
    expect(guest.log.scheduled[0]).toMatchObject({ action: "seek", tick: 3 * 3840 });
    await waitFor(() => expect(player.seekToTick).toHaveBeenCalledWith(3 * 3840), {
      timeout: 3000,
    });

    act(() => {
      result.current.intercept({ kind: "playFromBar", bar: 2 });
    });
    await waitFor(() => expect(guest.log.scheduled).toHaveLength(2), { timeout: 3000 });
    expect(guest.log.scheduled[1]).toMatchObject({ action: "play", tick: 2 * 3840 });
  });

  it("does not move the position while the song plays", async () => {
    const { result, player, guest } = await hosting();
    player.isPlaying.mockReturnValue(true);
    let handled = false;
    act(() => {
      handled = result.current.intercept({ kind: "seekBar", bar: 3 });
    });
    expect(handled).toBe(true);
    act(() => {
      result.current.intercept({ kind: "playFromBar", bar: 2 });
    });
    expect(toast.info).toHaveBeenCalledWith(
      "Pause or stop first to move to another bar in a Practice together session.",
      { id: "together-seek" },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(guest.log.scheduled).toEqual([]);
    // Stopping is allowed while it plays.
    act(() => {
      result.current.intercept({ kind: "stop" });
    });
    await waitFor(() => expect(guest.log.scheduled[0]?.action).toBe("stop"), { timeout: 3000 });
  });

  it("does what the guest asks: starts and stops both, with its own position", async () => {
    const { player, guest } = await hosting();
    act(() => void guest.session.request("play"));
    await waitFor(() => expect(guest.log.scheduled).toHaveLength(1), { timeout: 3000 });
    expect(guest.log.scheduled[0]).toMatchObject({ action: "play", tick: 960 });
    await waitFor(() => expect(player.playPause).toHaveBeenCalledTimes(1), { timeout: 3000 });

    player.isPlaying.mockReturnValue(true);
    act(() => void guest.session.request("pause"));
    await waitFor(() => expect(guest.log.scheduled[1]?.action).toBe("pause"), { timeout: 3000 });
    await waitFor(() => expect(player.pause).toHaveBeenCalled(), { timeout: 3000 });

    act(() => void guest.session.request("stop"));
    await waitFor(() => expect(guest.log.scheduled[2]?.action).toBe("stop"), { timeout: 3000 });
  });

  it("ignores a guest's request that makes no sense now", async () => {
    const { player, guest } = await hosting();
    player.isPlaying.mockReturnValue(true);
    act(() => {
      guest.session.request("play");
      guest.session.request("seek", 3840);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(guest.log.scheduled).toEqual([]);
    player.isPlaying.mockReturnValue(false);
    act(() => void guest.session.request("pause"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(guest.log.scheduled).toEqual([]);
  });

  it("moves to the position the guest picked, while stopped", async () => {
    const { guest } = await hosting();
    act(() => void guest.session.request("seek", 7680));
    await waitFor(() => expect(guest.log.scheduled).toHaveLength(1), { timeout: 3000 });
    expect(guest.log.scheduled[0]).toMatchObject({ action: "seek", tick: 7680 });
  });

  it("starts again, stops and moves after the song has played to its end", async () => {
    const { result, player, guest } = await hosting();
    // The song plays, reaches its end and stops by itself.
    player.isPlaying.mockReturnValue(true);
    player.isPlaying.mockReturnValue(false);
    player.getTick.mockReturnValue(0);
    act(() => void result.current.intercept({ kind: "playPause" }));
    await waitFor(() => expect(guest.log.scheduled[0]?.action).toBe("play"), { timeout: 3000 });
    await waitFor(() => expect(player.playPause).toHaveBeenCalledTimes(1), { timeout: 3000 });
    act(() => void result.current.intercept({ kind: "stop" }));
    await waitFor(() => expect(guest.log.scheduled[1]?.action).toBe("stop"), { timeout: 3000 });
    await waitFor(() => expect(player.stop).toHaveBeenCalledTimes(1), { timeout: 3000 });
    act(() => void result.current.intercept({ kind: "seekBar", bar: 2 }));
    await waitFor(() => expect(guest.log.scheduled[2]?.action).toBe("seek"), { timeout: 3000 });
    await waitFor(() => expect(player.seekToTick).toHaveBeenCalledWith(2 * 3840), {
      timeout: 3000,
    });
  });

  it("says so when a start cannot happen, instead of doing nothing", async () => {
    const { result, guest } = await hosting();
    // The guest has another version of the tab: a start is refused.
    act(() => void guest.session.setScore({ key: "score-b", bars: 8 }));
    await waitFor(() => expect(result.current.state?.problem?.kind).toBe("score"), {
      timeout: 3000,
    });
    vi.mocked(toast.info).mockClear();
    act(() => void result.current.intercept({ kind: "playPause" }));
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "The other computer has a different version of this tab yet. Wait for the tab to arrive.",
        { id: "together-start" },
      ),
    );
    expect(guest.log.scheduled).toEqual([]);
  });

  it("gets its sound ready when the click that hosts arrives", async () => {
    const { player } = await hosting();
    expect(player.warmUpAudio).toHaveBeenCalled();
  });

  it("sends a changed speed, loop, metronome and count-in to the guest", async () => {
    const { rerender, guest } = await hosting();
    rerender({
      practice: {
        ...initialPractice(),
        speed: 70,
        metronome: true,
        loop: true,
        range: { start: 1, end: 2 },
      },
    });
    await waitFor(
      () => expect(guest.log.prepared.some((c) => c.action === "settings")).toBe(true),
      {
        timeout: 3000,
      },
    );
    const settings = guest.log.prepared.find((c) => c.action === "settings")!;
    expect(settings).toMatchObject({
      speed: 70,
      metronome: true,
      loop: { from: 1, to: 2 },
      tick: 960,
    });
  });

  it("does not resend settings that did not change", async () => {
    const { rerender, guest } = await hosting();
    rerender({ practice: { ...initialPractice() } });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(guest.log.prepared.filter((c) => c.action === "settings")).toHaveLength(0);
  });
});

describe("usePracticeTogether: the guest", () => {
  it("asks the host for Play, Pause and Stop, and does not start on its own", async () => {
    const { result, player, host } = await joining();
    let handled = false;
    act(() => {
      handled = result.current.intercept({ kind: "playPause" });
    });
    expect(handled).toBe(true);
    player.isPlaying.mockReturnValue(true);
    act(() => {
      result.current.intercept({ kind: "playPause" });
      result.current.intercept({ kind: "stop" });
    });
    await waitFor(() => expect(host.log.requested).toHaveLength(3), { timeout: 3000 });
    expect(host.log.requested).toEqual([
      ["play", undefined],
      ["pause", undefined],
      ["stop", 0],
    ]);
    expect(player.playPause).not.toHaveBeenCalled();
    expect(player.stop).not.toHaveBeenCalled();
  });

  it("asks the host to move to a bar while stopped, and to play from it", async () => {
    const { result, host } = await joining();
    act(() => {
      result.current.intercept({ kind: "seekBar", bar: 2 });
      result.current.intercept({ kind: "playFromBar", bar: 3 });
    });
    await waitFor(() => expect(host.log.requested).toHaveLength(2), { timeout: 3000 });
    expect(host.log.requested).toEqual([
      ["seek", 2 * 3840],
      ["play", 3 * 3840],
    ]);
  });

  it("does not move the position while the song plays, and says why", async () => {
    const { result, player, host } = await joining();
    player.isPlaying.mockReturnValue(true);
    for (const request of [
      { kind: "seekBar", bar: 2 },
      { kind: "playFromBar", bar: 2 },
    ] as const) {
      let handled = false;
      act(() => {
        handled = result.current.intercept(request);
      });
      expect(handled).toBe(true);
    }
    expect(toast.info).toHaveBeenCalledWith(
      "Pause or stop first to move to another bar in a Practice together session.",
      { id: "together-seek" },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.log.requested).toEqual([]);
    expect(player.seekToTick).not.toHaveBeenCalled();
  });

  it("asks the host again after the song has played to its end", async () => {
    const { result, player, host } = await joining();
    player.isPlaying.mockReturnValue(true);
    player.isPlaying.mockReturnValue(false);
    act(() => {
      result.current.intercept({ kind: "playPause" });
      result.current.intercept({ kind: "stop" });
      result.current.intercept({ kind: "seekBar", bar: 1 });
    });
    await waitFor(() => expect(host.log.requested).toHaveLength(3), { timeout: 3000 });
    expect(host.log.requested).toEqual([
      ["play", undefined],
      ["stop", 0],
      ["seek", 3840],
    ]);
  });

  it("gets its sound ready when the click that joins arrives", async () => {
    const { player } = await joining();
    expect(player.warmUpAudio).toHaveBeenCalled();
  });

  it("takes the host's speed, loop, metronome and count-in", async () => {
    const { host, dispatchPractice } = await joining();
    await act(async () => {
      await host.session.command({
        action: "settings",
        tick: 0,
        speed: 70,
        loop: { from: 1, to: 3 },
        metronome: true,
        countIn: true,
        countInBeats: 2,
      });
    });
    await waitFor(() => expect(dispatchPractice).toHaveBeenCalled());
    const actions = dispatchPractice.mock.calls.map(([action]) => action);
    expect(actions).toEqual(
      expect.arrayContaining([
        { type: "loop", value: true, range: { start: 1, end: 3 } },
        { type: "speed", value: 70 },
        { type: "metronome", value: true },
        { type: "count-in", value: true },
        { type: "count-in-beats", value: 2 },
      ]),
    );
  });

  it("starts at the host's start", async () => {
    const { host, player } = await joining();
    const result = await host.session.command({
      action: "play",
      tick: 1920,
      speed: 100,
      loop: null,
      metronome: false,
      countIn: false,
      countInBeats: 4,
    });
    expect(result).toBe("started");
    await waitFor(() => expect(player.playPause).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(player.seekToTick).toHaveBeenCalledWith(1920);
  });

  // A different tab is no longer an error: the host sends its own (use-practice-together-tab.test).
});

describe("usePracticeTogether: ending and remembering", () => {
  it("leaves: the session, the code and the approval are gone, and the far end hears it", async () => {
    const { result, guest } = await hosting();
    act(() => result.current.leave());
    expect(result.current.state).toBeNull();
    expect(result.current.hostCode).toBeNull();
    expect(result.current.approval).toBeNull();
    await waitFor(() => expect(guest.session.snapshot.problem?.kind).toBe("peer-left"));
  });

  it("starting again ends the session before", async () => {
    const { result, guest } = await hosting();
    const pair = memoryPair();
    listening(pair, { code: "ZZZZ", link: "l", address: "a" });
    await act(async () => {
      await result.current.host("lan");
    });
    expect(result.current.hostCode?.code).toBe("ZZZZ");
    await waitFor(() => expect(guest.session.snapshot.problem?.kind).toBe("peer-left"));
  });

  it("ends the session when the song goes away", async () => {
    const { unmount, guest } = await hosting();
    unmount();
    await waitFor(() => expect(guest.session.snapshot.problem?.kind).toBe("peer-left"));
  });

  it("remembers the audio quality and applies it to the running session", async () => {
    const { result, unmount } = await hosting();
    expect(result.current.quality).toBe("tight");
    expect(result.current.state?.preset).toBe("tight");
    act(() => result.current.setQuality("safe"));
    expect(result.current.quality).toBe("safe");
    expect(result.current.state?.preset).toBe("safe");
    expect(localStorage.getItem("smart-beat:practice-together:quality")).toBe("safe");
    unmount();
    const again = renderHook(() =>
      usePracticeTogether({
        playerRef: { current: null },
        practice: initialPractice(),
        dispatchPractice: vi.fn(),
        score: {} as Score,
        revision: 0,
      }),
    );
    expect(again.result.current.quality).toBe("safe");
  });

  it("remembers the name", () => {
    const { result } = setup();
    expect(result.current.name).toBe("Player");
    act(() => result.current.setName("Mark"));
    expect(result.current.name).toBe("Mark");
    expect(localStorage.getItem("smart-beat:practice-together:name")).toBe("Mark");
    const again = setup();
    expect(again.result.current.name).toBe("Mark");
  });

  it("offers the internet only where the build, the app and the webview allow it", async () => {
    const yes = setup();
    await waitFor(() => expect(yes.result.current.internetAvailable).toBe(true));

    vi.mocked(rtcSupported).mockReturnValue(false);
    const noRtc = setup();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(noRtc.result.current.internetAvailable).toBe(false);

    vi.mocked(rtcSupported).mockReturnValue(true);
    vi.mocked(practiceSignalAvailable).mockResolvedValue(false);
    const noWorker = setup();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(noWorker.result.current.internetAvailable).toBe(false);

    vi.mocked(isTauri).mockReturnValue(false);
    const browser = setup();
    expect(browser.result.current.internetAvailable).toBe(false);
  });

  it("ignores a failing signaling-service check", async () => {
    vi.mocked(practiceSignalAvailable).mockRejectedValue(new Error("no"));
    const { result } = setup();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.internetAvailable).toBe(false);
  });
});
