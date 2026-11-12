import { addStemsToTab, registerStemLaneTarget } from "@/lib/stems/lane-targets";

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
});
