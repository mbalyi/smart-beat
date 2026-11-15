import { invoke } from "@/lib/invoke";
import { isValidFrame } from "@/lib/scrub-stack";
import { mockTauri } from "@/test/tauri";

const counted = (calls: ReturnType<typeof mockTauri>) =>
  calls.filter((call) => call.cmd === "track_event").map((call) => call.args);

/** What the core was asked to record for a failure: the counter and its anonymised trace. */
type ErrorCall = { event: string; format: string; trace?: { frames: string[]; ext?: string } };

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("invoke", () => {
  it("returns the result of a command and counts nothing", async () => {
    const calls = mockTauri({ audio_state: () => ({ ok: true }) });
    expect(await invoke("audio_state")).toEqual({ ok: true });
    await settle();
    expect(counted(calls)).toEqual([]);
  });

  it("counts a failed command by area and kind, with a trace, and rethrows the same rejection", async () => {
    const rejection = { kind: "audio", message: "No output device at /Users/jane/Songs" };
    const calls = mockTauri({
      audio_start: () => {
        throw rejection;
      },
    });
    await expect(invoke("audio_start")).rejects.toBe(rejection);
    await settle();
    const [call, ...others] = counted(calls) as ErrorCall[];
    expect(others).toEqual([]);
    expect(call).toMatchObject({ event: "error", format: "audio:audio" });
    // The command name comes first; without an origin the rest are call sites in this app.
    expect(call?.trace?.frames[0]).toBe("audio_start");
    expect(call?.trace?.ext).toBeUndefined();
  });

  it("sends the Rust origin as the second frame and the call sites after it", async () => {
    const calls = mockTauri({
      audio_start: () => {
        throw { kind: "audio", message: "x", origin: "src/audio/mod.rs:123" };
      },
    });
    await expect(invoke("audio_start")).rejects.toBeTruthy();
    await settle();
    const [call] = counted(calls) as ErrorCall[];
    expect(call?.trace?.frames.slice(0, 2)).toEqual(["audio_start", "src/audio/mod.rs:123"]);
    expect(call?.trace?.frames.length).toBeLessThanOrEqual(7);
    // Every frame is one the validator accepts; none is the counter's own call site.
    for (const frame of call?.trace?.frames ?? []) expect(isValidFrame(frame)).toBe(true);
    expect(JSON.stringify(call?.trace)).not.toMatch(/countFailure/);
  });

  it("drops an origin that is not an app-relative location", async () => {
    for (const origin of ["/Users/jane/Projects/x.rs:12", "a@b.c", "src/../x.rs:1"]) {
      const calls = mockTauri({
        audio_start: () => {
          throw { kind: "audio", message: "x", origin };
        },
      });
      await expect(invoke("audio_start")).rejects.toBeTruthy();
      await settle();
      const [call] = counted(calls) as ErrorCall[];
      expect(call?.trace?.frames).not.toContain(origin);
      expect(call?.trace?.frames[0]).toBe("audio_start");
    }
  });

  it("never sends the message, the file name or the path of a failure", async () => {
    const calls = mockTauri({
      read_score_file: () => {
        throw {
          kind: "not-found",
          message: "/Users/jane/My Secret Song.gp5 could not be found (jane@example.com)",
          origin: "src/files.rs:45",
        };
      },
    });
    await expect(
      invoke("read_score_file", { path: "/Users/jane/My Secret Song.gp5" }),
    ).rejects.toBeTruthy();
    await settle();
    const [call] = counted(calls) as ErrorCall[];
    expect(call).toMatchObject({ event: "error", format: "file:not-found" });
    expect(call?.trace?.frames.slice(0, 2)).toEqual(["read_score_file", "src/files.rs:45"]);
    // Only the extension of the file, from the known formats.
    expect(call?.trace?.ext).toBe("gp5");
    const sent = JSON.stringify(counted(calls));
    expect(sent).not.toMatch(/jane|Secret|Song|example|could not be found|\/Users|Users/);
    expect(Object.keys(call as object).sort()).toEqual(["event", "format", "trace"]);
  });

  it("files an extension that is not a known format as other", async () => {
    const calls = mockTauri({
      read_score_file: () => {
        throw { kind: "not-found", message: "x" };
      },
    });
    await expect(
      invoke("read_score_file", { path: "/Users/jane/notes.jane" }),
    ).rejects.toBeTruthy();
    await settle();
    const [call] = counted(calls) as ErrorCall[];
    expect(call?.trace?.ext).toBe("other");
    expect(JSON.stringify(call)).not.toMatch(/jane|notes/);
  });

  it("sends no extension for a command without a path argument", async () => {
    const calls = mockTauri({
      stems_list: () => {
        throw { kind: "io", message: "x" };
      },
    });
    await expect(invoke("stems_list", { name: "My Secret Song.gp5" })).rejects.toBeTruthy();
    await settle();
    const [call] = counted(calls) as ErrorCall[];
    expect(call?.trace?.ext).toBeUndefined();
    expect(JSON.stringify(call)).not.toMatch(/Secret|gp5/);
  });

  it("counts a rejection without a kind as unknown", async () => {
    const calls = mockTauri({
      export_pdf: () => {
        throw new Error("boom");
      },
    });
    await expect(invoke("export_pdf")).rejects.toThrow("boom");
    await settle();
    const [call] = counted(calls) as ErrorCall[];
    expect(call).toMatchObject({ event: "error", format: "export:unknown" });
    expect(call?.trace?.frames[0]).toBe("export_pdf");
    // The message of a plain Error is never read.
    expect(JSON.stringify(call)).not.toMatch(/boom/);
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
