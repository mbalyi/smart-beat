import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  cleanup,
  MAX_FRAMES,
  MAX_TRACE_HASHES_PER_DAY,
  MAX_TRACES,
  validFrame,
  type Env,
} from "../src/logic";
import { fakeD1, migrationFiles, migrationSql } from "./d1";

const today = new Date().toISOString().slice(0, 10);
const TOKEN = "s3cret-token";

let env: Env;
let sqlite: ReturnType<typeof fakeD1>["sqlite"];

beforeEach(() => {
  const fake = fakeD1();
  sqlite = fake.sqlite;
  env = { DB: fake.db, ANALYTICS_SUMMARY_TOKEN: TOKEN };
});

/** The hash the app computes: 16 hex chars of SHA-256 of the top 2 frames, one per line. */
const hashOf = (frames: string[]) =>
  createHash("sha256").update(frames.slice(0, 2).join("\n")).digest("hex").slice(0, 16);

const FRAMES = ["audio_start", "src/audio/mod.rs:123", "src/lib/tauri.ts:650:12"];

const trace = (over: Record<string, unknown> = {}) => {
  const frames = "frames" in over ? over.frames : FRAMES;
  return {
    day: today,
    format: "audio:audio",
    hash: Array.isArray(frames) ? hashOf(frames.map(String)) : "0123456789abcdef",
    frames,
    count: 1,
    ...over,
  };
};

const errorCount = (format = "audio:audio", count = 1) => ({
  day: today,
  event: "error",
  format,
  count,
});

const batch = (counts: unknown[], traces?: unknown, extra = {}) => ({
  version: "1.3.1",
  os: "macos",
  installer: "dmg",
  counts,
  ...(traces === undefined ? {} : { traces }),
  ...extra,
});

const post = (body: unknown) =>
  worker.fetch(
    new Request("https://x.test/v1/batch", { method: "POST", body: JSON.stringify(body) }),
    env,
  );

const stored = () =>
  sqlite
    .prepare("SELECT * FROM error_traces ORDER BY day, hash, format, ext")
    .all()
    .map((r) => ({ ...r })) as Array<Record<string, unknown>>;
const counted = () =>
  sqlite
    .prepare("SELECT event, format, count FROM daily_counts ORDER BY event, format")
    .all()
    .map((r) => ({ ...r }));
const frameRows = () =>
  sqlite
    .prepare("SELECT * FROM trace_frames ORDER BY hash")
    .all()
    .map((r) => ({ ...r }));

describe("error traces in POST /v1/batch", () => {
  it("stores a trace with its frames next to the error counter", async () => {
    const response = await post(batch([errorCount()], [trace({ ext: "mp3", count: 2 })]));
    expect(response.status).toBe(200);
    expect(counted()).toEqual([{ event: "error", format: "audio:audio", count: 1 }]);
    expect(stored()).toEqual([
      {
        day: today,
        hash: hashOf(FRAMES),
        format: "audio:audio",
        ext: "mp3",
        version: "1.3.1",
        os: "macos",
        installer: "dmg",
        count: 2,
      },
    ]);
    expect(frameRows()).toEqual([
      { hash: hashOf(FRAMES), frames: JSON.stringify(FRAMES), first_day: today },
    ]);
  });

  it("stores '' for a missing extension and accepts 'other'", async () => {
    const other = ["load_song", "src-tauri/src/m4a.rs:39"];
    await post(batch([errorCount()], [trace(), trace({ frames: other, ext: "other" })]));
    expect(stored().map((r) => r.ext)).toEqual([
      hashOf(FRAMES) < hashOf(other) ? "" : "other",
      hashOf(FRAMES) < hashOf(other) ? "other" : "",
    ]);
  });

  it("groups by hash and adds the counts up over batches", async () => {
    await post(batch([errorCount()], [trace({ count: 2 })]));
    await post(batch([errorCount()], [trace({ count: 3 })]));
    await post(batch([errorCount()], [trace({ ext: "wav" })]));
    expect(stored().map((r) => [r.ext, r.count])).toEqual([
      ["", 5],
      ["wav", 1],
    ]);
    expect(frameRows()).toHaveLength(1);
  });

  it("keeps different versions, systems and installers apart", async () => {
    await post(batch([errorCount()], [trace()]));
    await post(batch([errorCount()], [trace()], { version: "1.4.0" }));
    await post(batch([errorCount()], [trace()], { os: "windows", installer: "windows" }));
    expect(stored()).toHaveLength(3);
    expect(frameRows()).toHaveLength(1);
  });

  it("answers an old-shape batch (no traces) exactly as before", async () => {
    const response = await post(batch([errorCount("audio:io", 4)]));
    expect(response.status).toBe(200);
    expect(counted()).toEqual([{ event: "error", format: "audio:io", count: 4 }]);
    expect(stored()).toEqual([]);
    expect(frameRows()).toEqual([]);
    expect((await post(batch([errorCount()], []))).status).toBe(200);
  });

  it("still rejects an unknown top-level key", async () => {
    expect((await post(batch([errorCount()], [trace()], { stack: "boom" }))).status).toBe(400);
    expect((await post(batch([errorCount()], [trace()], { trace: [] }))).status).toBe(400);
    expect(counted()).toEqual([]);
    expect(stored()).toEqual([]);
  });

  it("drops a trace for an event other than error: the batch is accepted", async () => {
    const response = await post(
      batch(
        [{ day: today, event: "panic", format: "audio", count: 1 }],
        [trace({ format: "audio" }), trace({ format: "export" })],
      ),
    );
    expect(response.status).toBe(200);
    expect(counted()).toEqual([{ event: "panic", format: "audio", count: 1 }]);
    expect(stored()).toEqual([]);
  });

  it("drops traces with a bad shape and still counts the error", async () => {
    const bad = [
      trace({ hash: "0123456789abcde" }), // 15 hex
      trace({ hash: "0123456789ABCDEF" }), // upper case
      trace({ hash: "zzzzzzzzzzzzzzzz" }),
      trace({ hash: undefined }),
      trace({ day: "yesterday" }),
      trace({ day: "2020-01-01" }),
      trace({ day: "2999-01-01" }),
      trace({ format: "audio" }),
      trace({ format: "audio:foo" }),
      trace({ format: undefined }),
      trace({ ext: "My Song.gp5" }),
      trace({ ext: "exe" }),
      trace({ ext: 5 }),
      trace({ count: 0 }),
      trace({ count: 1.5 }),
      trace({ count: 10_000_000 }),
      trace({ frames: [] }),
      trace({ frames: "audio_start" }),
      trace({ frames: [5] }),
      trace({ frames: Array.from({ length: MAX_FRAMES + 1 }, (_, i) => `fn_${i}`) }),
      trace({ user: "jane" }),
      trace({ message: "failed to open /Users/jane/My Song.gp5" }),
      "audio_start",
      null,
      [],
    ];
    for (const one of bad) {
      expect((await post(batch([errorCount()], [one]))).status, JSON.stringify(one)).toBe(200);
    }
    expect(stored()).toEqual([]);
    expect(frameRows()).toEqual([]);
    expect(counted()).toEqual([{ event: "error", format: "audio:audio", count: bad.length }]);
  });

  it("drops a trace whose hash does not match its frames", async () => {
    const other = hashOf(["something_else", "src/audio/mod.rs:1"]);
    await post(batch([errorCount()], [trace({ hash: other })]));
    expect(stored()).toEqual([]);
    expect(counted()).toEqual([{ event: "error", format: "audio:audio", count: 1 }]);
  });

  it("hashes only the top two frames", async () => {
    const frames = [...FRAMES, "src/a.ts:1:1", "src/b.ts:2:2"];
    await post(batch([errorCount()], [trace({ frames, hash: hashOf(FRAMES) })]));
    expect(stored()).toHaveLength(1);
    expect(JSON.parse(frameRows()[0].frames as string)).toEqual(frames);
    // The same command and origin with other JS frames (another release) is the same group.
    const otherRelease = ["audio_start", "src/audio/mod.rs:123", "index-XyZ789.js:1:99"];
    await post(batch([errorCount()], [trace({ frames: otherRelease })]));
    expect(stored()).toHaveLength(1);
    expect(stored()[0].count).toBe(2);
    // A different origin is another group.
    await post(batch([errorCount()], [trace({ frames: ["audio_start", "src/audio/mod.rs:124"] })]));
    expect(stored()).toHaveLength(2);
    // A hash over three frames no longer matches and is dropped.
    const three = createHash("sha256").update(FRAMES.join("\n")).digest("hex").slice(0, 16);
    await post(batch([errorCount()], [trace({ frames: FRAMES, hash: three })]));
    expect(stored()).toHaveLength(2);
  });

  it("drops traces with long, path-like, URL, e-mail or user-name frames, but counts the error", async () => {
    const frames: string[][] = [
      ["audio_start", "/Users/jane/Music/My Song.gp5"],
      ["audio_start", "C:\\Users\\jane\\Music\\song.gp5"],
      ["audio_start", "src/../../etc/passwd"],
      ["audio_start", "/Users/jane/Documents/smart-beat/src/audio/mod.rs:12"],
      ["audio_start", "file:///Users/jane/Music/song.gp5"],
      ["audio_start", "tauri://localhost/index-AbC123.js:1:2"],
      ["audio_start", "https://example.com/a.js:1:2"],
      ["audio_start", "http://192.168.1.20:8787/index.js:3:4"],
      ["audio_start", "jane@example.com"],
      ["audio_start", "startPlayback index.js?token=abc:1:2"],
      ["audio_start", "src/lib/tauri.ts#frag"],
      ["audio_start", "app.local 10.0.0.12"],
      ["audio_start", "10.0.0.12"],
      ["audio_start", "AbCdEfGhIjKlMnOpQrStUvWxYz0123"],
      ["audio_start", `src/${"a".repeat(80)}.rs:1`],
      ["failed to open the file My Secret Song.gp5"],
      ["Error: ENOENT: no such file"],
      ["audio_start", "x".repeat(101)],
      ["audio_start", "src/audio/mod.rs:1234567"],
      ["audio_start", "src/audio/mod.rs:1:2:3"],
      ["audio_start", "docs/audio.rs:1"],
      ["audio_start", ""],
    ];
    for (const list of frames) {
      expect((await post(batch([errorCount()], [trace({ frames: list })]))).status).toBe(200);
    }
    expect(stored()).toEqual([]);
    expect(frameRows()).toEqual([]);
    expect(counted()).toEqual([{ event: "error", format: "audio:audio", count: frames.length }]);
  });

  it("keeps the good traces of a batch when another one is bad", async () => {
    const good = ["load_song", "src-tauri/src/m4a.rs:39"];
    await post(
      batch(
        [errorCount()],
        [
          trace({ frames: ["/Users/jane/x.rs:1"], hash: hashOf(["/Users/jane/x.rs:1"]) }),
          trace({ frames: good }),
        ],
      ),
    );
    expect(stored().map((r) => r.hash)).toEqual([hashOf(good)]);
  });

  it("accepts the frame shapes of the contract", () => {
    for (const frame of [
      "audio_start",
      "src/audio/mod.rs:123",
      "src-tauri/src/m4a.rs:39",
      "startPlayback index-AbC123.js:1:48211",
      "src/lib/tauri.ts:650:12",
      "index-AbC123.js",
      "closure<T>.run-1",
      "$fn",
      "main.rs:9",
    ]) {
      expect(validFrame(frame), frame).toBe(true);
    }
    for (const frame of ["", "1abc", "a b", "src/audio/mod.rs: 1", " src/a.rs:1", "/src/a.rs:1"]) {
      expect(validFrame(frame), frame).toBe(false);
    }
  });

  it("drops traces beyond the batch limit but keeps the first ones", async () => {
    const many = Array.from({ length: MAX_TRACES + 5 }, (_, i) => {
      const frames = [`fn_${i}`];
      return trace({ frames });
    });
    expect((await post(batch([errorCount()], many))).status).toBe(200);
    expect(stored()).toHaveLength(MAX_TRACES);
    expect(stored().map((r) => r.hash)).toContain(hashOf(["fn_0"]));
    expect(stored().map((r) => r.hash)).not.toContain(hashOf([`fn_${MAX_TRACES + 1}`]));
  });

  it("caps the distinct hashes per day, but still adds to a hash already stored", async () => {
    const make = (n: number) => trace({ frames: [`fn_${n}`] });
    const first = Array.from({ length: MAX_TRACE_HASHES_PER_DAY }, (_, i) => make(i));
    for (let i = 0; i < first.length; i += MAX_TRACES) {
      await post(batch([errorCount()], first.slice(i, i + MAX_TRACES)));
    }
    expect(stored()).toHaveLength(MAX_TRACE_HASHES_PER_DAY);
    // One new hash is over the cap and dropped; an existing one still counts up.
    const response = await post(batch([errorCount()], [make(100_000), make(0)]));
    expect(response.status).toBe(200);
    expect(stored()).toHaveLength(MAX_TRACE_HASHES_PER_DAY);
    expect(stored().find((r) => r.hash === hashOf(["fn_0"]))?.count).toBe(2);
    expect(stored().some((r) => r.hash === hashOf(["fn_100000"]))).toBe(false);
    // Another day has its own cap.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await post(batch([errorCount()], [{ ...make(100_000), day: yesterday }]));
    expect(stored().some((r) => r.hash === hashOf(["fn_100000"]))).toBe(true);
    // The errors themselves were always counted.
    expect(counted()[0].count).toBe(Math.ceil(MAX_TRACE_HASHES_PER_DAY / MAX_TRACES) + 2);
  });

  it("writes the traces and the counters in one batch: a failing trace write stores neither", async () => {
    sqlite.exec("DROP TABLE trace_frames");
    await expect(post(batch([errorCount()], [trace()]))).rejects.toThrow();
    expect(counted()).toEqual([]);
  });

  it("keeps the counters when the traces cannot be read", async () => {
    sqlite.exec("DROP TABLE error_traces");
    sqlite.exec("DROP TABLE trace_frames");
    // The existing-hash lookup fails, so traces are skipped and the counters are stored.
    expect((await post(batch([errorCount()], [trace()]))).status).toBe(200);
    expect(counted()).toEqual([{ event: "error", format: "audio:audio", count: 1 }]);
  });

  it("stores no IP address, user agent or request time with a trace", async () => {
    await post(batch([errorCount()], [trace()]));
    const columns = (table: string) =>
      sqlite
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);
    expect(columns("error_traces")).toEqual([
      "day",
      "hash",
      "format",
      "ext",
      "version",
      "os",
      "installer",
      "count",
    ]);
    expect(columns("trace_frames")).toEqual(["hash", "frames", "first_day"]);
    expect(columns("daily_counts")).toEqual([
      "day",
      "event",
      "format",
      "version",
      "os",
      "installer",
      "count",
    ]);
  });
});

describe("GET /v1/summary top_errors", () => {
  const get = (query = "?days=7") =>
    worker.fetch(
      new Request(`https://x.test/v1/summary${query}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      env,
    );
  type Top = { format: string; hash: string; frames: string[]; ext: string; count: number };

  it("is empty without traces", async () => {
    await post(batch([errorCount()]));
    const body = (await (await get()).json()) as { top_errors: Top[] };
    expect(body.top_errors).toEqual([]);
  });

  it("lists the error groups with parsed frames, biggest first", async () => {
    const rare = ["load_song", "src-tauri/src/m4a.rs:39"];
    await post(
      batch(
        [errorCount()],
        [trace({ count: 5 }), trace({ frames: rare, format: "file:io", count: 2 })],
      ),
    );
    await post(batch([errorCount()], [trace({ count: 4, ext: "mp3" })]));
    const body = (await (await get()).json()) as { top_errors: Top[]; events: unknown[] };
    expect(body.top_errors).toEqual([
      { format: "audio:audio", hash: hashOf(FRAMES), frames: FRAMES, ext: "", count: 5 },
      { format: "audio:audio", hash: hashOf(FRAMES), frames: FRAMES, ext: "mp3", count: 4 },
      { format: "file:io", hash: hashOf(rare), frames: rare, ext: "", count: 2 },
    ]);
    expect(body.events).toEqual([{ key: "error", count: 2 }]);
  });

  it("returns the top 20 inside the window only", async () => {
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
    const traces = Array.from({ length: 25 }, (_, i) =>
      trace({ frames: [`fn_${i}`], count: i + 1 }),
    );
    await post(batch([errorCount()], traces));
    await post(batch([errorCount()], [trace({ frames: ["old_fn"], day: old, count: 999 })]));
    const body = (await (await get("?days=7")).json()) as { top_errors: Top[] };
    expect(body.top_errors).toHaveLength(20);
    expect(body.top_errors[0].frames).toEqual(["fn_24"]);
    expect(body.top_errors[0].count).toBe(25);
    expect(body.top_errors.some((t) => t.frames[0] === "old_fn")).toBe(false);
    const wide = (await (await get("?days=30")).json()) as { top_errors: Top[] };
    expect(wide.top_errors[0].frames).toEqual(["old_fn"]);
  });
});

describe("retention of error traces", () => {
  const insertTrace = (day: string, hash: string) => {
    sqlite.prepare("INSERT OR IGNORE INTO trace_frames VALUES (?, '[\"fn\"]', ?)").run(hash, day);
    sqlite
      .prepare(
        "INSERT INTO error_traces VALUES (?, ?, 'audio:audio', '', '1.0.0', 'macos', 'dmg', 1)",
      )
      .run(day, hash);
  };

  it("deletes traces older than six months and the frames nothing uses any more", async () => {
    insertTrace("2026-03-01", "aaaaaaaaaaaaaaaa"); // old only
    insertTrace("2026-04-30", "bbbbbbbbbbbbbbbb"); // kept
    insertTrace("2026-03-01", "cccccccccccccccc"); // old, but seen again recently
    insertTrace("2026-09-30", "cccccccccccccccc");
    await cleanup(env, new Date("2026-10-10T03:17:00Z"));
    expect(stored().map((r) => [r.day, r.hash])).toEqual([
      ["2026-04-30", "bbbbbbbbbbbbbbbb"],
      ["2026-09-30", "cccccccccccccccc"],
    ]);
    expect(frameRows().map((r) => r.hash)).toEqual(["bbbbbbbbbbbbbbbb", "cccccccccccccccc"]);
  });

  it("runs from the daily cron trigger", async () => {
    insertTrace("2000-01-01", "dddddddddddddddd");
    await worker.scheduled({} as ScheduledController, env);
    expect(stored()).toEqual([]);
    expect(frameRows()).toEqual([]);
  });
});

describe("migration 0002", () => {
  it("has the migrations in order and upgrading from 0001 keeps the counters", async () => {
    expect(migrationFiles()).toEqual(["0001_counters.sql", "0002_error_traces.sql"]);
    const old = fakeD1(["0001_counters.sql"]);
    old.sqlite
      .prepare(
        "INSERT INTO daily_counts VALUES (?, 'error', 'audio:audio', '1.2.0', 'macos', 'dmg', 7)",
      )
      .run(today);
    old.sqlite.exec(migrationSql("0002_error_traces.sql"));
    expect(
      old.sqlite
        .prepare("SELECT event, format, count FROM daily_counts")
        .all()
        .map((r) => ({ ...r })),
    ).toEqual([{ event: "error", format: "audio:audio", count: 7 }]);
    expect(old.sqlite.prepare("SELECT COUNT(*) AS n FROM error_traces").get()).toEqual({ n: 0 });
    // The upgraded database takes a trace.
    const upgraded: Env = { DB: old.db };
    const response = await worker.fetch(
      new Request("https://x.test/v1/batch", {
        method: "POST",
        body: JSON.stringify(batch([errorCount()], [trace()])),
      }),
      upgraded,
    );
    expect(response.status).toBe(200);
    expect(
      old.sqlite
        .prepare("SELECT count FROM daily_counts")
        .all()
        .map((r) => r.count),
    ).toEqual([7, 1]);
    expect(old.sqlite.prepare("SELECT COUNT(*) AS n FROM error_traces").get()).toEqual({ n: 1 });
  });

  it("indexes error_traces by day", () => {
    const index = sqlite
      .prepare("PRAGMA index_list(error_traces)")
      .all()
      .map((i) => i.name);
    expect(index).toContain("error_traces_day");
  });
});
