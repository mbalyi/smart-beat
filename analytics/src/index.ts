import { EVENTS, FORMATS, INSTALLERS, OSES } from "./events";

export interface Env {
  DB: D1Database;
  ANALYTICS_SUMMARY_TOKEN?: string;
}

/** Most entries in one request (MAX_ENTRIES in src-tauri/src/telemetry.rs). */
export const MAX_ENTRIES = 500;
/** Largest request body in bytes. */
export const MAX_BODY = 128 * 1024;
/** Counters older than this many days (or from the future) are refused. */
const MAX_AGE_DAYS = 35;
/** Largest count one entry may carry. */
const MAX_COUNT = 100_000;
/** Counters are kept this long. */
export const RETENTION_MONTHS = 6;

const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

interface Entry {
  day: string;
  event: string;
  format: string;
  count: number;
}

interface Batch {
  version: string;
  os: string;
  installer: string;
  counts: Entry[];
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const bad = (message: string): Response => json({ error: message }, 400);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const has = (list: readonly string[], value: unknown): value is string =>
  typeof value === "string" && list.includes(value);

/** `YYYY-MM-DD` of `now` shifted by `days`. */
const dayOffset = (now: Date, days: number): string =>
  new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);

/** Checks the request body. Returns the cleaned batch, or an error message. */
export function validate(input: unknown, now = new Date()): Batch | string {
  if (!isRecord(input)) return "Expected a JSON object.";
  const allowed = ["version", "os", "installer", "counts"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) return "Unknown field.";
  const { version, os, installer, counts } = input;
  if (typeof version !== "string" || !VERSION.test(version)) return "Bad version.";
  if (!has(OSES, os)) return "Bad os.";
  if (!has(INSTALLERS, installer)) return "Bad installer.";
  if (!Array.isArray(counts) || counts.length === 0) return "No counts.";
  if (counts.length > MAX_ENTRIES) return "Too many counts.";
  const oldest = dayOffset(now, -MAX_AGE_DAYS);
  const newest = dayOffset(now, 1);
  const cleaned: Entry[] = [];
  for (const entry of counts) {
    if (!isRecord(entry)) return "Bad count entry.";
    if (Object.keys(entry).some((key) => !["day", "event", "format", "count"].includes(key))) {
      return "Unknown field in a count entry.";
    }
    const { day, event, format, count } = entry;
    if (typeof day !== "string" || !DAY.test(day)) return "Bad day.";
    if (Number.isNaN(Date.parse(day)) || day < oldest || day > newest) return "Day out of range.";
    if (!has(EVENTS, event)) return "Unknown event.";
    if (format !== undefined && !has(FORMATS, format)) return "Unknown format.";
    if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_COUNT) {
      return "Bad count.";
    }
    cleaned.push({
      day,
      event,
      format: (format as string | undefined) ?? "",
      count: count as number,
    });
  }
  return { version, os, installer, counts: cleaned };
}

const UPSERT = `INSERT INTO daily_counts (day, event, format, version, os, installer, count)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
ON CONFLICT (day, event, format, version, os, installer) DO UPDATE SET count = count + excluded.count`;

async function receive(request: Request, env: Env): Promise<Response> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY) return json({ error: "Too large." }, 413);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: "Too large." }, 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return bad("Invalid JSON.");
  }
  const batch = validate(parsed);
  if (typeof batch === "string") return bad(batch);
  // Only the counters are written: no IP address, user agent or request time is stored.
  await env.DB.batch(
    batch.counts.map((c) =>
      env.DB.prepare(UPSERT).bind(
        c.day,
        c.event,
        c.format,
        batch.version,
        batch.os,
        batch.installer,
        c.count,
      ),
    ),
  );
  return json({ ok: true });
}

/** Constant-time comparison of two strings. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function summary(request: Request, env: Env): Promise<Response> {
  const expected = env.ANALYTICS_SUMMARY_TOKEN;
  const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!expected || !given || !same(given, expected)) return json({ error: "Unauthorized." }, 401);
  const url = new URL(request.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? "30") || 30, 1), 200);
  const since = dayOffset(new Date(), -days);
  const rows = async (column: string) =>
    (
      await env.DB.prepare(
        `SELECT ${column} AS key, SUM(count) AS count FROM daily_counts WHERE day >= ?1 GROUP BY ${column} ORDER BY count DESC`,
      )
        .bind(since)
        .all<{ key: string; count: number }>()
    ).results;
  const [events, installers, oses, versions] = await Promise.all([
    rows("event"),
    rows("installer"),
    rows("os"),
    rows("version"),
  ]);
  const formats = (
    await env.DB.prepare(
      `SELECT event || ' ' || format AS key, SUM(count) AS count FROM daily_counts WHERE day >= ?1 AND format != '' GROUP BY event, format ORDER BY count DESC`,
    )
      .bind(since)
      .all<{ key: string; count: number }>()
  ).results;
  return json({ since, events, formats, installers, oses, versions });
}

/** Deletes counters older than the retention period. */
export async function cleanup(env: Env, now = new Date()): Promise<void> {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RETENTION_MONTHS);
  await env.DB.prepare("DELETE FROM daily_counts WHERE day < ?1")
    .bind(cutoff.toISOString().slice(0, 10))
    .run();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/v1/batch") {
      return request.method === "POST" ? receive(request, env) : json({ error: "Use POST." }, 405);
    }
    if (pathname === "/v1/summary") {
      return request.method === "GET" ? summary(request, env) : json({ error: "Use GET." }, 405);
    }
    return json({ error: "Not found." }, 404);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await cleanup(env);
  },
} satisfies ExportedHandler<Env>;
