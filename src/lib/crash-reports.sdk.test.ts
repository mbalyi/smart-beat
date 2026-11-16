import * as Sentry from "@sentry/browser";

import { crashReportOptions, type CrashSession } from "@/lib/crash-reports";

/** The real SDK with the real options, and a transport that only records what would be sent. */
type Sent = [{ [key: string]: unknown }, [{ type?: string }, Record<string, unknown>][]];

const DSN = "https://public@o1.ingest.de.sentry.io/1";

function start(session: CrashSession = { live: true }) {
  const sent: Sent[] = [];
  const fetchTransport = vi.fn(() => ({
    send: async (envelope: Sent) => {
      sent.push(envelope);
      return {};
    },
    flush: async () => true,
  }));
  const options = crashReportOptions(DSN, session, {
    globalHandlersIntegration: Sentry.globalHandlersIntegration,
    makeFetchTransport: fetchTransport as never,
  });
  const client = Sentry.init(options);
  return { sent, client, session };
}

/** An error whose stack holds private places next to one frame of the app. */
function privateError() {
  const error = new Error("Cannot open /Users/jane/Music/My Secret Song.gp5 jane@example.com");
  error.name = "TypeError";
  error.stack = [
    "TypeError: Cannot open /Users/jane/Music/My Secret Song.gp5",
    "    at openSong (http://127.0.0.1:1420/src/lib/score/player.ts?t=9:10:5)",
    "    at readIt (file:///Users/jane/x.js:1:1)",
    "    at Object.<anonymous> (C:\\Users\\jane\\x.js:2:2)",
    "    at go (tauri://localhost/index.html:3:3)",
    "    at fetchIt (https://x.test/a?token=abc123:4:4)",
    "    at run (tauri://localhost/assets/index-AbC123.js:5:6)",
  ].join("\n");
  return error;
}

beforeEach(() => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Sentry.close(0);
});

describe("crash reports with the real SDK", () => {
  it("sends one scrubbed error event and nothing else", async () => {
    const { sent } = start();
    Sentry.getCurrentScope().setUser({ email: "jane@example.com", ip_address: "10.1.2.3" });
    Sentry.setTag("user", "jane");
    Sentry.setExtra("path", "/Users/jane/Music");
    Sentry.addBreadcrumb({ message: "/Users/jane/Music/My Secret Song.gp5" });
    Sentry.captureException(privateError());
    await Sentry.flush(1000);

    expect(sent).toHaveLength(1);
    const [headers, items] = sent[0]!;
    expect(items.map(([header]) => header.type)).toEqual(["event"]);
    const event = items[0]![1] as {
      exception: { values: { type: string; stacktrace: { frames: unknown[] } }[] };
    };
    expect(event.exception.values[0]?.type).toBe("TypeError");
    expect(event.exception.values[0]?.stacktrace.frames).toEqual([
      { filename: "index-AbC123.js", function: "run", lineno: 5, colno: 6 },
      { filename: "src/lib/score/player.ts", function: "openSong", lineno: 10, colno: 5 },
    ]);
    expect(Object.keys(event).sort()).toEqual(
      [
        "environment",
        "event_id",
        "exception",
        "level",
        "platform",
        "release",
        "sdk",
        "server_name",
        "tags",
        "timestamp",
      ].sort(),
    );
    expect(event).toMatchObject({ tags: { os: "macos" } });

    const everything = JSON.stringify([headers, items]).toLowerCase();
    for (const word of [
      "jane",
      "/users",
      "secret song",
      ".gp5",
      "token",
      "x.test",
      "file://",
      "tauri://",
      "localhost",
      "example.com",
      "10.1.2.3",
      "127.0.0.1",
      "breadcrumb",
    ]) {
      expect(everything).not.toContain(word);
    }
  });

  it("sends nothing for an error with no frame of the app", async () => {
    const { sent } = start();
    const error = new Error("My Secret Song.gp5");
    error.stack = "Error: My Secret Song.gp5\n    at f (file:///Users/jane/x.js:1:1)";
    Sentry.captureException(error);
    Sentry.captureMessage("My Secret Song.gp5");
    await Sentry.flush(1000);
    expect(sent).toEqual([]);
  });

  it("sends no session, replay or client report", async () => {
    const { sent } = start();
    Sentry.captureException(privateError());
    Sentry.startSession();
    Sentry.captureSession(true);
    await Sentry.flush(1000);
    expect(sent.flatMap(([, items]) => items.map(([header]) => header.type))).toEqual(["event"]);
  });

  it("installs no integration but the global error handlers", () => {
    const { client } = start();
    expect(
      Object.keys(
        client!
          .getOptions()
          .integrations.map((i) => i.name)
          .sort(),
      ),
    ).toHaveLength(1);
    expect(client!.getOptions().integrations.map((i) => i.name)).toEqual(["GlobalHandlers"]);
  });

  it("sends nothing once the switch went off", async () => {
    const { sent, session } = start();
    session.live = false;
    Sentry.captureException(privateError());
    await Sentry.flush(1000);
    expect(sent).toEqual([]);
  });
});
