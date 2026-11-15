import { EVENTS, EVENT_DETAILS, FORMATS, INSTALLERS, OSES } from "./events";

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
/** Counters (and error traces) are kept this long. */
export const RETENTION_MONTHS = 6;
/** Most error traces in one request; the rest are dropped. */
export const MAX_TRACES = 100;
/** Most frames in one trace. */
export const MAX_FRAMES = 8;
/** Most different trace hashes kept for one day; later ones are dropped (the error is still counted). */
export const MAX_TRACE_HASHES_PER_DAY = 200;
/** Error groups in the summary. */
const TOP_ERRORS = 20;

const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

interface Entry {
  day: string;
  event: string;
  format: string;
  count: number;
}

/** An anonymised error trace (#242): scrubbed by the app, checked again here. */
export interface Trace {
  day: string;
  format: string;
  hash: string;
  frames: string[];
  /** A known file extension, "other", or "" when there is none. */
  ext: string;
  count: number;
}

interface Batch {
  version: string;
  os: string;
  installer: string;
  counts: Entry[];
  traces: Trace[];
}

// A frame is a function-like name, a location, or both with one space between (see the frame grammar
// in docs/analytics.md). A location is an app-relative path or a bundle file name, with an optional
// line and column. Nothing else (no message text, no user path, no URL) matches.
const NAME = "[A-Za-z_$][A-Za-z0-9_$<>.-]{0,59}";
const LOCATION =
  "(?:(?:src|src-tauri/src)/[A-Za-z0-9_./-]{1,80}|[A-Za-z0-9_-]{1,40}\\.(?:js|mjs|ts|tsx|rs))(?::[0-9]{1,6}){0,2}";
const FRAME = new RegExp(`^(?:${NAME}|${LOCATION}|${NAME} ${LOCATION})$`);
const MAX_FRAME_LENGTH = 100;
const HASH = /^[0-9a-f]{16}$/;
const IPV4_LIKE = /\d+\.\d+\.\d+\.\d+/;
const LONG_RUN = /[A-Za-z0-9]{24,}/;
const FRAME_BANNED = ["@", "\\", "..", "://", "?", "#"];
const TRACE_KEYS = ["day", "format", "hash", "frames", "ext", "count"];
const ERROR_DETAILS: readonly string[] = EVENT_DETAILS.error ?? [];
const TRACE_EXTS: readonly string[] = [...FORMATS, "other"];

/** Whether one frame is allowed: the grammar plus the extra rejections (paths, e-mail, URLs, IPs, tokens). */
export function validFrame(frame: unknown): frame is string {
  return (
    typeof frame === "string" &&
    frame.length <= MAX_FRAME_LENGTH &&
    FRAME.test(frame) &&
    !FRAME_BANNED.some((part) => frame.includes(part)) &&
    !IPV4_LIKE.test(frame) &&
    !LONG_RUN.test(frame)
  );
}

/** First 16 hex characters of SHA-256 of the top 2 frames (command and Rust origin: the JS frames change with every release), one per line (the app computes the same). */
export async function traceHash(frames: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(frames.slice(0, 2).join("\n")),
  );
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const bad = (message: string): Response => json({ error: message }, 400);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const has = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && list.includes(value as T);

/** `YYYY-MM-DD` of `now` shifted by `days`. */
const dayOffset = (now: Date, days: number): string =>
  new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);

/** Checks the request body. Returns the cleaned batch, or an error message. */
export function validate(input: unknown, now = new Date()): Batch | string {
  if (!isRecord(input)) return "Expected a JSON object.";
  const allowed = ["version", "os", "installer", "counts", "traces"];
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
    if (format !== undefined && !has(EVENT_DETAILS[event] ?? [], format)) return "Unknown format.";
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
  return {
    version,
    os,
    installer,
    counts: cleaned,
    traces: cleanTraces(input.traces, oldest, newest),
  };
}

/**
 * The traces of a batch that have the right shape. A trace that does not is dropped, never an error:
 * the error counters of the same batch are still stored. The hash is checked later (`verifyTraces`).
 */
function cleanTraces(input: unknown, oldest: string, newest: string): Trace[] {
  if (!Array.isArray(input)) return [];
  const cleaned: Trace[] = [];
  for (const entry of input.slice(0, MAX_TRACES)) {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !TRACE_KEYS.includes(key))) continue;
    const { day, format, hash, frames, ext, count } = entry;
    if (typeof day !== "string" || !DAY.test(day) || Number.isNaN(Date.parse(day))) continue;
    if (day < oldest || day > newest) continue;
    if (typeof format !== "string" || !ERROR_DETAILS.includes(format)) continue;
    if (typeof hash !== "string" || !HASH.test(hash)) continue;
    if (!Array.isArray(frames) || frames.length < 1 || frames.length > MAX_FRAMES) continue;
    if (!frames.every(validFrame)) continue;
    if (ext !== undefined && (typeof ext !== "string" || !TRACE_EXTS.includes(ext))) continue;
    if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_COUNT) {
      continue;
    }
    cleaned.push({
      day,
      format,
      hash,
      frames: frames as string[],
      ext: (ext as string | undefined) ?? "",
      count: count as number,
    });
  }
  return cleaned;
}

/** Keeps the traces whose hash is the one this Worker computes from their frames. */
export async function verifyTraces(traces: Trace[]): Promise<Trace[]> {
  const checked = await Promise.all(
    traces.map(async (trace) => ((await traceHash(trace.frames)) === trace.hash ? trace : null)),
  );
  return checked.filter((trace): trace is Trace => trace !== null);
}

const UPSERT = `INSERT INTO daily_counts (day, event, format, version, os, installer, count)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
ON CONFLICT (day, event, format, version, os, installer) DO UPDATE SET count = count + excluded.count`;

const UPSERT_TRACE = `INSERT INTO error_traces (day, hash, format, ext, version, os, installer, count)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
ON CONFLICT (day, hash, format, ext, version, os, installer) DO UPDATE SET count = count + excluded.count`;

const INSERT_FRAMES = `INSERT OR IGNORE INTO trace_frames (hash, frames, first_day) VALUES (?1, ?2, ?3)`;

/**
 * The traces to store: hash checked, and at most MAX_TRACE_HASHES_PER_DAY different hashes per day
 * (a hash already stored for that day always fits). The rest are dropped.
 */
async function storableTraces(batch: Batch, env: Env): Promise<Trace[]> {
  const verified = await verifyTraces(batch.traces);
  if (verified.length === 0) return [];
  const known = new Map<string, Set<string>>();
  try {
    for (const day of new Set(verified.map((t) => t.day))) {
      const stored = await env.DB.prepare("SELECT DISTINCT hash FROM error_traces WHERE day = ?1")
        .bind(day)
        .all<{ hash: string }>();
      known.set(day, new Set(stored.results.map((row) => row.hash)));
    }
  } catch {
    return []; // Traces are optional: never lose the counters over them.
  }
  return verified.filter((trace) => {
    const hashes = known.get(trace.day) as Set<string>;
    if (hashes.has(trace.hash)) return true;
    if (hashes.size >= MAX_TRACE_HASHES_PER_DAY) return false;
    hashes.add(trace.hash);
    return true;
  });
}

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
  const traces = await storableTraces(batch, env);
  // Only the counters and the anonymised traces are written: no IP address, user agent or request
  // time is stored. One batch, so a trace is never stored without its counter.
  await env.DB.batch([
    ...batch.counts.map((c) =>
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
    ...traces.flatMap((t) => [
      env.DB.prepare(INSERT_FRAMES).bind(t.hash, JSON.stringify(t.frames), t.day),
      env.DB.prepare(UPSERT_TRACE).bind(
        t.day,
        t.hash,
        t.format,
        t.ext,
        batch.version,
        batch.os,
        batch.installer,
        t.count,
      ),
    ]),
  ]);
  return json({ ok: true });
}

/** Constant-time comparison of two strings. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseFrames(stored: string | null): string[] {
  try {
    const frames: unknown = JSON.parse(stored ?? "[]");
    return Array.isArray(frames) ? frames.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
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
  const top = (
    await env.DB.prepare(
      `SELECT t.format AS format, t.hash AS hash, f.frames AS frames, t.ext AS ext, SUM(t.count) AS count
FROM error_traces t LEFT JOIN trace_frames f ON f.hash = t.hash
WHERE t.day >= ?1 GROUP BY t.format, t.hash, t.ext ORDER BY count DESC, t.hash LIMIT ${TOP_ERRORS}`,
    )
      .bind(since)
      .all<{ format: string; hash: string; frames: string | null; ext: string; count: number }>()
  ).results;
  const top_errors = top.map((row) => ({
    format: row.format,
    hash: row.hash,
    frames: parseFrames(row.frames),
    ext: row.ext,
    count: row.count,
  }));
  return json({ since, events, formats, installers, oses, versions, top_errors });
}

/** Deletes counters and error traces older than the retention period, and frames nothing points to. */
export async function cleanup(env: Env, now = new Date()): Promise<void> {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RETENTION_MONTHS);
  const day = cutoff.toISOString().slice(0, 10);
  await env.DB.prepare("DELETE FROM daily_counts WHERE day < ?1").bind(day).run();
  await env.DB.prepare("DELETE FROM error_traces WHERE day < ?1").bind(day).run();
  await env.DB.prepare(
    "DELETE FROM trace_frames WHERE hash NOT IN (SELECT hash FROM error_traces)",
  ).run();
}

export { json, receive, summary };
