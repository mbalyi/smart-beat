import { act, renderHook } from "@testing-library/react";

import { PlayheadStore, usePlayheadBar } from "@/lib/score/playhead";

describe("PlayheadStore", () => {
  it("tells its listeners when the position moves, not when it stays", () => {
    const store = new PlayheadStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set(1.5);
    store.set(1.5);
    expect(store.get()).toBe(1.5);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.set(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("redraws a component that reads it", () => {
    const store = new PlayheadStore();
    const { result } = renderHook(() => usePlayheadBar(store));
    expect(result.current).toBe(0);
    act(() => store.set(3.25));
    expect(result.current).toBe(3.25);
  });
});
