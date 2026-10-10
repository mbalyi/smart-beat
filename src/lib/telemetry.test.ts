import { getUsageSettings, setUsageSettings, track } from "@/lib/telemetry";
import { mockTauri } from "@/test/tauri";

const tracked = (calls: ReturnType<typeof mockTauri>) =>
  calls.filter((call) => call.cmd === "track_event").map((call) => call.args);

describe("track", () => {
  it("does nothing in a browser", () => {
    expect(() => track("loop_on")).not.toThrow();
  });

  it("sends the event name and nothing else", () => {
    const calls = mockTauri();
    track("loop_on");
    expect(tracked(calls)).toEqual([{ event: "loop_on", format: null }]);
  });

  it("sends a known file format in lower case", () => {
    const calls = mockTauri();
    track("export", "PDF");
    track("open_file", "gp5");
    expect(tracked(calls)).toEqual([
      { event: "export", format: "pdf" },
      { event: "open_file", format: "gp5" },
    ]);
  });

  it("counts the event without a format the core would refuse", () => {
    const calls = mockTauri();
    track("export", "alphatex");
    track("open_file", "my song.gp5");
    expect(tracked(calls)).toEqual([
      { event: "export", format: null },
      { event: "open_file", format: null },
    ]);
  });

  it("never throws or rejects when the core fails", async () => {
    mockTauri({
      track_event: () => {
        throw { kind: "io", message: "disk on fire" };
      },
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    track("play");
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("usage settings", () => {
  it("are absent in a browser", async () => {
    expect(await getUsageSettings()).toBeNull();
  });

  it("are read from and written to the core", async () => {
    const calls = mockTauri();
    expect(await getUsageSettings()).toEqual({ enabled: true, available: false, noticeSeen: true });
    expect(await setUsageSettings({ enabled: false })).toMatchObject({ enabled: false });
    expect(calls.find((c) => c.cmd === "set_usage_settings")?.args).toEqual({
      enabled: false,
      noticeSeen: null,
    });
    expect(await setUsageSettings({ noticeSeen: false })).toEqual({
      enabled: false,
      available: false,
      noticeSeen: false,
    });
  });
});
