import {
  createCursorHandler,
  scrollTarget,
  SCROLL_MARGIN,
  Delayer,
  MAX_LATENCY_MS,
  measureLatency,
  outputLatencyMs,
  readSyncOffset,
  resetSyncOffsetCache,
  storeSyncOffset,
  SYNC_OFFSET_STORAGE_KEY,
} from "@/lib/score/sync";

afterEach(() => {
  delete window.__smartBeatOutputLatencyMs;
  resetSyncOffsetCache();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("outputLatencyMs", () => {
  it("adds the output and base latency of the audio context, in milliseconds", () => {
    expect(outputLatencyMs({ outputLatency: 0.04, baseLatency: 0.01 })).toBeCloseTo(50);
  });

  it("is zero where the browser reports nothing (Safari)", () => {
    expect(outputLatencyMs({})).toBe(0);
    expect(outputLatencyMs(null)).toBe(0);
    expect(outputLatencyMs({ outputLatency: Number.NaN, baseLatency: undefined })).toBe(0);
  });

  it("adds the user's offset, and never goes below 0 or above the maximum", () => {
    expect(outputLatencyMs({ outputLatency: 0.02 }, 30)).toBeCloseTo(50);
    expect(outputLatencyMs({ outputLatency: 0.02 }, -100)).toBe(0);
    expect(outputLatencyMs({ outputLatency: 2 }, 0)).toBe(MAX_LATENCY_MS);
    expect(outputLatencyMs({}, Number.NaN)).toBe(0);
  });

  it("can be set from a test", () => {
    window.__smartBeatOutputLatencyMs = 150;
    expect(outputLatencyMs({ outputLatency: 0.5 })).toBe(150);
    expect(outputLatencyMs(null, 25)).toBe(175);
  });
});

describe("the sync offset", () => {
  it("starts at 0, is remembered and stays within its range", () => {
    expect(readSyncOffset()).toBe(0);
    storeSyncOffset(120.4);
    expect(readSyncOffset()).toBe(120);
    expect(localStorage.getItem(SYNC_OFFSET_STORAGE_KEY)).toBe("120");
    storeSyncOffset(9_999);
    expect(readSyncOffset()).toBe(500);
    storeSyncOffset(-9_999);
    expect(readSyncOffset()).toBe(-200);
    storeSyncOffset(Number.NaN);
    expect(readSyncOffset()).toBe(0);
  });

  it("reads what an earlier session stored, and ignores damaged values", () => {
    localStorage.setItem(SYNC_OFFSET_STORAGE_KEY, "80");
    expect(readSyncOffset()).toBe(80);
    resetSyncOffsetCache();
    localStorage.setItem(SYNC_OFFSET_STORAGE_KEY, "abc");
    expect(readSyncOffset()).toBe(0);
  });
});

describe("Delayer", () => {
  it("runs at once without a delay", () => {
    const task = vi.fn();
    new Delayer(() => 0).run(task);
    expect(task).toHaveBeenCalledOnce();
  });

  it("runs after the delay, in order", () => {
    vi.useFakeTimers();
    const order: number[] = [];
    const delayer = new Delayer(() => 150);

    delayer.run(() => order.push(1));
    vi.advanceTimersByTime(10);
    delayer.run(() => order.push(2));
    vi.advanceTimersByTime(139);
    expect(order).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(order).toEqual([1]);
    vi.advanceTimersByTime(10);
    expect(order).toEqual([1, 2]);
  });

  it("drops what is waiting, e.g. after a seek", () => {
    vi.useFakeTimers();
    const task = vi.fn();
    const delayer = new Delayer(() => 100);
    delayer.run(task);

    delayer.clear();
    vi.advanceTimersByTime(500);

    expect(task).not.toHaveBeenCalled();
  });

  it("asks for the delay each time", () => {
    vi.useFakeTimers();
    let delay = 100;
    const task = vi.fn();
    const delayer = new Delayer(() => delay);
    delayer.run(task);
    delay = 0;
    delayer.run(task);
    expect(task).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(100);
    expect(task).toHaveBeenCalledTimes(2);
  });
});

describe("the cursor handler", () => {
  const cursor = () => ({ setBounds: vi.fn(), transitionToX: vi.fn() });
  const bounds = {
    onNotesX: 40,
    barBounds: { masterBarBounds: { visualBounds: { x: 10, y: 20, w: 300, h: 80 } } },
  };

  it("places the bar and beat cursor after the delay", () => {
    vi.useFakeTimers();
    const handler = createCursorHandler(new Delayer(() => 120), true);
    const bar = cursor();
    const beat = cursor();

    handler.placeBarCursor(bar, bounds);
    handler.placeBeatCursor(beat, bounds, 35);
    expect(bar.setBounds).not.toHaveBeenCalled();
    expect(beat.setBounds).not.toHaveBeenCalled();

    vi.advanceTimersByTime(120);
    expect(bar.setBounds).toHaveBeenCalledWith(10, 20, 300, 80);
    expect(beat.transitionToX).toHaveBeenCalledWith(0, 35);
    expect(beat.setBounds).toHaveBeenCalledWith(35, 20, 1, 80);
  });

  it("animates to the next beat, or twice as far when the next beat is in another bar", () => {
    const handler = createCursorHandler(new Delayer(() => 0), true);
    const beat = cursor();

    handler.transitionBeatCursor(beat, bounds, 100, 160, 500, 0);
    expect(beat.transitionToX).toHaveBeenLastCalledWith(500, 160);
    handler.transitionBeatCursor(beat, bounds, 100, 160, 500, 1);
    expect(beat.transitionToX).toHaveBeenLastCalledWith(1_000, 220);
  });

  it("just places the cursor when animations are off", () => {
    const handler = createCursorHandler(new Delayer(() => 0), false);
    const beat = cursor();

    handler.transitionBeatCursor(beat, bounds, 100, 160, 500, 0);

    expect(beat.transitionToX).toHaveBeenCalledWith(0, 40);
    expect(beat.setBounds).toHaveBeenCalledWith(40, 20, 1, 80);
  });
});

describe("measureLatency", () => {
  it("reads the latency of a short-lived audio context and closes it", async () => {
    const close = vi.fn(() => Promise.resolve());
    class FakeContext {
      outputLatency = 0.03;
      baseLatency = 0.01;
      resume = vi.fn(() => Promise.resolve());
      close = close;
    }
    vi.stubGlobal("AudioContext", FakeContext);

    const info = await measureLatency();

    expect(info).toEqual({ outputLatency: 0.03, baseLatency: 0.01 });
    expect(close).toHaveBeenCalledOnce();
  });

  it("knows nothing where there is no audio", async () => {
    vi.stubGlobal("AudioContext", undefined);
    expect(await measureLatency()).toEqual({});
  });

  it("knows nothing when the audio context can't be created", async () => {
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          throw new Error("no audio");
        }
      },
    );
    expect(await measureLatency()).toEqual({});
  });
});

describe("scrollTarget", () => {
  const view = { scrollTop: 100, scrollLeft: 0, clientHeight: 400, clientWidth: 800 };

  it("leaves a visible bar alone", () => {
    expect(scrollTarget({ x: 0, y: 150, w: 200, h: 100 }, view, false)).toBeNull();
  });

  it("scrolls down or up to a bar out of view, with a margin", () => {
    expect(scrollTarget({ x: 0, y: 600, w: 200, h: 100 }, view, false)).toBe(600 - SCROLL_MARGIN);
    expect(scrollTarget({ x: 0, y: 20, w: 200, h: 100 }, view, false)).toBe(0);
  });

  it("scrolls sideways in the continuous layout", () => {
    expect(scrollTarget({ x: 900, y: 0, w: 200, h: 100 }, view, true)).toBe(900 - SCROLL_MARGIN);
  });
});

describe("createCursorHandler scrolling", () => {
  it("reports the bar the cursor moves into, after the delay", () => {
    vi.useFakeTimers();
    const onBar = vi.fn();
    const handler = createCursorHandler(new Delayer(() => 100), true, onBar);
    const bar = { x: 1, y: 2, w: 3, h: 4 };
    handler.placeBarCursor(
      { setBounds: vi.fn(), transitionToX: vi.fn() },
      { onNotesX: 0, barBounds: { masterBarBounds: { visualBounds: bar } } },
    );
    expect(onBar).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onBar).toHaveBeenCalledWith(bar);
    vi.useRealTimers();
  });
});
