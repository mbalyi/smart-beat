import { invoke } from "@/lib/invoke";
import { mockTauri } from "@/test/tauri";

const counted = (calls: ReturnType<typeof mockTauri>) =>
  calls.filter((call) => call.cmd === "track_event").map((call) => call.args);

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("invoke", () => {
  it("returns the result of a command and counts nothing", async () => {
    const calls = mockTauri({ audio_state: () => ({ ok: true }) });
    expect(await invoke("audio_state")).toEqual({ ok: true });
    await settle();
    expect(counted(calls)).toEqual([]);
  });

  it("counts a failed command by area and kind, and rethrows the same rejection", async () => {
    const rejection = { kind: "audio", message: "No output device at /Users/jane/Songs" };
    const calls = mockTauri({
      audio_start: () => {
        throw rejection;
      },
    });
    await expect(invoke("audio_start")).rejects.toBe(rejection);
    await settle();
    expect(counted(calls)).toEqual([{ event: "error", format: "audio:audio" }]);
  });

  it("never sends the message, the command name or the arguments", async () => {
    const calls = mockTauri({
      read_score_file: () => {
        throw { kind: "not-found", message: "/Users/jane/My Secret Song.gp5 could not be found" };
      },
    });
    await expect(
      invoke("read_score_file", { path: "/Users/jane/My Secret Song.gp5" }),
    ).rejects.toBeTruthy();
    await settle();
    const sent = JSON.stringify(counted(calls));
    expect(sent).toBe('[{"event":"error","format":"file:not-found"}]');
    expect(sent).not.toMatch(/jane|Secret|read_score_file/);
  });

  it("counts a rejection without a kind as unknown", async () => {
    const calls = mockTauri({
      export_pdf: () => {
        throw new Error("boom");
      },
    });
    await expect(invoke("export_pdf")).rejects.toThrow("boom");
    await settle();
    expect(counted(calls)).toEqual([{ event: "error", format: "export:unknown" }]);
  });

  it("keeps the original rejection when counting itself fails", async () => {
    const rejection = { kind: "io", message: "disk on fire" };
    const calls = mockTauri({
      stems_list: () => {
        throw rejection;
      },
      track_event: () => {
        throw { kind: "io", message: "counter on fire" };
      },
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    await expect(invoke("stems_list")).rejects.toBe(rejection);
    await settle();
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    // One attempt, not a loop: the failed counter does not count itself.
    expect(counted(calls)).toHaveLength(1);
  });

  it("does not count a failing usage command", async () => {
    const calls = mockTauri({
      get_usage_settings: () => {
        throw { kind: "io", message: "x" };
      },
    });
    await expect(invoke("get_usage_settings")).rejects.toBeTruthy();
    await settle();
    expect(counted(calls)).toEqual([]);
  });

  it("counts nothing outside the desktop app", async () => {
    await expect(invoke("audio_start")).rejects.toBeTruthy();
    await settle();
  });
});
