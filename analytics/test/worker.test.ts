import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { ERROR_AREAS, ERROR_KINDS, EVENTS, EVENT_DETAILS } from "../src/events";
import worker from "../src/index";
import { cleanup, MAX_ENTRIES, type Env } from "../src/logic";
import { fakeD1 } from "./d1";

const today = new Date().toISOString().slice(0, 10);
const TOKEN = "s3cret-token";

let env: Env;
let sqlite: ReturnType<typeof fakeD1>["sqlite"];

beforeEach(() => {
  const fake = fakeD1();
  sqlite = fake.sqlite;
  env = { DB: fake.db, ANALYTICS_SUMMARY_TOKEN: TOKEN };
});

const batch = (counts: unknown[] = [{ day: today, event: "loop_on", count: 2 }], extra = {}) => ({
  version: "1.2.3",
  os: "macos",
  installer: "dmg",
  counts,
  ...extra,
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  worker.fetch(
    new Request("https://x.test/v1/batch", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers,
    }),
    env,
  );

const rows = () =>
  sqlite.prepare("SELECT * FROM daily_counts ORDER BY event, format").all() as Array<{
    event: string;
    day: string;
  }>;

describe("POST /v1/batch", () => {
  it("counts valid events and adds up repeated batches", async () => {
    expect((await post(batch())).status).toBe(200);
    expect((await post(batch())).status).toBe(200);
    expect(rows()).toEqual([
      {
        day: today,
        event: "loop_on",
        format: "",
        version: "1.2.3",
        os: "macos",
        installer: "dmg",
        count: 4,
      },
    ]);
  });

  it("keeps the format of open_file and export", async () => {
    await post(batch([{ day: today, event: "export", format: "pdf", count: 1 }]));
    expect(rows()).toMatchObject([{ event: "export", format: "pdf" }]);
  });

  it("accepts the selection and restart-after-Stop events (#92, #93)", async () => {
    const events = [
      "shift_select",
      "copy",
      "cut",
      "delete_selection",
      "loop_selection",
      "practise_selection",
      "play_selection",
      "restart_on_stop_on",
      "restart_on_stop_off",
      "restart_on_stop_used",
    ];
    await post(batch(events.map((event) => ({ day: today, event, count: 1 }))));
    expect(
      rows()
        .map((row) => row.event)
        .sort(),
    ).toEqual([...events].sort());
  });

  it("accepts the Record to Tab event", async () => {
    await post(batch([{ day: today, event: "record_to_tab", count: 1 }]));
    expect(rows()).toMatchObject([{ event: "record_to_tab" }]);
  });

  it("rejects unknown events, formats, installers, systems and versions", async () => {
    for (const body of [
      batch([{ day: today, event: "my_song_title", count: 1 }]),
      batch([{ day: today, event: "export", format: "../etc", count: 1 }]),
      batch(undefined, { installer: "evil" }),
      batch(undefined, { installer: "dev" }),
      batch(undefined, { os: "plan9" }),
      batch(undefined, { version: "1.0 <script>" }),
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(rows()).toEqual([]);
  });

  it("rejects extra fields so nothing identifying can be smuggled in", async () => {
    expect((await post(batch(undefined, { installId: "abc" }))).status).toBe(400);
    expect((await post(batch([{ day: today, event: "play", count: 1, user: "me" }]))).status).toBe(
      400,
    );
    expect(rows()).toEqual([]);
  });

  it("rejects bad days, counts and sizes", async () => {
    for (const counts of [
      [{ day: "2020-01-01", event: "play", count: 1 }],
      [{ day: "2999-01-01", event: "play", count: 1 }],
      [{ day: "yesterday", event: "play", count: 1 }],
      [{ day: today, event: "play", count: 0 }],
      [{ day: today, event: "play", count: 1.5 }],
      [{ day: today, event: "play", count: 10_000_000 }],
      [],
      Array.from({ length: MAX_ENTRIES + 1 }, () => ({ day: today, event: "play", count: 1 })),
    ]) {
      expect((await post(batch(counts))).status).toBe(400);
    }
    expect((await post("not json")).status).toBe(400);
    expect((await post("[]")).status).toBe(400);
    expect((await post("x".repeat(200_000))).status).toBe(413);
  });

  it("stores no IP address, user agent or request time", async () => {
    await post(batch(), { "cf-connecting-ip": "203.0.113.9", "user-agent": "Smart Beat/1.2.3" });
    const columns = sqlite
      .prepare("PRAGMA table_info(daily_counts)")
      .all()
      .map((c) => c.name);
    expect(columns).toEqual(["day", "event", "format", "version", "os", "installer", "count"]);
    expect(JSON.stringify(rows())).not.toContain("203.0.113.9");
    expect(JSON.stringify(rows())).not.toContain("Smart Beat/1.2.3");
  });

  it("only accepts POST on /v1/batch and knows no other paths", async () => {
    expect((await worker.fetch(new Request("https://x.test/v1/batch"), env)).status).toBe(405);
    expect((await worker.fetch(new Request("https://x.test/other"), env)).status).toBe(404);
  });
});

describe("GET /v1/summary", () => {
  const get = (token?: string, query = "") =>
    worker.fetch(
      new Request(`https://x.test/v1/summary${query}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
      env,
    );

  it("needs the token", async () => {
    expect((await get()).status).toBe(401);
    expect((await get("wrong")).status).toBe(401);
    env.ANALYTICS_SUMMARY_TOKEN = undefined;
    expect((await get(TOKEN)).status).toBe(401);
  });

  it("returns aggregates by event, installer, os and version", async () => {
    await post(
      batch([
        { day: today, event: "loop_on", count: 3 },
        { day: today, event: "export", format: "pdf", count: 1 },
      ]),
    );
    await post({
      ...batch([{ day: today, event: "loop_on", count: 2 }]),
      installer: "windows",
      os: "windows",
    });
    const response = await get(TOKEN, "?days=7");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, { key: string; count: number }[]>;
    expect(body.events).toEqual([
      { key: "loop_on", count: 5 },
      { key: "export", count: 1 },
    ]);
    expect(body.formats).toEqual([{ key: "export pdf", count: 1 }]);
    expect(body.installers).toEqual([
      { key: "dmg", count: 4 },
      { key: "windows", count: 2 },
    ]);
    expect(body.oses.map((o) => o.key).sort()).toEqual(["macos", "windows"]);
    expect(body.versions).toEqual([{ key: "1.2.3", count: 6 }]);
  });
});

describe("retention", () => {
  it("deletes counters older than six months and keeps newer ones", async () => {
    const insert = sqlite.prepare(
      "INSERT INTO daily_counts VALUES (?, 'play', '', '1.0.0', 'macos', 'dmg', 1)",
    );
    insert.run("2026-03-01");
    insert.run("2026-04-30");
    insert.run("2026-09-30");
    await cleanup(env, new Date("2026-10-10T03:17:00Z"));
    expect(rows().map((r) => r.day)).toEqual(["2026-04-30", "2026-09-30"]);
  });

  it("runs from the daily cron trigger", async () => {
    sqlite
      .prepare(
        "INSERT INTO daily_counts VALUES ('2000-01-01', 'play', '', '1.0.0', 'macos', 'dmg', 1)",
      )
      .run();
    await worker.scheduled({} as ScheduledController, env);
    expect(rows()).toEqual([]);
  });
});

describe("entry module", () => {
  it("exports only the handler: the Workers runtime refuses anything else", async () => {
    const entry = await import("../src/index");
    expect(Object.keys(entry)).toEqual(["default"]);
  });
});

describe("event details", () => {
  it("accepts every event with no detail and each of its fixed details", async () => {
    for (const event of EVENTS) {
      for (const format of [undefined, ...(EVENT_DETAILS[event] ?? [])]) {
        expect((await post(batch([{ day: today, event, format, count: 1 }]))).status).toBe(200);
      }
    }
  });
  it("rejects free text and details belonging to other events", async () => {
    for (const [event, format] of [
      ["pedal_add", "vst3"],
      ["plugin_add", "amp"],
      ["record_to_tab", "gp5"],
      ["copy_to_instrument", "My instrument"],
      ["audio_input_change", "USB device"],
      ["plugin_editor_open", "/Library/private.vst3"],
      ["play", "pdf"],
      ["soundfont_select", "My Bank.sf2"],
      ["play_soundfont", "stored:my-bank"],
      ["soundfont_download", "custom"],
      ["soundfont_import", "custom"],
      ["record_to_tab_start", "violin"],
      ["record_to_tab_file", "gp5"],
      ["ai_install", "huge"],
      ["ai_transcribe_start", "maybe"],
      ["ai_rights_confirmed", "yes"],
      ["tour_start", "secret"],
      ["tour_finish", "My tour"],
      ["drum_normalize", "pdf"],
      ["practice_speed", "75"],
      ["error", "audio"],
      ["error", "audio:"],
      ["error", "foo:io"],
      ["error", "audio:foo"],
      ["error", "audio:io:extra"],
      ["error", "/Users/jane/My Song.gp5"],
      ["error", "Disk on fire"],
      ["panic", "audio:io"],
      ["panic", "thread 'main' panicked at src/audio/engine.rs:12"],
      ["panic", "/Users/jane"],
      ["play", "audio:io"],
      ["export", "audio"],
    ]) {
      expect((await post(batch([{ day: today, event, format, count: 1 }]))).status).toBe(400);
    }
  });
});

describe("error and panic counters", () => {
  it("stores an error per area and kind and a panic per area, nothing else", async () => {
    const response = await post(
      batch([
        { day: today, event: "error", format: "audio:not-found", count: 3 },
        { day: today, event: "error", format: "cloud:unknown", count: 1 },
        { day: today, event: "panic", format: "stems", count: 2 },
        { day: today, event: "panic", count: 1 },
      ]),
    );
    expect(response.status).toBe(200);
    const stored = sqlite
      .prepare("SELECT event, format, count FROM daily_counts ORDER BY event, format")
      .all();
    expect(stored.map((r) => ({ ...r }))).toEqual([
      { event: "error", format: "audio:not-found", count: 3 },
      { event: "error", format: "cloud:unknown", count: 1 },
      { event: "panic", format: "", count: 1 },
      { event: "panic", format: "stems", count: 2 },
    ]);
  });
  it("has 10 areas and 14 kinds, and error takes each combination once", () => {
    expect(ERROR_AREAS).toHaveLength(10);
    expect(ERROR_KINDS).toHaveLength(14);
    expect(EVENT_DETAILS.error).toHaveLength(140);
    expect(new Set(EVENT_DETAILS.error).size).toBe(140);
    expect(EVENT_DETAILS.panic).toEqual([...ERROR_AREAS]);
  });
  it("lists the same areas and kinds as the app", () => {
    // The app refuses what the Worker would refuse and the other way round: keep them equal.
    const rust = readFileSync(new URL("../../src-tauri/src/telemetry.rs", import.meta.url), "utf8");
    const listed = (name: string) => {
      const body = new RegExp(`pub const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\]`).exec(rust);
      expect(body, name).not.toBeNull();
      return [...body![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    };
    expect(listed("ERROR_AREAS")).toEqual([...ERROR_AREAS]);
    expect(listed("ERROR_KINDS")).toEqual([...ERROR_KINDS]);
  });
});
