import { addStemsToTab, addStemsWhenOpen, registerStemLaneTarget } from "@/lib/stems/lane-targets";

describe("stem lane targets", () => {
  it("calls the handler of the tab with the song and the stems", () => {
    const handler = vi.fn();
    const stop = registerStemLaneTarget(7, handler);
    const items = [{ kind: "drums" as const, info: {} as never }];
    addStemsToTab(7, { engine: "htdemucs" }, items);
    expect(handler).toHaveBeenCalledWith({ engine: "htdemucs" }, items);
    stop();
  });

  it("says so when the tab is not open, or was closed", () => {
    expect(() => addStemsToTab(99, { engine: "fast" }, [])).toThrow("not open any more");
    const stop = registerStemLaneTarget(8, vi.fn());
    stop();
    expect(() => addStemsToTab(8, { engine: "fast" }, [])).toThrow("not open any more");
  });

  it("lets what the handler throws reach the caller", () => {
    const stop = registerStemLaneTarget(9, () => {
      throw new Error("No room");
    });
    expect(() => addStemsToTab(9, { engine: "fast" }, [])).toThrow("No room");
    stop();
  });

  it("does not let an old registration remove a newer one", () => {
    const first = registerStemLaneTarget(10, vi.fn());
    const second = vi.fn();
    const stop = registerStemLaneTarget(10, second);
    first();
    addStemsToTab(10, { engine: "fast" }, []);
    expect(second).toHaveBeenCalled();
    stop();
  });

  it("adds stems for a tab that is still opening as soon as it registers, once", () => {
    const items = [{ kind: "bass" as const, info: {} as never }];
    addStemsWhenOpen(21, { engine: "fast" }, items);
    const handler = vi.fn();
    const stop = registerStemLaneTarget(21, handler);
    expect(handler).toHaveBeenCalledExactlyOnceWith({ engine: "fast" }, items);
    stop();
    // The same tab registering again (a re-render) gets nothing more.
    const again = vi.fn();
    const stopAgain = registerStemLaneTarget(21, again);
    expect(again).not.toHaveBeenCalled();
    stopAgain();
  });

  it("adds stems at once to a tab that is open already", () => {
    const handler = vi.fn();
    const stop = registerStemLaneTarget(22, handler);
    addStemsWhenOpen(22, { engine: "fast" }, []);
    expect(handler).toHaveBeenCalledOnce();
    stop();
  });
});
