import { afterEach, beforeEach } from "vitest";

import {
  COUNT_IN_SECONDS,
  createStemPlayer,
  MIN_LOOP_SECONDS,
  peaksOf,
  RENDER_DEBOUNCE_MS,
  songLength,
  START_LEAD_SECONDS,
  type StemPlayer,
} from "@/lib/stems/player";
import type { StemKindId } from "@/lib/tauri";
import { clipBytes, FakeAudioBackend, fakeSource } from "@/test/fake-stem-audio";

const KINDS: StemKindId[] = ["drums", "bass", "other"];

async function setup(seconds = 100) {
  const backend = new FakeAudioBackend();
  const source = fakeSource(seconds);
  const player = createStemPlayer({ kinds: KINDS, source, backend });
  await player.load();
  return { backend, source, player };
}

/** Lets the render promises settle while the debounce timer is faked. */
const settle = async () => {
  await vi.advanceTimersByTimeAsync(RENDER_DEBOUNCE_MS);
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("loading", () => {
  it("reads every stem and takes the longest as the song's length", async () => {
    const { player, source } = await setup(95);
    expect(source.readStem).toHaveBeenCalledTimes(3);
    expect(player.state.loaded).toBe(true);
    expect(player.state.duration).toBe(95);
    expect(player.peaks("bass", 8)).toHaveLength(8);
  });

  it("reports a stem that cannot be read", async () => {
    const backend = new FakeAudioBackend();
    const source = fakeSource(10);
    source.readStem.mockRejectedValueOnce(new Error("The stem is missing."));
    const player = createStemPlayer({ kinds: KINDS, source, backend });
    await player.load();
    expect(player.state.loaded).toBe(false);
    expect(player.state.error).toBe("The stem is missing.");
  });
});

describe("playing", () => {
  it("starts one voice per stem at its gain, and moves the position with the clock", async () => {
    const { player, backend } = await setup();
    player.setGains({ drums: 1, bass: 0, other: 0.5 });
    await player.play();
    expect(backend.resumed).toBe(1);
    expect(backend.live.map((v) => v.gain)).toEqual([1, 0, 0.5]);
    backend.advance(START_LEAD_SECONDS + 12.5);
    expect(player.position()).toBeCloseTo(12.5);
    player.pause();
    expect(backend.live).toHaveLength(0);
    expect(player.state.position).toBeCloseTo(12.5);
    backend.advance(30);
    expect(player.position()).toBeCloseTo(12.5);
  });

  it("changes the gain of the playing voices at once, without a render", async () => {
    const { player, backend, source } = await setup();
    await player.play();
    player.setGains({ drums: 0, bass: 1, other: 1 });
    expect(backend.live.map((v) => v.gain)).toEqual([0, 1, 1]);
    await settle();
    expect(source.renders).toEqual([]);
  });

  it("resumes where it paused, and seeks while paused and while playing", async () => {
    const { player, backend } = await setup();
    player.seek(40);
    await player.play();
    expect(backend.live[0]!.offset).toBe(40);
    player.seek(10);
    expect(backend.live.every((v) => v.offset === 10)).toBe(true);
    expect(backend.live).toHaveLength(3);
    player.pause();
    player.seek(500);
    expect(player.state.position).toBe(100);
    player.seek(-3);
    expect(player.state.position).toBe(0);
  });

  it("goes back to the start when the song ends, then plays it again from there", async () => {
    const { player, backend } = await setup(20);
    await player.play();
    backend.advance(20);
    // The longest stem is the one that reports the end; all are 20 s here.
    backend.voices.find((v) => !v.stopped)!.end();
    backend.voices.forEach((v) => v.end());
    expect(player.state.playing).toBe(false);
    expect(player.state.position).toBe(0);
    await player.play();
    expect(backend.live[0]!.offset).toBe(0);
  });

  it("stops at the start of the loop, or of the song", async () => {
    const { player } = await setup();
    player.seek(30);
    player.stop();
    expect(player.state.position).toBe(0);
    player.setLoop({ start: 10, end: 20 });
    player.seek(15);
    player.stop();
    expect(player.state.position).toBe(10);
  });
});

describe("the A-B loop", () => {
  it("gives the voices the loop and wraps the position inside it", async () => {
    const { player, backend } = await setup();
    player.setLoop({ start: 10, end: 20 });
    player.seek(12);
    await player.play();
    expect(backend.live[0]!.loop).toEqual({ start: 10, end: 20 });
    backend.advance(START_LEAD_SECONDS + 9); // 21 s: one second past B
    expect(player.position()).toBeCloseTo(11);
    backend.advance(11); // 42 s unwrapped, on a 10 s loop
    expect(player.position()).toBeCloseTo(12);
  });

  it("plays up to the loop first when it starts before it", async () => {
    const { player, backend } = await setup();
    player.setLoop({ start: 10, end: 20 });
    player.seek(5);
    await player.play();
    backend.advance(START_LEAD_SECONDS + 4);
    expect(player.position()).toBeCloseTo(9);
    backend.advance(7); // 16 s of the song
    expect(player.position()).toBeCloseTo(16);
    backend.advance(5); // past B: back to A
    expect(player.position()).toBeCloseTo(11);
  });

  it("does not repeat a loop it started after", async () => {
    const { player, backend } = await setup();
    player.setLoop({ start: 10, end: 20 });
    player.seek(30);
    await player.play();
    expect(backend.live[0]!.loop).toBeNull();
    backend.advance(START_LEAD_SECONDS + 5);
    expect(player.position()).toBeCloseTo(35);
  });

  it("restarts the sound from where it is when the loop changes", async () => {
    const { player, backend } = await setup();
    await player.play();
    backend.advance(START_LEAD_SECONDS + 8);
    player.setLoop({ start: 5, end: 15 });
    expect(backend.live).toHaveLength(3);
    expect(backend.live[0]!.offset).toBeCloseTo(8);
    expect(backend.live[0]!.loop).toEqual({ start: 5, end: 15 });
    player.setLoop(null);
    expect(backend.live[0]!.loop).toBeNull();
    expect(player.state.loop).toBeNull();
  });

  it("puts the ends in order, keeps them inside the song and ignores a tiny loop", async () => {
    const { player } = await setup(60);
    player.setLoop({ start: 30, end: 10 });
    expect(player.state.loop).toEqual({ start: 10, end: 30 });
    player.setLoop({ start: 50, end: 90 });
    expect(player.state.loop).toEqual({ start: 50, end: 60 });
    player.setLoop({ start: 20, end: 20 + MIN_LOOP_SECONDS / 2 });
    expect(player.state.loop).toEqual({ start: 50, end: 60 });
  });
});

describe("the count-in", () => {
  it("counts down in silence, then plays", async () => {
    const { player, backend } = await setup();
    player.setCountIn(true);
    await player.play();
    expect(player.state.countdown).toBe(COUNT_IN_SECONDS);
    expect(backend.live).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1100);
    expect(player.state.countdown).toBe(COUNT_IN_SECONDS - 1);
    await vi.advanceTimersByTimeAsync(COUNT_IN_SECONDS * 1000);
    expect(player.state.countdown).toBeNull();
    expect(player.state.playing).toBe(true);
    expect(backend.live).toHaveLength(3);
  });

  it("is stopped by Pause, and does not start the song", async () => {
    const { player, backend } = await setup();
    player.setCountIn(true);
    await player.play();
    player.pause();
    expect(player.state.countdown).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(backend.live).toHaveLength(0);
    expect(player.state.playing).toBe(false);
  });

  it("is skipped when it is off", async () => {
    const { player, backend } = await setup();
    await player.play();
    expect(player.state.countdown).toBeNull();
    expect(backend.live).toHaveLength(3);
  });
});

describe("a slower speed", () => {
  it("renders the mix with the gains, plays it, and keeps the position in song seconds", async () => {
    const { player, backend, source } = await setup(100);
    player.setGains({ drums: 1, bass: 0, other: 1 });
    await player.play();
    backend.advance(START_LEAD_SECONDS + 10);
    player.setSpeed(50);
    expect(player.state.rendering).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(source.renders).toEqual([{ gains: { drums: 1, bass: 0, other: 1 }, speed: 0.5 }]);
    expect(player.state.rendering).toBe(false);
    // One voice now, from 10 s of the song = 20 s into a mix twice as long.
    expect(backend.live).toHaveLength(1);
    expect(backend.live[0]!.offset).toBeCloseTo(20);
    backend.advance(START_LEAD_SECONDS + 10); // 10 s of the clock = 5 s of the song at half speed
    expect(player.position()).toBeCloseTo(15);
  });

  it("scales the loop into the slowed mix", async () => {
    const { player, backend } = await setup(100);
    player.setLoop({ start: 10, end: 20 });
    player.seek(12);
    player.setSpeed(50);
    await vi.advanceTimersByTimeAsync(0);
    await player.play();
    expect(backend.live[0]!.loop).toEqual({ start: 20, end: 40 });
    backend.advance(START_LEAD_SECONDS + 40); // 20 s of the song after 12 s: wrapped
    expect(player.position()).toBeCloseTo(12);
  });

  it("keeps playing the old sound while the new mix renders", async () => {
    const { player, backend, source } = await setup(100);
    await player.play();
    let release!: () => void;
    source.renderMix.mockImplementationOnce(
      (_gains, speed) =>
        new Promise((resolve) => {
          release = () => resolve(clipBytes(100 / speed));
        }),
    );
    player.setSpeed(80);
    expect(player.state.rendering).toBe(true);
    expect(backend.live).toHaveLength(3);
    backend.advance(START_LEAD_SECONDS + 5);
    expect(player.position()).toBeCloseTo(5);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(player.state.rendering).toBe(false);
  });

  it("renders again after mute, solo or volume, once the changes pause for 250 ms", async () => {
    const { player, backend, source } = await setup(100);
    player.setSpeed(80);
    await vi.advanceTimersByTimeAsync(0);
    expect(source.renders).toHaveLength(1);
    player.setGains({ drums: 0, bass: 1, other: 1 });
    await vi.advanceTimersByTimeAsync(100);
    player.setGains({ drums: 0, bass: 0.5, other: 1 });
    expect(player.state.rendering).toBe(true);
    await vi.advanceTimersByTimeAsync(RENDER_DEBOUNCE_MS - 1);
    expect(source.renders).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(source.renders).toHaveLength(2);
    expect(source.renders[1]!.gains).toEqual({ drums: 0, bass: 0.5, other: 1 });
    expect(player.state.rendering).toBe(false);
    expect(backend.live).toHaveLength(0); // paused all along
  });

  it("does not render for a change that comes back to the gains already rendered", async () => {
    const { player, source } = await setup(100);
    player.setGains({ drums: 1, bass: 1, other: 1 });
    player.setSpeed(70);
    await vi.advanceTimersByTimeAsync(0);
    player.setGains({ drums: 0, bass: 1, other: 1 });
    player.setGains({ drums: 1, bass: 1, other: 1 });
    expect(player.state.rendering).toBe(false);
    await settle();
    expect(source.renders).toHaveLength(1);
  });

  it("goes back to the stems at 100 % and ignores a render that is still running", async () => {
    const { player, backend, source } = await setup(100);
    await player.play();
    let release!: () => void;
    source.renderMix.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(clipBytes(200)))),
    );
    player.setSpeed(50);
    player.setSpeed(100);
    expect(player.state.rendering).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.live).toHaveLength(3);
    expect(player.state.speed).toBe(100);
  });

  it("falls back to the speed it had when the render fails", async () => {
    const { player, source } = await setup(100);
    source.failRender = "Not enough memory to slow this song down.";
    player.setSpeed(60);
    await vi.advanceTimersByTimeAsync(0);
    expect(player.state.speed).toBe(100);
    expect(player.state.rendering).toBe(false);
    expect(player.state.error).toBe("Not enough memory to slow this song down.");
  });

  it("only accepts the offered speeds", async () => {
    const { player, source } = await setup(100);
    player.setSpeed(75);
    await vi.advanceTimersByTimeAsync(0);
    expect(player.state.speed).toBe(100);
    expect(source.renders).toEqual([]);
  });
});

describe("state and cleanup", () => {
  it("tells subscribers about every change, with a new state object", async () => {
    const { player } = await setup();
    const seen: unknown[] = [];
    const stop = player.subscribe(() => seen.push(player.state));
    player.setCountIn(true);
    player.seek(3);
    stop();
    player.setCountIn(false);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("stops the sound and closes the audio when it is disposed", async () => {
    const { player, backend } = await setup();
    await player.play();
    player.dispose();
    expect(backend.live).toHaveLength(0);
    expect(backend.closed).toBe(true);
    // Nothing happens after it, and disposing twice is fine.
    await expect((player as StemPlayer).play()).resolves.toBeUndefined();
    player.dispose();
  });
});

describe("peaksOf", () => {
  it("takes the loudest sample of each part, across channels", () => {
    const left = new Float32Array([0, 0.5, 0, 0, 0, 0, 0, 0]);
    const right = new Float32Array([0, 0, 0, 0, 0, -0.75, 0, 0]);
    expect(peaksOf([left, right], 4)).toEqual([0.5, 0, 0.75, 0]);
  });

  it("is flat for silence, and empty input gives zeros", () => {
    expect(peaksOf([new Float32Array(100)], 5)).toEqual([0, 0, 0, 0, 0]);
    expect(peaksOf([], 3)).toEqual([0, 0, 0]);
  });
});

describe("songLength", () => {
  it("takes the saved length when the decoded audio is a few milliseconds short", () => {
    expect(songLength(5.99, 6)).toBe(6);
    expect(songLength(6.004, 6)).toBe(6);
  });

  it("keeps the decoded length without a saved one or when they are far apart", () => {
    expect(songLength(5.99)).toBe(5.99);
    expect(songLength(5.99, 0)).toBe(5.99);
    expect(songLength(5.99, Number.NaN)).toBe(5.99);
    expect(songLength(3, 6)).toBe(3);
  });
});

describe("one start for every stem", () => {
  it("gives every stem the same moment on the audio clock, a little ahead of now", async () => {
    const { player, backend } = await setup();
    backend.advance(7);
    await player.play();
    expect(backend.live).toHaveLength(3);
    for (const voice of backend.live) expect(voice.when).toBeCloseTo(7 + START_LEAD_SECONDS);
    // The position counts from that moment: it does not move while the sound has not begun.
    expect(player.position()).toBe(0);
    backend.advance(START_LEAD_SECONDS / 2);
    expect(player.position()).toBe(0);
  });

  it("gives a seek, a loop change and a switch to a slower mix one moment each", async () => {
    const { player, backend } = await setup();
    await player.play();
    backend.advance(2);
    player.seek(30);
    const whens = new Set(backend.live.map((voice) => voice.when));
    expect(whens.size).toBe(1);
    expect([...whens][0]).toBeCloseTo(2 + START_LEAD_SECONDS);
  });
});

describe("renders that are still running", () => {
  it("runs one at a time and keeps only the newest request that waits", async () => {
    const { player, backend, source } = await setup(100);
    let running = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    source.renderMix.mockImplementation((_gains, speed) => {
      running++;
      peak = Math.max(peak, running);
      source.renders.push({ gains: _gains, speed });
      return new Promise((resolve) => {
        releases.push(() => {
          running--;
          resolve(clipBytes(100 / speed));
        });
      });
    });
    player.setSpeed(90);
    player.setSpeed(80);
    player.setSpeed(70);
    player.setSpeed(60);
    await vi.advanceTimersByTimeAsync(0);
    // Only the first went to Rust; the others wait behind it.
    expect(source.renders.map((r) => r.speed)).toEqual([0.9]);

    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    // The superseded render was not even decoded; the newest request runs next.
    expect(backend.decode).toHaveBeenCalledTimes(KINDS.length); // only the stems, from loading
    expect(source.renders.map((r) => r.speed)).toEqual([0.9, 0.6]);
    expect(player.state.rendering).toBe(true);

    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(player.state.rendering).toBe(false);
    expect(peak).toBe(1);
    expect(source.renders).toHaveLength(2);
    expect(backend.decode).toHaveBeenCalledTimes(KINDS.length + 1);
  });

  it("does not start another render when the speed went back to 100 % meanwhile", async () => {
    const { player, source } = await setup(100);
    const releases: (() => void)[] = [];
    source.renderMix.mockImplementation((_gains, speed) => {
      source.renders.push({ gains: _gains, speed });
      return new Promise((resolve) => releases.push(() => resolve(clipBytes(100 / speed))));
    });
    player.setSpeed(80);
    player.setSpeed(70);
    player.setSpeed(100);
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(source.renders).toHaveLength(1);
    expect(player.state.rendering).toBe(false);
  });
});

describe("Stop and Pause while the audio wakes up", () => {
  const withGate = async () => {
    const setupResult = await setup();
    let open!: () => void;
    setupResult.backend.resumeGate = new Promise<void>((resolve) => (open = resolve));
    return { ...setupResult, open };
  };

  it("does not play after Stop was pressed", async () => {
    const { player, backend, open } = await withGate();
    const playing = player.play();
    player.stop();
    open();
    await playing;
    expect(player.state.playing).toBe(false);
    expect(backend.live).toHaveLength(0);
  });

  it("does not play after Pause was pressed", async () => {
    const { player, backend, open } = await withGate();
    const playing = player.play();
    player.pause();
    open();
    await playing;
    expect(player.state.playing).toBe(false);
    expect(backend.live).toHaveLength(0);
  });

  it("does not start the count-in after Stop either", async () => {
    const { player, backend, open } = await withGate();
    player.setCountIn(true);
    const playing = player.play();
    player.stop();
    open();
    await playing;
    expect(player.state.countdown).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(backend.live).toHaveLength(0);
  });

  it("ignores a second Play while the first waits, and plays once", async () => {
    const { player, backend, open } = await withGate();
    const first = player.play();
    const second = player.play();
    open();
    await Promise.all([first, second]);
    expect(backend.resumed).toBe(1);
    expect(backend.live).toHaveLength(3);
  });

  it("can play again after a Stop that ended a waiting Play", async () => {
    const { player, backend, open } = await withGate();
    const first = player.play();
    player.stop();
    open();
    await first;
    backend.resumeGate = null;
    await player.play();
    expect(player.state.playing).toBe(true);
    expect(backend.live).toHaveLength(3);
  });
});
