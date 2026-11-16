/**
 * What a crash report may hold (docs/crash-reports.md). The scrubber is an allow-list: it builds a
 * new event from the few fields below and drops everything else, so a field the SDK adds later is
 * never sent by accident. It is pure (no Tauri, no SDK imports), and the Rust core applies the same
 * rules in `src-tauri/src/crash_scrub.rs`.
 *
 * Kept: the exception type, the stack frames (function name and location), the release (the app
 * version), the environment, the tag `os` and the SDK name and version. A location is an
 * app-relative path (`src/...`, `src-tauri/src/...`) or the file name of a built bundle
 * (`index-AbC123.js`), with line and column.
 *
 * Dropped: exception and event messages, user, IP address, request, breadcrumbs, contexts, extra,
 * every other tag, modules, attachments, local variables, and any URL, absolute path, user name,
 * e-mail address, IPv4 address or long token. A frame that is not valid is dropped, and an event
 * with no frame left is dropped.
 */

export type CrashOs = "macos" | "windows" | "linux";

export interface CrashContext {
  /** The app version. */
  release: string;
  environment: "production" | "development";
  /** The operating system family; no version. */
  os?: CrashOs;
}

export interface ScrubbedFrame {
  filename: string;
  function?: string;
  lineno?: number;
  colno?: number;
}

export interface ScrubbedEvent {
  event_id?: string;
  timestamp?: number;
  platform: "javascript";
  level: "error";
  release: string;
  environment: string;
  server_name: "";
  tags?: { os: CrashOs };
  sdk?: { name: string; version?: string; settings: { infer_ip: "never" } };
  exception: { values: { type: string; stacktrace: { frames: ScrubbedFrame[] } }[] };
}

/** A path inside this repository: the UI sources or the core sources. */
const APP_PATH = /^(?:src|src-tauri\/src)(?:\/[A-Za-z0-9_.-]+)+$/;

/** A built file: a name, a dash and the content hash (`index-AbC123.js`). */
const BUNDLE_NAME = /^[A-Za-z0-9_.-]{1,80}-[A-Za-z0-9_-]{6,16}\.m?js$/;

/** Schemes the webview serves the app from; the host of such a URL is never kept. */
const WEB_SCHEME = /^(?:https?|tauri|asset):\/\//i;
const ANY_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** A function name: words and dots, with the few words a browser puts in front or instead. */
const FUNCTION_NAME =
  /^(?:(?:async|new|get|set) )?[\w$.<>[\]]{1,200}$|^(?:global|eval|module) code$/;
const EXCEPTION_TYPE = /^[A-Za-z_$][\w$.]{0,63}$/;
const SDK_NAME = /^[\w./@-]{1,64}$/;
const SDK_VERSION = /^[\w.+-]{1,32}$/;
const EVENT_ID = /^[0-9a-f]{32}$/i;

const MAX_FRAMES = 100;
const MAX_NUMBER = 10_000_000;

/**
 * Text that must never leave the computer: a URL, an e-mail address, an IPv4 address, a path with
 * a user name, or a token (24 or more letters and digits in a row).
 */
function looksPrivate(text: string): boolean {
  return (
    ANY_SCHEME.test(text) ||
    text.includes("://") ||
    /[\w.+-]+@[\w-]+\.[\w.-]+/.test(text) ||
    /\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(text) ||
    /[A-Za-z0-9]{24,}/.test(text) ||
    /(?:^|[\\/])(?:Users|home)[\\/]/i.test(text) ||
    /^[A-Za-z]:[\\/]/.test(text) ||
    text.includes("\\")
  );
}

/**
 * The location a frame is allowed to carry, or `null` when it has none. Query strings and hashes go
 * first. A URL of the app (`tauri://localhost/assets/index-AbC123.js`, the dev server) only ever
 * contributes its path, never its host. Anything else (a `file:` URL, an absolute path, the page
 * URL) is not a valid location.
 */
export function scrubFilename(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1000) return null;
  let path = raw.split(/[?#]/, 1)[0] ?? "";

  if (ANY_SCHEME.test(path)) {
    if (!WEB_SCHEME.test(path)) return null;
    const afterHost = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*(\/.*)?$/.exec(path);
    path = afterHost?.[1] ?? "";
    if (!path.startsWith("/")) return null;
    path = path.slice(1);
  } else if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) {
    return null;
  }

  if (path.split("/").includes("..")) return null;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const found = APP_PATH.test(path) ? path : BUNDLE_NAME.test(name) ? name : null;
  return found !== null && !looksPrivate(found) ? found : null;
}

function scrubFunction(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !FUNCTION_NAME.test(raw) || looksPrivate(raw)) return undefined;
  return raw;
}

function position(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < MAX_NUMBER
    ? raw
    : undefined;
}

function scrubFrame(raw: unknown): ScrubbedFrame | null {
  if (typeof raw !== "object" || raw === null) return null;
  const frame = raw as Record<string, unknown>;
  const filename = scrubFilename(frame.filename);
  if (filename === null) return null;
  const clean: ScrubbedFrame = { filename };
  const name = scrubFunction(frame.function);
  if (name !== undefined) clean.function = name;
  const lineno = position(frame.lineno);
  if (lineno !== undefined) clean.lineno = lineno;
  const colno = position(frame.colno);
  if (colno !== undefined) clean.colno = colno;
  return clean;
}

function scrubException(raw: unknown): ScrubbedEvent["exception"]["values"][number] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const exception = raw as { type?: unknown; stacktrace?: { frames?: unknown } | null };
  const frames = exception.stacktrace?.frames;
  if (!Array.isArray(frames)) return null;
  const kept = frames
    .map(scrubFrame)
    .filter((frame): frame is ScrubbedFrame => frame !== null)
    .slice(-MAX_FRAMES);
  if (kept.length === 0) return null;
  const type =
    typeof exception.type === "string" &&
    EXCEPTION_TYPE.test(exception.type) &&
    !looksPrivate(exception.type)
      ? exception.type
      : "Error";
  return { type, stacktrace: { frames: kept } };
}

/**
 * Turns an SDK event into the allowed crash report, or `null` when nothing of it may be sent.
 * `sdk.settings.infer_ip: "never"` tells the server not to look up the sender's IP address.
 */
export function scrubCrashEvent(input: unknown, context: CrashContext): ScrubbedEvent | null {
  if (typeof input !== "object" || input === null) return null;
  const event = input as Record<string, unknown>;
  const rawExceptions = (event.exception as { values?: unknown } | undefined)?.values;
  if (!Array.isArray(rawExceptions)) return null;
  const values = rawExceptions
    .map(scrubException)
    .filter((value): value is NonNullable<typeof value> => value !== null);
  if (values.length === 0) return null;

  const clean: ScrubbedEvent = {
    platform: "javascript",
    level: "error",
    release: context.release,
    environment: context.environment,
    server_name: "",
    exception: { values },
  };
  if (typeof event.event_id === "string" && EVENT_ID.test(event.event_id)) {
    clean.event_id = event.event_id;
  }
  if (typeof event.timestamp === "number" && Number.isFinite(event.timestamp)) {
    clean.timestamp = event.timestamp;
  }
  if (context.os) clean.tags = { os: context.os };
  const sdk = event.sdk as { name?: unknown; version?: unknown } | undefined;
  if (typeof sdk?.name === "string" && SDK_NAME.test(sdk.name)) {
    clean.sdk = { name: sdk.name, settings: { infer_ip: "never" } };
    if (typeof sdk.version === "string" && SDK_VERSION.test(sdk.version)) {
      clean.sdk.version = sdk.version;
    }
  }
  return clean;
}
