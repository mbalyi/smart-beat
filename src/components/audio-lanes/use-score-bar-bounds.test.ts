import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useScoreBarBounds } from "@/components/audio-lanes/use-score-bar-bounds";
import type { BarSpan } from "@/lib/audio-lanes/bar-bounds";
import type { ScorePlayer } from "@/lib/score/player";

/** A player that draws `spans` and tells its listeners when it draws again. */
function fakePlayer(initial: BarSpan[] | null) {
  let spans = initial;
  const listeners = new Set<() => void>();
  const player = {
    barBounds: () => spans,
    onLayoutChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ScorePlayer;
  return {
    ref: { current: player },
    redraw(next: BarSpan[] | null) {
      spans = next;
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

const first: BarSpan[] = [
  { x: 40, width: 100 },
  { x: 140, width: 300 },
];

describe("useScoreBarBounds", () => {
  it("reads the bars at once and again after every draw", () => {
    const player = fakePlayer(first);
    const { result } = renderHook(() => useScoreBarBounds(player.ref, 1, true));
    expect(result.current).toEqual(first);
    const moved = [{ x: 40, width: 120 }, ...first.slice(1)];
    act(() => player.redraw(moved));
    expect(result.current).toEqual(moved);
  });

  it("keeps the same spans when a draw moved nothing", () => {
    const player = fakePlayer(first);
    const { result } = renderHook(() => useScoreBarBounds(player.ref, 1, true));
    const before = result.current;
    act(() => player.redraw(first.map((s) => ({ ...s }))));
    expect(result.current).toBe(before);
  });

  it("is null before the first draw, and while it is switched off", () => {
    const player = fakePlayer(null);
    const { result, rerender } = renderHook(
      ({ enabled }) => useScoreBarBounds(player.ref, 1, enabled),
      { initialProps: { enabled: true } },
    );
    expect(result.current).toBeNull();
    act(() => player.redraw(first));
    expect(result.current).toEqual(first);
    rerender({ enabled: false });
    expect(result.current).toBeNull();
    expect(player.listeners.size).toBe(0);
  });

  it("stops listening when it unmounts", () => {
    const player = fakePlayer(first);
    const { unmount } = renderHook(() => useScoreBarBounds(player.ref, 1, true));
    expect(player.listeners.size).toBe(1);
    unmount();
    expect(player.listeners.size).toBe(0);
  });
});
