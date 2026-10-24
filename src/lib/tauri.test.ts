import {
  describePlatform,
  getAppInfo,
  getMenuShortcuts,
  isCommandError,
  isTauri,
  loadMixerSettings,
  MIXER_SETTINGS_VERSION,
  NotInDesktopAppError,
  addRecentFile,
  clearRecentFiles,
  loadRecentFiles,
  onFileDrag,
  onMenuAction,
  onOpenRecent,
  onRecentChanged,
  pickSavePath,
  pickScoreFile,
  readScoreFile,
  removeRecentFile,
  saveMixerSettings,
  setNativeTheme,
  setWindowTitle,
  writeM4aFile,
  writeScoreFile,
  canExportM4a,
  type FileDragEvent,
  type MenuAction,
  type MixerSettings,
} from "@/lib/tauri";
import {
  APP_INFO,
  backend,
  emitFileDrag,
  emitMenuAction,
  emitOpenRecent,
  mockTauri,
  SHORTCUTS,
} from "@/test/tauri";

const KEY = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const MIX: MixerSettings = {
  version: MIXER_SETTINGS_VERSION,
  master: 0.5,
  tracks: [{ volume: 1, pan: 0, mute: false, solo: true }],
};

describe("outside the desktop app", () => {
  it("reports that Tauri is unavailable", () => {
    expect(isTauri()).toBe(false);
  });

  it("rejects commands with a descriptive error", async () => {
    await expect(getAppInfo()).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(getMenuShortcuts()).rejects.toThrow(
      /only available in the Smart Beat desktop app/,
    );
  });

  it("makes menu subscriptions and theme sync no-ops", async () => {
    const unlisten = await onMenuAction(() => {});
    expect(() => unlisten()).not.toThrow();
    await expect(setNativeTheme("dark")).resolves.toBeUndefined();
  });

  it("has no native file access, dialogs or drops", async () => {
    await expect(pickScoreFile()).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(readScoreFile("/a.gp5")).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(loadMixerSettings(KEY)).rejects.toBeInstanceOf(NotInDesktopAppError);
    const unlisten = await onFileDrag(() => {});
    expect(() => unlisten()).not.toThrow();
  });

  it("sets the page title instead of the window title", async () => {
    await setWindowTitle("Song — Smart Beat");
    expect(document.title).toBe("Song — Smart Beat");
  });
});

describe("inside the desktop app", () => {
  it("detects Tauri", () => {
    mockTauri();
    expect(isTauri()).toBe(true);
  });

  it("invokes the Rust commands", async () => {
    const calls = mockTauri();

    await expect(getAppInfo()).resolves.toEqual(APP_INFO);
    await expect(getMenuShortcuts()).resolves.toEqual(SHORTCUTS);
    expect(calls.map((c) => c.cmd)).toEqual(["app_info", "menu_shortcuts"]);
  });

  it("delivers menu actions until unsubscribed", async () => {
    mockTauri();
    const received: MenuAction[] = [];
    const unlisten = await onMenuAction((action) => received.push(action));

    await emitMenuAction("about");
    unlisten();
    await emitMenuAction("open");

    expect(received).toEqual(["about"]);
  });

  it("syncs the native window theme", async () => {
    const calls = mockTauri();

    await setNativeTheme("dark");
    await setNativeTheme(null);

    const themeCalls = calls.filter((c) => c.cmd === "plugin:window|set_theme");
    expect(themeCalls.map((c) => c.args)).toEqual([
      expect.objectContaining({ value: "dark" }),
      expect.objectContaining({ value: null }),
    ]);
  });
});

describe("score files", () => {
  it("offers Guitar Pro files in the Open dialog", async () => {
    const calls = mockTauri();
    backend.dialogResult = "/songs/a.gp5";

    await expect(pickScoreFile()).resolves.toBe("/songs/a.gp5");

    expect(calls).toContainEqual({
      cmd: "plugin:dialog|open",
      args: {
        options: expect.objectContaining({
          multiple: false,
          directory: false,
          filters: [
            {
              name: "Songs",
              extensions: [
                "gp3",
                "gp4",
                "gp5",
                "gpx",
                "gp",
                "mid",
                "midi",
                "musicxml",
                "mxl",
                "xml",
                "mscx",
                "mscz",
                "atex",
                "capx",
                "txt",
              ],
            },
            { name: "Guitar Pro files", extensions: ["gp3", "gp4", "gp5", "gpx", "gp"] },
            { name: "MusicXML files", extensions: ["musicxml", "mxl", "xml"] },
            { name: "MIDI files", extensions: ["mid", "midi"] },
            { name: "MuseScore files", extensions: ["mscx", "mscz"] },
            { name: "Text tab and alphaTex", extensions: ["txt", "atex"] },
            { name: "Capella files", extensions: ["capx"] },
          ],
        }),
      },
    });
  });

  it("returns null when the dialog is cancelled", async () => {
    mockTauri();
    await expect(pickScoreFile()).resolves.toBeNull();
  });

  it("reads a file as bytes", async () => {
    mockTauri();
    backend.files.set("/songs/a.gp5", new Uint8Array([1, 2, 3]));

    await expect(readScoreFile("/songs/a.gp5")).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects with the Rust error", async () => {
    mockTauri();

    const error: unknown = await readScoreFile("/songs/missing.gp").catch((e: unknown) => e);

    expect(isCommandError(error)).toBe(true);
    expect(error).toMatchObject({ kind: "not-found" });
  });

  it("reports files dragged onto the window", async () => {
    mockTauri();
    const events: FileDragEvent[] = [];
    const unlisten = await onFileDrag((event) => events.push(event));

    await emitFileDrag({ type: "enter", paths: ["/a.gp5"] });
    await emitFileDrag({ type: "leave" });
    await emitFileDrag({ type: "drop", paths: ["/a.gp5", "/b.txt"] });
    unlisten();
    await emitFileDrag({ type: "drop", paths: ["/c.gp5"] });

    expect(events).toEqual([
      { type: "enter" },
      { type: "leave" },
      { type: "drop", paths: ["/a.gp5", "/b.txt"] },
    ]);
  });
});

describe("mixer settings", () => {
  it("saves and loads a song's mix", async () => {
    const calls = mockTauri();

    await expect(loadMixerSettings(KEY)).resolves.toBeNull();
    await saveMixerSettings(KEY, MIX);
    await expect(loadMixerSettings(KEY)).resolves.toEqual(MIX);

    expect(calls.map((c) => c.cmd)).toEqual([
      "load_mixer_settings",
      "save_mixer_settings",
      "load_mixer_settings",
    ]);
    expect(calls[1]!.args).toEqual({ fileKey: KEY, settings: MIX });
  });
});

describe("setWindowTitle", () => {
  it("sets the native window title", async () => {
    const calls = mockTauri();

    await setWindowTitle("Song — Smart Beat");

    expect(calls).toContainEqual(
      expect.objectContaining({
        cmd: "plugin:window|set_title",
        args: expect.objectContaining({ value: "Song — Smart Beat" }),
      }),
    );
  });
});

describe("isCommandError", () => {
  it.each([
    [{ kind: "io", message: "x" }, true],
    [new Error("x"), false],
    [null, false],
    ["x", false],
    [{ kind: 1, message: "x" }, false],
  ])("%o → %s", (value, expected) => {
    expect(isCommandError(value)).toBe(expected);
  });
});

describe("describePlatform", () => {
  it.each([
    [{ os: "macos", arch: "aarch64" }, "macOS (Apple Silicon)"],
    [{ os: "macos", arch: "x86_64" }, "macOS (x64)"],
    [{ os: "windows", arch: "x86_64" }, "Windows (x64)"],
    [{ os: "linux", arch: "aarch64" }, "Linux (ARM64)"],
    [{ os: "freebsd", arch: "riscv64" }, "freebsd (riscv64)"],
  ])("describes %o as %s", (platform, expected) => {
    expect(describePlatform(platform)).toBe(expected);
  });
});

describe("saving files", () => {
  it("offers the given file types in the Save dialog", async () => {
    const calls = mockTauri();
    backend.saveResult = "/songs/a.gp";

    await expect(
      pickSavePath("/songs/a.gp", [{ name: "Guitar Pro 7", extensions: ["gp"] }], "Save As"),
    ).resolves.toBe("/songs/a.gp");

    expect(calls).toContainEqual({
      cmd: "plugin:dialog|save",
      args: {
        options: expect.objectContaining({
          title: "Save As",
          defaultPath: "/songs/a.gp",
          filters: [{ name: "Guitar Pro 7", extensions: ["gp"] }],
        }),
      },
    });
  });

  it("returns null when the Save dialog is cancelled", async () => {
    mockTauri();
    await expect(pickSavePath("a.gp", [])).resolves.toBeNull();
  });

  it("sends the bytes as the request body and the path (URL-encoded) in a header", async () => {
    mockTauri();

    await writeScoreFile("/songs/my song é.gp", new Uint8Array([1, 2, 3]));

    expect(backend.written.get("/songs/my song é.gp")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("only works in the desktop app", async () => {
    await expect(pickSavePath("a.gp", [])).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(writeScoreFile("/a.gp", new Uint8Array())).rejects.toBeInstanceOf(
      NotInDesktopAppError,
    );
    await expect(writeM4aFile("/a.m4a", new Uint8Array())).rejects.toBeInstanceOf(
      NotInDesktopAppError,
    );
  });
});

describe("M4A export", () => {
  it("sends the WAV as the request body and the path (URL-encoded) in a header", async () => {
    const calls = mockTauri();

    await writeM4aFile("/songs/my mix é.m4a", new Uint8Array([1, 2, 3]));

    expect(calls.map((c) => c.cmd)).toEqual(["export_m4a"]);
    expect(backend.written.get("/songs/my mix é.m4a")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects with the encoder's error", async () => {
    mockTauri({
      export_m4a: () => {
        throw { kind: "audio", message: "M4A export needs macOS for now." };
      },
    });

    await expect(writeM4aFile("/a.m4a", new Uint8Array([1]))).rejects.toMatchObject({
      kind: "audio",
    });
  });

  it("is offered on macOS only (where the system has an AAC encoder)", () => {
    expect(canExportM4a({ os: "macos" })).toBe(true);
    expect(canExportM4a({ os: "windows" })).toBe(true);
    expect(canExportM4a({ os: "linux" })).toBe(false);
  });
});

describe("recent files", () => {
  it("adds, lists, removes and clears the most recent songs", async () => {
    mockTauri();

    await expect(loadRecentFiles()).resolves.toEqual([]);
    await addRecentFile("/a.gp5");
    await expect(addRecentFile("/b.gp5")).resolves.toEqual(["/b.gp5", "/a.gp5"]);
    await expect(loadRecentFiles()).resolves.toEqual(["/b.gp5", "/a.gp5"]);
    await expect(removeRecentFile("/b.gp5")).resolves.toEqual(["/a.gp5"]);
    await expect(clearRecentFiles()).resolves.toEqual([]);
  });

  it("does nothing in a browser", async () => {
    await expect(loadRecentFiles()).resolves.toEqual([]);
    await expect(addRecentFile("/a.gp5")).resolves.toEqual([]);
    await expect(removeRecentFile("/a.gp5")).resolves.toEqual([]);
    await expect(clearRecentFiles()).resolves.toEqual([]);
    const stop = await onOpenRecent(() => {});
    stop();
    (await onRecentChanged(() => {}))();
  });

  it("hears File › Open Recent clicks and changes made by the menu", async () => {
    mockTauri();
    const opened: string[] = [];
    const lists: string[][] = [];
    const stopOpen = await onOpenRecent((path) => opened.push(path));
    const stopChanged = await onRecentChanged((paths) => lists.push(paths));

    await emitOpenRecent("/a.gp5");
    const { emit } = await import("@tauri-apps/api/event");
    await emit("recent-changed", []);
    stopOpen();
    stopChanged();
    await emitOpenRecent("/b.gp5");

    expect(opened).toEqual(["/a.gp5"]);
    expect(lists).toEqual([[]]);
  });
});
