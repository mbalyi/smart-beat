import { readFileSync } from "node:fs";

import {
  ERROR_AREAS,
  ERROR_DETAILS,
  ERROR_KINDS,
  areaOf,
  errorDetail,
  kindOf,
} from "@/lib/error-counters";

/** The command names registered in the Rust core (`generate_handler!` in lib.rs). */
function registeredCommands(): string[] {
  const source = readFileSync("src-tauri/src/lib.rs", "utf8");
  const block = /generate_handler!\[([\s\S]*?)\]/.exec(source)?.[1] ?? "";
  return [...block.matchAll(/(?:\w+::)*(\w+),/g)].map((match) => match[1] ?? "");
}

describe("error counter categories", () => {
  it("has the lists the core and the Worker have, as one area:kind product", () => {
    expect(ERROR_AREAS).toHaveLength(10);
    expect(ERROR_KINDS).toHaveLength(14);
    expect(ERROR_DETAILS).toHaveLength(140);
    expect(new Set(ERROR_DETAILS).size).toBe(140);
    const rust = readFileSync("src-tauri/src/telemetry.rs", "utf8");
    const listed = (name: string) => {
      const body = new RegExp(`pub const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\]`).exec(rust);
      expect(body, name).not.toBeNull();
      return [...(body?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
    };
    expect(listed("ERROR_AREAS")).toEqual([...ERROR_AREAS]);
    expect(listed("ERROR_KINDS")).toEqual([...ERROR_KINDS]);
  });

  it("files commands under their area", () => {
    const cases: Record<string, string> = {
      audio_start: "audio",
      audio_set_chain: "audio",
      library_import: "audio",
      soundfonts_download: "audio",
      kits_import: "audio",
      plugins_scan: "plugin",
      plugin_open_editor: "plugin",
      audio_plugin_info: "plugin",
      export_pdf: "export",
      export_m4a: "export",
      cloud_connect: "cloud",
      cloud_list_stems: "cloud",
      list_cloud_scores: "cloud",
      get_cloud_folder: "cloud",
      stems_cloud_save: "cloud",
      stems_separate: "stems",
      umx_model_download: "stems",
      stem_model_status: "stems",
      transcribe_audio: "import",
      read_transcription_audio: "import",
      transcribe_recording: "ai",
      download_muscriptor_model: "ai",
      muscriptor_status: "ai",
      piano_model_status: "ai",
      download_piano_model: "ai",
      read_score_file: "file",
      write_score_file: "file",
      add_recent_file: "file",
      take_pending_open_files: "file",
      load_mixer_settings: "settings",
      write_project_settings: "settings",
      update_menu_state: "settings",
      something_new: "other",
      "": "other",
    };
    for (const [command, area] of Object.entries(cases)) {
      expect(areaOf(command), command).toBe(area);
    }
  });

  it("files every command of the core under a known area, and the common ones not under other", () => {
    const commands = registeredCommands();
    expect(commands.length).toBeGreaterThan(100);
    // The counters themselves are never counted; every other command has an area of its own.
    const unfiled = commands.filter(
      (command) => areaOf(command) === "other" && errorDetail(command, null) !== null,
    );
    expect(unfiled.sort()).toEqual([]);
    for (const command of commands) {
      expect(ERROR_AREAS).toContain(areaOf(command));
    }
  });

  it("reads the kind of a rejection and nothing else", () => {
    expect(kindOf({ kind: "not-found", message: "/Users/jane/Song.gp5 is gone" })).toBe(
      "not-found",
    );
    expect(kindOf({ kind: "auth-expired", message: "x" })).toBe("auth-expired");
    expect(kindOf({ kind: "something-new", message: "x" })).toBe("unknown");
    expect(kindOf({ kind: 3 })).toBe("unknown");
    expect(kindOf(new Error("disk on fire"))).toBe("unknown");
    expect(kindOf("disk on fire")).toBe("unknown");
    expect(kindOf(null)).toBe("unknown");
    expect(kindOf(undefined)).toBe("unknown");
  });

  it("builds a detail from the fixed lists only", () => {
    expect(errorDetail("audio_start", { kind: "audio", message: "No output device" })).toBe(
      "audio:audio",
    );
    expect(errorDetail("cloud_read", { kind: "network", message: "x" })).toBe("cloud:network");
    expect(errorDetail("whatever", new Error("/Users/jane/My Song.gp5"))).toBe("other:unknown");
    for (const command of ["audio_start", "export_pdf", "x"]) {
      for (const error of [{ kind: "io", message: "m" }, "text", null, { kind: "zzz" }]) {
        expect(ERROR_DETAILS).toContain(errorDetail(command, error));
      }
    }
  });

  it("does not count the counters themselves", () => {
    for (const command of ["track_event", "get_usage_settings", "set_usage_settings"]) {
      expect(errorDetail(command, { kind: "io", message: "x" })).toBeNull();
    }
  });
});
