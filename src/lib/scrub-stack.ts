/**
 * Anonymised code locations for the `error` usage counter (docs/analytics.md, #242). A failed
 * command is sent with a short "trace" of frames: the command name, the Rust origin (`file:line`
 * inside the app) and a few JavaScript call sites. Everything that could identify a person is
 * dropped here, before it leaves the page: the error message, absolute paths and user names, URLs
 * with queries or tokens, and the names of the user's own files.
 *
 * What is kept is a function name or an app-relative location (`src/lib/tauri.ts:650:12`, or the
 * bundle's file name such as `index-AbC123.js:1:48211`). The frame grammar and the reject rules
 * are shared with `src-tauri/src/scrub.rs` and the analytics worker, which both check them again.
 *
 * This module imports nothing from the Tauri bridge or the telemetry module, so both can use it.
 */

/** File formats that may accompany `open_file` and `export`, and an error trace (`FORMATS` in telemetry.rs). */
export const FILE_FORMATS = [
  "gp3",
  "gp4",
  "gp5",
  "gpx",
  "gp",
  "mid",
  "midi",
  "pdf",
  "wav",
  "m4a",
  "mp3",
  "musicxml",
  "ogg",
  "flac",
  "txt",
  "png",
];

/** How many JavaScript call sites are kept after the command name and the Rust origin. */
export const MAX_JS_FRAMES = 5;
/** The longest trace: the command, the Rust origin and the JavaScript call sites. */
export const MAX_FRAMES = 8;
/** The longest frame. */
export const MAX_FRAME_LENGTH = 100;

const NAME = "[A-Za-z_$][A-Za-z0-9_$<>.-]{0,59}";
const PATH = "(?:src|src-tauri/src)/[A-Za-z0-9_./-]{1,80}";
const BASEFILE = "[A-Za-z0-9_-]{1,40}\\.(?:js|mjs|ts|tsx|rs)";
const LOC = `(?:${PATH}|${BASEFILE})(?::[0-9]{1,6}){0,2}`;

const NAME_RE = new RegExp(`^${NAME}$`);
const PATH_RE = new RegExp(`^${PATH}$`);
const BASEFILE_RE = new RegExp(`^${BASEFILE}$`);
const LOC_RE = new RegExp(`^${LOC}$`);
const FRAME_RE = new RegExp(`^(?:${NAME}|${LOC}|${NAME} ${LOC})$`);

/** Never allowed in a frame, whatever the grammar says. */
const FORBIDDEN_RE = /[@\\?#]|\.\.|:\/\/|\d+\.\d+\.\d+\.\d+|[A-Za-z0-9]{24,}/;

/** Whether a string is a frame that may be sent: the grammar, plus the extra reject rules. */
export function isValidFrame(frame: unknown): frame is string {
  return (
    typeof frame === "string" &&
    frame.length > 0 &&
    frame.length <= MAX_FRAME_LENGTH &&
    !FORBIDDEN_RE.test(frame) &&
    FRAME_RE.test(frame)
  );
}

/** Whether a string is a bare location (`src/audio/mod.rs:123`), the shape of a Rust `origin`. */
export function isValidLocation(value: unknown): value is string {
  return isValidFrame(value) && LOC_RE.test(value);
}

/** A function name, or `""` when it is not one that may be sent. */
function cleanName(raw: string): string {
  const name = raw
    .trim()
    .replace(/\s*\[as [^\]]*\]$/, "")
    .replace(/^(?:async|new)\s+/, "");
  return NAME_RE.test(name) ? name : "";
}

/**
 * The safe part of a call site's location: the app-relative path when the file lives under a
 * `src/` directory (a dev server or a source checkout), else the bundle's file name; always with
 * the line and column. Anything else (a host, a user directory, a query) is dropped.
 */
function cleanLocation(raw: string): string {
  const match = /^(.*?)(?::(\d{1,6}))?(?::(\d{1,6}))?$/.exec(raw.trim());
  if (!match) return "";
  const [, target = "", line, column] = match;
  const path = (target.split(/[?#]/)[0] ?? "").replaceAll("\\", "/");

  let place = "";
  const at = path.startsWith("src/") ? 0 : path.lastIndexOf("/src/") + 1;
  if (path.startsWith("src/") || at > 0) {
    const relative = path.slice(at);
    if (PATH_RE.test(relative) && !relative.includes("..")) place = relative;
  }
  if (!place) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (BASEFILE_RE.test(base)) place = base;
  }
  if (!place) return "";
  return `${place}${line ? `:${line}` : ""}${line && column ? `:${column}` : ""}`;
}

/** One frame from a function name and a location, or `""` when nothing safe is left. */
function frameOf(rawName: string, rawLocation: string): string {
  const name = cleanName(rawName);
  const location = cleanLocation(rawLocation);
  for (const candidate of [`${name} ${location}`.trim(), location, name]) {
    if (candidate && isValidFrame(candidate)) return candidate;
  }
  return "";
}

/** A V8 line (`at fn (url:1:2)`, `at url:1:2`, `at async fn (url:1:2)`). */
function parseV8(line: string): string {
  const match = /^\s*at\s+(.+)$/.exec(line);
  if (!match?.[1]) return "";
  const body = match[1];
  const wrapped = /^(.+?)\s+\((.+)\)$/.exec(body);
  return wrapped ? frameOf(wrapped[1] ?? "", wrapped[2] ?? "") : frameOf("", body);
}

/** A WebKit/Safari/Firefox line (`fn@url:1:2`, `@url:1:2`). */
function parseWebKit(line: string): string {
  const at = line.indexOf("@");
  if (at < 0) return "";
  const rawName = line.slice(0, at);
  // A name that is not one (a message such as "Error: mail jane@x") is not a call site.
  if (
    rawName.trim() !== "" &&
    cleanName(rawName) === "" &&
    !/^(?:global|module|eval) code$/.test(rawName.trim())
  )
    return "";
  return frameOf(rawName, line.slice(at + 1));
}

/**
 * The call sites of a JavaScript stack, scrubbed: V8 (`at fn (url:l:c)`) and WebKit (`fn@url:l:c`)
 * lines, without the message line, and at most `max` frames. Lines that cannot be made safe are
 * dropped. `skip` leaves out the first call sites, such as the error counter's own.
 */
export function scrubStack(stack: unknown, skip = 0, max = MAX_JS_FRAMES): string[] {
  if (typeof stack !== "string") return [];
  const lines = stack.split(/\r?\n/).slice(0, 200);
  // V8 stacks start with the message line; only their `at` lines are call sites.
  const v8 = lines.some((line) => /^\s+at\s/.test(line));
  const frames: string[] = [];
  let seen = 0;
  for (const line of lines) {
    if (v8 ? !/^\s+at\s/.test(line) : !line.includes("@")) continue;
    if (seen++ < skip) continue;
    const frame = v8 ? parseV8(line) : parseWebKit(line);
    if (frame) frames.push(frame);
    if (frames.length >= max) break;
  }
  return frames;
}

/**
 * The lowercase extension of the file a command works on, when one of its arguments is a path:
 * only an extension from the known formats, otherwise `other`. The file name is never kept.
 * `undefined` when no argument looks like a path.
 */
export function extensionOf(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  for (const [key, value] of Object.entries(args)) {
    if (!/path|file/i.test(key) || typeof value !== "string" || value === "") continue;
    const name = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1);
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    return FILE_FORMATS.includes(ext) ? ext : "other";
  }
  return undefined;
}

/** The Rust `origin` of a rejection, if it is a valid location. Never reads the message. */
export function originOf(error: unknown): string | undefined {
  const origin =
    typeof error === "object" && error !== null
      ? (error as { origin?: unknown }).origin
      : undefined;
  return isValidLocation(origin) ? origin : undefined;
}

/** What `track_event` takes for an error: the frames and, for file failures, the extension. */
export interface ErrorTrace {
  frames: string[];
  ext?: string;
}

/**
 * The trace of a failed command: the command name, the Rust origin and the scrubbed JavaScript
 * call sites, in that order. `undefined` when no frame is left.
 */
export function buildTrace(parts: {
  command: string;
  error: unknown;
  args?: unknown;
  stack?: unknown;
  skip?: number;
}): ErrorTrace | undefined {
  const frames: string[] = [];
  if (isValidFrame(parts.command)) frames.push(parts.command);
  const origin = originOf(parts.error);
  if (origin) frames.push(origin);
  frames.push(...scrubStack(parts.stack, parts.skip ?? 0));
  if (frames.length === 0) return undefined;
  const ext = extensionOf(parts.args);
  return { frames: frames.slice(0, MAX_FRAMES), ...(ext ? { ext } : {}) };
}
