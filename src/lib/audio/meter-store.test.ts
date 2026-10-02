import { act, renderHook } from "@testing-library/react";

import { createMeterStore, FALL, meterPosition, useMeter } from "@/lib/audio/meter-store";

describe("meter store", () => {
  it("falls back smoothly between peaks", () => {
    const store = createMeterStore();
    store.set({ tracks: [1, 0.5], master: 0.8, drums: [[0.4]], backing: 0.2 });
    store.set({ tracks: [0, 0.9], master: 0, drums: [[0]], backing: 0 });
    const m = store.get();
    expect(m.tracks).toEqual([FALL, 0.9]);
    expect(m.master).toBeCloseTo(0.8 * FALL);
    expect(m.drums![0]![0]).toBeCloseTo(0.4 * FALL);
    expect(m.backing).toBeCloseTo(0.2 * FALL);
    for (let i = 0; i < 100; i++) store.set({ tracks: [], master: 0 });
    expect(store.get().master).toBe(0);
  });

  it("re-renders only what reads a changed level", () => {
    const store = createMeterStore();
    const { result } = renderHook(() => useMeter((m) => m.tracks[1] ?? 0, store));
    expect(result.current).toBe(0);
    act(() => store.set({ tracks: [0.2, 0.7], master: 0 }));
    expect(result.current).toBe(0.7);
  });

  it("maps peaks onto a -60…0 dB scale", () => {
    expect(meterPosition(0)).toBe(0);
    expect(meterPosition(1)).toBe(1);
    expect(meterPosition(0.001)).toBeCloseTo(0);
    expect(meterPosition(0.1)).toBeCloseTo(2 / 3);
    expect(meterPosition(4)).toBe(1);
  });
});
