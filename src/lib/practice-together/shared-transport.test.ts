import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Command } from "@/lib/practice-together/protocol";
import { Session } from "@/lib/practice-together/session";
import {
  SharedTransport,
  fireAt,
  type TransportPlayer,
} from "@/lib/practice-together/shared-transport";
import { memoryPair, openPair } from "@/lib/practice-together/transport";

class FakePlayer implements TransportPlayer {
  playing = false;
  tick = 0;
  heard: number | null = 0;
  latency = 0;
  ready = true;
  events: { what: string; at: number }[] = [];
  private readonly clock: () => number;
  constructor(clock: () => number = () => performance.now()) {
    this.clock = clock;
  }
  isPlaying() {
    return this.playing;
  }
  playPause() {
    this.playing = !this.playing;
    this.events.push({ what: this.playing ? "play" : "pause", at: this.clock() });
  }
  pause() {
    if (this.playing) this.playPause();
  }
  stop() {
    this.playing = false;
    this.events.push({ what: "stop", at: this.clock() });
    return false;
  }
  seekToTick(tick: number) {
    this.tick = tick;
    this.events.push({ what: `seek ${tick}`, at: this.clock() });
  }
  heardTimeMs() {
    return this.heard;
  }
  outputLatencyMs() {
    return this.latency;
  }
  isReady() {
    return this.ready;
  }
}

const cmd = (over: Partial<Command> = {}): Command => ({
  id: 1,
  action: "play",
  tick: 1920,
  at: 0,
  speed: 100,
  loop: null,
  metronome: false,
  countIn: false,
  countInBeats: 4,
  ...over,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("fireAt", () => {
  it("acts at the given time, not before", async () => {
    const calls: number[] = [];
    fireAt(
      performance.now() + 100,
      () => performance.now(),
      () => calls.push(performance.now()),
      0,
    );
    await vi.advanceTimersByTimeAsync(80);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(40);
    expect(calls).toHaveLength(1);
  });

  it("can be called off", async () => {
    const calls: number[] = [];
    const cancel = fireAt(
      performance.now() + 50,
      () => performance.now(),
      () => calls.push(1),
      0,
    );
    cancel();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([]);
  });

  it("acts at once for a time already past", async () => {
    const calls: number[] = [];
    fireAt(
      performance.now() - 10,
      () => performance.now(),
      (error) => calls.push(error),
      0,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThanOrEqual(10);
  });
});

describe("SharedTransport commands", () => {
  function make(player: FakePlayer | null = new FakePlayer()) {
    const applied: Command[] = [];
    const transport = new SharedTransport({
      player: () => player,
      applySettings: (c) => applied.push(c),
      settleMs: 10,
      spinMs: 0,
    });
    return { transport, player, applied };
  }

  it("prepares: applies the settings and moves to the tick for a play", async () => {
    const { transport, player, applied } = make();
    const ready = transport.hooks.prepare(cmd({ speed: 75 }));
    await vi.advanceTimersByTimeAsync(20);
    expect(await ready).toBe(true);
    expect(applied[0]?.speed).toBe(75);
    expect(player!.events.map((e) => e.what)).toEqual(["seek 1920"]);
  });

  it("does not move for a pause or a settings change", async () => {
    const { transport, player } = make();
    const a = transport.hooks.prepare(cmd({ action: "pause" }));
    const b = transport.hooks.prepare(cmd({ action: "settings" }));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.all([a, b]);
    expect(player!.events).toEqual([]);
  });

  it("is not ready without a player", async () => {
    const { transport } = make(null);
    expect(await transport.hooks.prepare(cmd())).toBe(false);
  });

  it("says it cannot start when the song is not loaded, instead of starting alone", async () => {
    const { transport, player } = make();
    player!.ready = false;
    const play = transport.hooks.prepare(cmd());
    const settings = transport.hooks.prepare(cmd({ action: "settings" }));
    await vi.advanceTimersByTimeAsync(20);
    expect(await play).toBe(false);
    expect(await settings).toBe(true);
  });

  it("starts at the agreed instant, early by the output latency", async () => {
    const { transport, player } = make();
    player!.latency = 30;
    const at = performance.now() + 500;
    transport.hooks.schedule(cmd({ at }), at);
    await vi.advanceTimersByTimeAsync(600);
    const play = player!.events.find((e) => e.what === "play")!;
    expect(play.at).toBeCloseTo(at - 30, 0);
    expect(transport.startErrors).toHaveLength(1);
    expect(Math.abs(transport.startErrors[0]!)).toBeLessThan(2);
  });

  it("does not start twice if it is already playing", async () => {
    const { transport, player } = make();
    player!.playing = true;
    const at = performance.now() + 50;
    transport.hooks.schedule(cmd({ at }), at);
    await vi.advanceTimersByTimeAsync(100);
    expect(player!.events).toEqual([]);
  });

  it("pauses, stops and seeks on cue", async () => {
    const { transport, player } = make();
    player!.playing = true;
    const t = performance.now();
    transport.hooks.schedule(cmd({ action: "pause" }), t + 10);
    transport.hooks.schedule(cmd({ action: "stop" }), t + 20);
    transport.hooks.schedule(cmd({ action: "seek", tick: 960 }), t + 30);
    await vi.advanceTimersByTimeAsync(60);
    expect(player!.events.map((e) => e.what)).toEqual(["pause", "stop", "seek 960"]);
  });

  it("a start called off does not happen", async () => {
    const { transport, player } = make();
    const at = performance.now() + 100;
    const cancel = transport.hooks.schedule(cmd({ at }), at);
    cancel();
    await vi.advanceTimersByTimeAsync(200);
    expect(player!.events).toEqual([]);
  });

  it("settings commands schedule nothing", async () => {
    const { transport, player } = make();
    const cancel = transport.hooks.schedule(cmd({ action: "settings" }), performance.now() + 10);
    await vi.advanceTimersByTimeAsync(50);
    cancel();
    expect(player!.events).toEqual([]);
  });

  it("reports the position of the host's player", () => {
    const { transport, player } = make();
    player!.heard = 1234;
    player!.playing = true;
    expect(transport.hooks.position?.()).toEqual({ pos: 1234, playing: true });
    player!.heard = null;
    expect(transport.hooks.position?.()).toBeNull();
  });
});

describe("SharedTransport while the song plays", () => {
  const report = (transport: SharedTransport, player: FakePlayer, drift: number, times = 5) => {
    // The host was at 5000 ms when it reported; this player was `drift` ms ahead of that.
    player.playing = true;
    for (let i = 0; i < times; i += 1) {
      player.heard = 5000 + drift;
      transport.hooks.hostState?.(5000, performance.now(), true);
    }
  };
  const make = () => {
    const player = new FakePlayer();
    const drifts: number[] = [];
    const transport = new SharedTransport({
      player: () => player,
      applySettings: () => {},
      onDrift: (d) => drifts.push(d),
      spinMs: 0,
    });
    return { transport, player, drifts };
  };

  it("measures the drift for the dialog, and never changes the playback because of it", () => {
    for (const drift of [8, 60, -60, 500, -1200]) {
      const { transport, player, drifts } = make();
      report(transport, player, drift);
      expect(transport.hooks.driftMs?.()).toBe(drift);
      expect(drifts.at(-1)).toBe(drift);
      // No seek, no start or stop: the song plays on as it was started.
      expect(player.events).toEqual([]);
    }
  });

  it("does not use a speed correction at all", () => {
    const { transport, player } = make();
    report(transport, player, 800, 20);
    expect("nudgeSpeed" in player).toBe(false);
    expect(player.events).toEqual([]);
  });

  it("is not fooled by one odd reading in the measurement", () => {
    const { transport, player } = make();
    player.playing = true;
    for (const reading of [2, 1, 300, 3, 2]) {
      player.heard = 5000 + reading;
      transport.hooks.hostState?.(5000, performance.now(), true);
    }
    expect(Math.abs(transport.hooks.driftMs!())).toBeLessThan(5);
  });

  it("waits for a few readings before it says anything", () => {
    const { transport, player, drifts } = make();
    report(transport, player, 100, 2);
    expect(drifts).toEqual([]);
  });

  it("takes the time since the report into account", () => {
    const { transport, player } = make();
    player.playing = true;
    // The report is 200 ms old, so the player has moved on 200 ms: that is not drift.
    for (let i = 0; i < 4; i += 1) {
      player.heard = 5200;
      transport.hooks.hostState?.(5000, performance.now() - 200, true);
    }
    expect(transport.hooks.driftMs?.()).toBe(0);
  });

  it("starts measuring afresh after every start and while paused", async () => {
    const { transport, player } = make();
    report(transport, player, 100);
    expect(transport.hooks.driftMs?.()).toBe(100);
    player.playing = false;
    transport.hooks.hostState?.(5000, performance.now(), false);
    expect(transport.hooks.driftMs?.()).toBe(0);
    report(transport, player, 100);
    const at = performance.now() + 20;
    transport.hooks.schedule(cmd({ at }), at);
    await vi.advanceTimersByTimeAsync(50);
    expect(transport.hooks.driftMs?.()).toBe(0);
  });
});

describe("two players over a session", () => {
  it("start within a few milliseconds of each other, with a 10 ms wire and clocks 7 s apart", async () => {
    const pair = memoryPair({ up: 10, down: 10 });
    const shift = 7000;
    const hostPlayer = new FakePlayer(() => performance.now());
    const guestPlayer = new FakePlayer(() => performance.now() + shift);
    const hostT = new SharedTransport({
      player: () => hostPlayer,
      applySettings: () => {},
      settleMs: 5,
      spinMs: 0,
    });
    const guestT = new SharedTransport({
      player: () => guestPlayer,
      applySettings: () => {},
      settleMs: 5,
      spinMs: 0,
      now: () => performance.now() + shift,
    });
    const host = new Session({
      role: "host",
      transport: pair[0],
      name: "H",
      score: { key: "k", bars: 4 },
      hooks: hostT.hooks,
    });
    const guest = new Session({
      role: "guest",
      transport: pair[1],
      name: "G",
      score: { key: "k", bars: 4 },
      hooks: guestT.hooks,
      now: () => performance.now() + shift,
    });
    host.start();
    guest.start();
    openPair(pair);
    await vi.advanceTimersByTimeAsync(3000);
    expect(host.snapshot.phase).toBe("synchronized");

    const [result] = await Promise.all([
      host.command({
        action: "play",
        tick: 960,
        speed: 100,
        loop: null,
        metronome: false,
        countIn: false,
        countInBeats: 4,
      }),
      vi.advanceTimersByTimeAsync(1500),
    ]);
    expect(result).toBe("started");
    const h = hostPlayer.events.find((e) => e.what === "play")!;
    const g = guestPlayer.events.find((e) => e.what === "play")!;
    // Compare on the host's clock.
    expect(Math.abs(h.at - (g.at - shift))).toBeLessThan(3);
    expect(guestPlayer.tick).toBe(960);
  });
});
