import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HANDOFF_TTL_MS, clearHandoff, putHandoff, takeHandoff, type Handoff } from "./handoff";
import { memoryPair } from "./transport";

const make = (key = "k"): Handoff => ({
  transport: memoryPair()[0],
  session: "s",
  peerName: "Host",
  key,
  quality: "auto",
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  clearHandoff();
  vi.useRealTimers();
});

describe("handing the connection to the next tab", () => {
  it("gives it to the tab with the matching key, once", () => {
    const handoff = make();
    putHandoff(handoff);
    expect(takeHandoff("other")).toBeNull();
    expect(takeHandoff("k")).toBe(handoff);
    expect(takeHandoff("k")).toBeNull();
  });

  it("closes a connection nobody takes", () => {
    const handoff = make();
    const close = vi.spyOn(handoff.transport, "close");
    putHandoff(handoff);
    vi.advanceTimersByTime(HANDOFF_TTL_MS + 1);
    expect(close).toHaveBeenCalledOnce();
    expect(takeHandoff("k")).toBeNull();
  });

  it("keeps only the latest", () => {
    const first = make("a");
    const second = make("b");
    putHandoff(first);
    putHandoff(second);
    expect(takeHandoff("a")).toBeNull();
    expect(takeHandoff("b")).toBe(second);
  });

  it("does not close a connection that was taken", () => {
    const handoff = make();
    const close = vi.spyOn(handoff.transport, "close");
    putHandoff(handoff);
    takeHandoff("k");
    vi.advanceTimersByTime(HANDOFF_TTL_MS + 1);
    expect(close).not.toHaveBeenCalled();
  });
});
