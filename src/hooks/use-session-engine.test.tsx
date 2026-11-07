import { renderHook } from "@testing-library/react";
import { toast } from "sonner";

import { useSessionEngine } from "@/hooks/use-session-engine";
import type { AudioEngineKind } from "@/lib/score/player";

vi.mock(import("sonner"), async (importOriginal) => ({
  ...(await importOriginal()),
  toast: Object.assign(vi.fn(), { info: vi.fn() }) as never,
}));

function setup(initial: AudioEngineKind) {
  const setEngine = vi.fn();
  const hook = renderHook(
    ({ on, engine }: { on: boolean; engine: AudioEngineKind }) =>
      useSessionEngine(on, engine, setEngine),
    { initialProps: { on: false, engine: initial } },
  );
  return { setEngine, ...hook };
}

describe("useSessionEngine", () => {
  beforeEach(() => vi.mocked(toast.info).mockClear());

  it("switches the native engine to the SoundFonts for the session, and back after", () => {
    const { setEngine, rerender } = setup("native");
    rerender({ on: true, engine: "native" });
    expect(setEngine).toHaveBeenLastCalledWith("alphatab");
    expect(toast.info).toHaveBeenCalledOnce();
    // The app follows: the engine is now the SoundFonts, and stays so while the session lasts.
    rerender({ on: true, engine: "alphatab" });
    expect(setEngine).toHaveBeenCalledTimes(1);
    rerender({ on: false, engine: "alphatab" });
    expect(setEngine).toHaveBeenLastCalledWith("native");
    expect(setEngine).toHaveBeenCalledTimes(2);
    rerender({ on: false, engine: "native" });
    expect(setEngine).toHaveBeenCalledTimes(2);
  });

  it("changes nothing when the SoundFonts play anyway", () => {
    const { setEngine, rerender } = setup("alphatab");
    rerender({ on: true, engine: "alphatab" });
    rerender({ on: false, engine: "alphatab" });
    expect(setEngine).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("puts the native engine back again when the player chose it during the session", () => {
    const { setEngine, rerender } = setup("alphatab");
    rerender({ on: true, engine: "native" });
    expect(setEngine).toHaveBeenLastCalledWith("alphatab");
    rerender({ on: true, engine: "alphatab" });
    rerender({ on: false, engine: "alphatab" });
    expect(setEngine).toHaveBeenLastCalledWith("native");
  });
});
