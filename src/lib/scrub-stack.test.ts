import {
  buildTrace,
  extensionOf,
  FILE_FORMATS,
  isValidFrame,
  isValidLocation,
  MAX_FRAMES,
  originOf,
  scrubStack,
} from "@/lib/scrub-stack";

const v8 = (...lines: string[]) => ["Error: boom", ...lines.map((l) => `    at ${l}`)].join("\n");

describe("scrubStack", () => {
  it("reads the V8 format and drops the message line", () => {
    const stack = v8(
      "startPlayback (tauri://localhost/assets/index-AbC123.js:1:48211)",
      "async onClick (tauri://localhost/assets/index-AbC123.js:1:99)",
      "tauri://localhost/assets/index-AbC123.js:2:3",
    );
    expect(scrubStack(stack)).toEqual([
      "startPlayback index-AbC123.js:1:48211",
      "onClick index-AbC123.js:1:99",
      "index-AbC123.js:2:3",
    ]);
  });

  it("reads the WebKit format", () => {
    const stack = [
      "startPlayback@tauri://localhost/assets/index-AbC123.js:1:48211",
      "@tauri://localhost/assets/index-AbC123.js:1:99",
      "global code@tauri://localhost/assets/index-AbC123.js:5:1",
      "[native code]",
    ].join("\n");
    expect(scrubStack(stack)).toEqual([
      "startPlayback index-AbC123.js:1:48211",
      "index-AbC123.js:1:99",
      "index-AbC123.js:5:1",
    ]);
  });

  it("keeps the app-relative path of a dev server and drops its host and query", () => {
    const stack = v8("playNow (http://localhost:1420/src/lib/tauri.ts?t=1699999999:650:12)");
    expect(scrubStack(stack)).toEqual(["playNow src/lib/tauri.ts:650:12"]);
  });

  it("drops the user name from absolute macOS and Windows paths", () => {
    const stack = v8(
      "load (/Users/jane/Projects/smart-beat/src/lib/tauri.ts:10:2)",
      "other (C:\\Users\\jane\\Documents\\app.js:3:4)",
      "/Users/jane/Music/helper.js:7:8",
    );
    const frames = scrubStack(stack);
    expect(frames).toEqual(["load src/lib/tauri.ts:10:2", "other app.js:3:4", "helper.js:7:8"]);
    expect(JSON.stringify(frames)).not.toMatch(/jane|Users|Projects|Documents/);
  });

  it("never keeps the name of a score file or other user file", () => {
    const stack = v8(
      "open (file:///Users/jane/My Secret Song.gp5:1:2)",
      "read (/Users/jane/Songs/My Secret Song.gp5)",
    );
    const frames = scrubStack(stack);
    expect(JSON.stringify(frames)).not.toMatch(/Secret|Song|gp5|jane/);
    expect(frames).toEqual(["open", "read"]);
  });

  it("drops query strings, tokens, file:// and tauri:// hosts", () => {
    const stack = v8(
      "fetchIt (http://localhost:1420/assets/index-X1.js?token=abc123:4:5)",
      "go (file:///Users/jane/app/dist/index-Y2.js#frag:6:7)",
      "run (tauri://localhost/assets/index-Z3.js:8:9)",
    );
    const sent = JSON.stringify(scrubStack(stack));
    expect(sent).not.toMatch(/token|abc123|localhost|file:|tauri:|jane|frag|\?|#/);
    expect(scrubStack(stack)).toEqual([
      "fetchIt index-X1.js:4:5",
      "go index-Y2.js:6:7",
      "run index-Z3.js:8:9",
    ]);
  });

  it("does not let an email or message text through, in either format", () => {
    expect(scrubStack("Error: mail jane@example.com failed")).toEqual([]);
    expect(scrubStack("Error: mail jane@example.com failed\nfoo@bar.js:1:2")).toEqual([
      "foo bar.js:1:2",
    ]);
    expect(scrubStack(v8("jane@example.com (tauri://localhost/assets/a.js:1:2)"))).toEqual([
      "a.js:1:2",
    ]);
    const message = [
      "Error: jane@example.com",
      "    at fn (tauri://localhost/assets/index-Q.js:1:2)",
    ];
    expect(JSON.stringify(scrubStack(message.join("\n")))).not.toMatch(/jane|example/);
  });

  it("keeps at most five frames", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `f${i} (tauri://localhost/a.js:${i}:1)`);
    const frames = scrubStack(v8(...lines));
    expect(frames).toHaveLength(5);
    expect(frames[0]).toBe("f0 a.js:0:1");
    expect(scrubStack(v8(...lines), 2)[0]).toBe("f2 a.js:2:1");
    expect(scrubStack(v8(...lines), 0, 2)).toHaveLength(2);
  });

  it("drops over-long and invalid frames instead of sending them", () => {
    const long = "x".repeat(5000);
    const stack = v8(
      `${long} (tauri://localhost/assets/${long}.js:1:2)`,
      "fine (tauri://localhost/assets/index-AbC123.js:1:2)",
      "abcdefghijklmnopqrstuvwxyz0123 (tauri://localhost/assets/index-AbC123.js:3:4)",
      "node:internal/process/task_queues:95:5",
      "async Promise.all (index 0)",
    );
    const frames = scrubStack(stack);
    expect(frames).toEqual(["fine index-AbC123.js:1:2", "index-AbC123.js:3:4", "Promise.all"]);
    for (const frame of frames) expect(frame.length).toBeLessThanOrEqual(100);
  });

  it("returns nothing for anything that is not a stack", () => {
    expect(scrubStack(undefined)).toEqual([]);
    expect(scrubStack(42)).toEqual([]);
    expect(scrubStack("")).toEqual([]);
  });
});

describe("isValidFrame", () => {
  it.each([
    "audio_start",
    "src/audio/mod.rs:123",
    "src-tauri/src/m4a.rs:39",
    "startPlayback index-AbC123.js:1:48211",
    "src/lib/tauri.ts:650:12",
    "Object.<anonymous>",
  ])("accepts %s", (frame) => {
    expect(isValidFrame(frame)).toBe(true);
  });

  it.each([
    "",
    "/Users/jane/x.js:1:2",
    "C:\\Users\\jane",
    "file:///x/y.js:1:2",
    "tauri://localhost/a.js",
    "a@b.c",
    "src/../etc/passwd.ts:1",
    "src/lib/a.ts?token=1",
    "src/lib/a.ts#x",
    "fn 192.168.1.1",
    "abcdefghijklmnopqrstuvwxyz",
    "My Secret Song.gp5",
    "has space",
    "x".repeat(101),
    "lib/tauri.ts:1:2",
    "src/lib/tauri.ts:1:2:3",
  ])("rejects %j", (frame) => {
    expect(isValidFrame(frame)).toBe(false);
  });

  it("rejects values that are not strings", () => {
    expect(isValidFrame(undefined)).toBe(false);
    expect(isValidFrame(12)).toBe(false);
  });

  it("tells a location from a bare name", () => {
    expect(isValidLocation("src/audio/mod.rs:123")).toBe(true);
    expect(isValidLocation("audio_start")).toBe(false);
    expect(isValidLocation("fn src/a.ts:1")).toBe(false);
  });
});

describe("originOf", () => {
  it("accepts an app-relative location", () => {
    expect(originOf({ kind: "audio", message: "x", origin: "src/audio/mod.rs:123" })).toBe(
      "src/audio/mod.rs:123",
    );
  });

  it("rejects an origin that is not an app-relative location, and never reads the message", () => {
    expect(originOf({ kind: "io", message: "src/audio/mod.rs:1" })).toBeUndefined();
    expect(originOf({ kind: "io", origin: "/Users/jane/x.rs:1" })).toBeUndefined();
    expect(originOf({ kind: "io", origin: "audio_start" })).toBeUndefined();
    expect(originOf({ kind: "io", origin: 12 })).toBeUndefined();
    expect(originOf("src/audio/mod.rs:1")).toBeUndefined();
    expect(originOf(null)).toBeUndefined();
  });
});

describe("extensionOf", () => {
  it("takes the lowercased extension of a path argument when it is a known format", () => {
    expect(extensionOf({ path: "/Users/jane/My Secret Song.GP5" })).toBe("gp5");
    expect(extensionOf({ path: "C:\\Users\\jane\\song.mid" })).toBe("mid");
    expect(extensionOf({ filePath: "/a/b.musicxml", other: 1 })).toBe("musicxml");
  });

  it("files anything else as other, and never keeps a file name", () => {
    expect(extensionOf({ path: "/Users/jane/Secret.jane" })).toBe("other");
    expect(extensionOf({ path: "/Users/jane/Folder" })).toBe("other");
    expect(extensionOf({ path: "/Users/jane/.hidden" })).toBe("other");
    expect(extensionOf({ path: "/a/b.gp5?x" })).toBe("other");
  });

  it("is undefined without a path-like string argument", () => {
    expect(extensionOf(undefined)).toBeUndefined();
    expect(extensionOf({ name: "x.gp5" })).toBeUndefined();
    expect(extensionOf({ path: 3 })).toBeUndefined();
    expect(extensionOf({ path: "" })).toBeUndefined();
    expect(extensionOf(["x.gp5"])).toBeUndefined();
  });

  it("only ever answers with a known format or other", () => {
    for (const ext of FILE_FORMATS) {
      expect(extensionOf({ path: `/x/y.${ext.toUpperCase()}` })).toBe(ext);
    }
  });
});

describe("buildTrace", () => {
  it("orders the command, the Rust origin and the scrubbed call sites", () => {
    const trace = buildTrace({
      command: "audio_start",
      error: { kind: "audio", message: "No device at /Users/jane", origin: "src/audio/mod.rs:123" },
      args: { path: "/Users/jane/Songs/My Secret Song.gp5" },
      stack: v8("f (tauri://localhost/assets/index-AbC123.js:1:2)"),
    });
    expect(trace).toEqual({
      frames: ["audio_start", "src/audio/mod.rs:123", "f index-AbC123.js:1:2"],
      ext: "gp5",
    });
  });

  it("works without an origin, without a stack and without arguments", () => {
    expect(buildTrace({ command: "stems_list", error: new Error("x") })).toEqual({
      frames: ["stems_list"],
    });
  });

  it("is undefined when no frame is left", () => {
    expect(buildTrace({ command: "has space", error: null, stack: "garbage" })).toBeUndefined();
  });

  it("stays within eight frames", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `f${i} (tauri://localhost/a.js:${i}:1)`);
    const trace = buildTrace({
      command: "audio_start",
      error: { origin: "src/audio/mod.rs:1" },
      stack: v8(...lines),
    });
    expect(trace?.frames.length).toBeLessThanOrEqual(MAX_FRAMES);
    expect(trace?.frames).toHaveLength(7);
  });
});
