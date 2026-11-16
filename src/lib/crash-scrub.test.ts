import { scrubCrashEvent, scrubFilename, type CrashContext } from "@/lib/crash-scrub";

const CONTEXT: CrashContext = { release: "1.3.0", environment: "production", os: "macos" };

/** An SDK event the way the global handlers build it, with everything that must not leave. */
function sdkEvent(frames: unknown[], extra: Record<string, unknown> = {}) {
  return {
    event_id: "0123456789abcdef0123456789abcdef",
    timestamp: 1_760_000_000.5,
    platform: "javascript",
    level: "error",
    message: "Cannot open My Secret Song.gp5",
    release: "1.3.0-private",
    environment: "production",
    server_name: "janes-macbook.local",
    user: { id: "42", email: "jane@example.com", ip_address: "10.1.2.3", username: "jane" },
    request: { url: "https://x.test/a?token=abc123", headers: { Cookie: "sid=1" } },
    breadcrumbs: [{ message: "clicked /Users/jane/Music/My Secret Song.gp5" }],
    contexts: { device: { name: "Jane's MacBook" }, os: { name: "macOS", version: "26.1" } },
    extra: { path: "/Users/jane/Music" },
    tags: { user: "jane", os: "macOS 26.1" },
    modules: { "private-module": "1.0.0" },
    attachments: [{ filename: "screenshot.png" }],
    sdk: {
      name: "sentry.javascript.browser",
      version: "11.12.0",
      packages: [{ name: "npm:@sentry/browser", version: "11.12.0" }],
      integrations: ["GlobalHandlers"],
    },
    exception: {
      values: [
        {
          type: "TypeError",
          value: "Cannot read My Secret Song.gp5 at /Users/jane/Music",
          mechanism: { type: "auto.browser.global_handlers.onerror", handled: false },
          stacktrace: { frames },
        },
      ],
    },
    ...extra,
  };
}

const goodFrame = {
  filename: "tauri://localhost/assets/index-AbC123.js",
  function: "openSong",
  lineno: 10,
  colno: 5,
  abs_path: "tauri://localhost/assets/index-AbC123.js",
  in_app: true,
  vars: { path: "/Users/jane/x.gp5" },
  context_line: "const p = '/Users/jane/x.gp5'",
};

/** Strings that must never appear in anything sent. */
const FORBIDDEN = [
  "/Users/jane",
  "C:\\Users\\jane",
  "My Secret Song",
  ".gp5",
  "token=abc123",
  "x.test",
  "file:///",
  "tauri://",
  "localhost",
  "jane",
  "example.com",
  "10.1.2.3",
  "macbook",
  "screenshot",
  "private-module",
];

function expectNothingPrivate(event: unknown) {
  const text = JSON.stringify(event);
  for (const word of FORBIDDEN) expect(text.toLowerCase()).not.toContain(word.toLowerCase());
}

describe("scrubCrashEvent", () => {
  it("keeps only the allowed fields", () => {
    const event = scrubCrashEvent(sdkEvent([goodFrame]), CONTEXT);
    expect(event).toEqual({
      event_id: "0123456789abcdef0123456789abcdef",
      timestamp: 1_760_000_000.5,
      platform: "javascript",
      level: "error",
      release: "1.3.0",
      environment: "production",
      server_name: "",
      tags: { os: "macos" },
      sdk: {
        name: "sentry.javascript.browser",
        version: "11.12.0",
        settings: { infer_ip: "never" },
      },
      exception: {
        values: [
          {
            type: "TypeError",
            stacktrace: {
              frames: [{ filename: "index-AbC123.js", function: "openSong", lineno: 10, colno: 5 }],
            },
          },
        ],
      },
    });
    expectNothingPrivate(event);
  });

  it("drops message, user, request, breadcrumbs, contexts, extra, modules and attachments", () => {
    const event = scrubCrashEvent(sdkEvent([goodFrame]), CONTEXT) as unknown as Record<
      string,
      unknown
    >;
    for (const key of [
      "message",
      "user",
      "request",
      "breadcrumbs",
      "contexts",
      "extra",
      "modules",
      "attachments",
      "logentry",
      "transaction",
      "debug_meta",
    ]) {
      expect(event).not.toHaveProperty(key);
    }
    expect(event.tags).toEqual({ os: "macos" });
    expect(event.server_name).toBe("");
    const [exception] = (event.exception as { values: Record<string, unknown>[] }).values;
    expect(exception).not.toHaveProperty("value");
    expect(exception).not.toHaveProperty("mechanism");
    const [frame] = (exception!.stacktrace as { frames: Record<string, unknown>[] }).frames;
    for (const key of ["abs_path", "in_app", "vars", "context_line"]) {
      expect(frame).not.toHaveProperty(key);
    }
  });

  it("drops every frame whose location is private, and the event when none is left", () => {
    const badFilenames = [
      "/Users/jane/Music/app.js",
      "C:\\Users\\jane\\app.js",
      "C:/Users/jane/app.js",
      "file:///Users/jane/x.js",
      "tauri://localhost/index.html",
      "https://x.test/a?token=abc123",
      "http://127.0.0.1:1420/",
      "My Secret Song.gp5",
      "jane@example.com",
      "",
      undefined,
      42,
    ];
    const event = sdkEvent(
      badFilenames.map((filename) => ({ filename, function: "f", lineno: 1 })),
    );
    expect(scrubCrashEvent(event, CONTEXT)).toBeNull();
  });

  it("keeps the valid frames next to dropped ones", () => {
    const event = scrubCrashEvent(
      sdkEvent([
        { filename: "file:///Users/jane/x.js", function: "a", lineno: 1 },
        {
          filename: "http://localhost:1420/src/lib/score/player.ts?t=17",
          function: "play",
          lineno: 7,
        },
        { filename: "tauri://localhost/index.html" },
      ]),
      CONTEXT,
    );
    expect(event?.exception.values[0]?.stacktrace.frames).toEqual([
      { filename: "src/lib/score/player.ts", function: "play", lineno: 7 },
    ]);
  });

  it("drops a function name that holds a path, URL, e-mail, IPv4 address or token", () => {
    for (const name of [
      "/Users/jane/x",
      "C:\\Users\\jane\\x",
      "https://x.test/a",
      "jane@example.com",
      "10.1.2.3",
      "abcdefghijklmnopqrstuvwxyz0123",
      "My Secret Song.gp5",
    ]) {
      const event = scrubCrashEvent(
        sdkEvent([{ filename: "src/App.tsx", function: name, lineno: 1 }]),
        CONTEXT,
      );
      expect(event?.exception.values[0]?.stacktrace.frames).toEqual([
        { filename: "src/App.tsx", lineno: 1 },
      ]);
      expectNothingPrivate(event);
    }
  });

  it("keeps a plain function name, including a method and an anonymous one", () => {
    for (const name of ["openSong", "Object.<anonymous>", "HTMLButtonElement.onclick", "?"]) {
      const event = scrubCrashEvent(
        sdkEvent([{ filename: "src/App.tsx", function: name }]),
        CONTEXT,
      );
      expect(event?.exception.values[0]?.stacktrace.frames[0]?.function).toBe(
        name === "?" ? undefined : name,
      );
    }
  });

  it("replaces an exception type that is not a plain name", () => {
    const event = sdkEvent([goodFrame]);
    event.exception.values[0]!.type = "Error: /Users/jane/x.gp5";
    expect(scrubCrashEvent(event, CONTEXT)?.exception.values[0]?.type).toBe("Error");
  });

  it("drops an event without frames or exceptions, and input that is not an event", () => {
    expect(scrubCrashEvent(sdkEvent([]), CONTEXT)).toBeNull();
    expect(scrubCrashEvent({ message: "hello" }, CONTEXT)).toBeNull();
    expect(scrubCrashEvent({ exception: { values: [{ type: "Error" }] } }, CONTEXT)).toBeNull();
    for (const input of [null, undefined, "text", 1, []]) {
      expect(scrubCrashEvent(input, CONTEXT)).toBeNull();
    }
  });

  it("keeps the exceptions that have frames and drops the others", () => {
    const event = sdkEvent([goodFrame]);
    event.exception.values.unshift({
      type: "Error",
      value: "no frames",
      mechanism: { type: "x", handled: true },
      stacktrace: { frames: [] },
    });
    expect(scrubCrashEvent(event, CONTEXT)?.exception.values).toHaveLength(1);
  });

  it("leaves out the os tag when the system is not known, and bad ids and times", () => {
    const event = scrubCrashEvent(
      sdkEvent([goodFrame], { event_id: "/Users/jane", timestamp: "now" }),
      { release: "1.3.0", environment: "development" },
    );
    expect(event).not.toHaveProperty("tags");
    expect(event).not.toHaveProperty("event_id");
    expect(event).not.toHaveProperty("timestamp");
    expect(event?.environment).toBe("development");
  });

  it("drops line and column numbers that are not plain positions", () => {
    const event = scrubCrashEvent(
      sdkEvent([{ filename: "src/App.tsx", lineno: -1, colno: 1.5 }]),
      CONTEXT,
    );
    expect(event?.exception.values[0]?.stacktrace.frames).toEqual([{ filename: "src/App.tsx" }]);
  });

  it("keeps at most the last 100 frames", () => {
    const frames = Array.from({ length: 150 }, (_, i) => ({ filename: "src/App.tsx", lineno: i }));
    const kept = scrubCrashEvent(sdkEvent(frames), CONTEXT)?.exception.values[0]?.stacktrace.frames;
    expect(kept).toHaveLength(100);
    expect(kept?.[0]?.lineno).toBe(50);
  });
});

describe("scrubFilename", () => {
  it.each([
    ["src/lib/score/player.ts", "src/lib/score/player.ts"],
    ["src-tauri/src/commands.rs", "src-tauri/src/commands.rs"],
    ["http://localhost:1420/src/App.tsx?t=1#x", "src/App.tsx"],
    ["http://127.0.0.1:1420/src/main.tsx", "src/main.tsx"],
    ["tauri://localhost/assets/index-AbC123.js", "index-AbC123.js"],
    ["https://tauri.localhost/assets/chunk-DfG45hI9.js", "chunk-DfG45hI9.js"],
    ["index-AbC123.js", "index-AbC123.js"],
  ])("keeps %s as %s", (raw, expected) => {
    expect(scrubFilename(raw)).toBe(expected);
  });

  it.each([
    "/Users/jane/Music/index-AbC123.js",
    "/src/App.tsx",
    "C:\\Users\\jane\\index-AbC123.js",
    "file:///Users/jane/x",
    "file:///src/App.tsx",
    "tauri://localhost/index.html",
    "tauri://localhost/",
    "tauri://localhost",
    "https://x.test/a?token=abc123",
    "src/../../etc/passwd",
    "src/My Secret Song.gp5",
    "src/a%20b.ts",
    "index.js",
    "http://localhost:1420/@fs/Users/jane/proj/src/x.ts",
    "http://localhost:1420/src/aaaaaaaaaaaaaaaaaaaaaaaaaaaa.ts",
    "",
    "x".repeat(2000),
  ])("drops %s", (raw) => {
    expect(scrubFilename(raw)).toBeNull();
  });
});
