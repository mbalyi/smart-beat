/**
 * Crash reports for the UI (docs/crash-reports.md), on unless the user switched them off. Errors
 * only: the Sentry client is
 * configured with no default integrations except the global error and unhandled-rejection
 * handlers, and no replay, screenshots, tracing, logs, profiling, breadcrumbs or feedback widget.
 * Every event goes through the allow-list in `crash-scrub.ts` before it can leave.
 *
 * Nothing is loaded or initialised while the user has not opted in, while the build has no UI DSN,
 * or while the core says crash reports are not available. Switching the setting off closes the
 * client at once, and what was queued is dropped, not flushed.
 */
import type * as SentryBrowser from "@sentry/browser";
import type { BrowserOptions } from "@sentry/browser";

import { scrubCrashEvent, type CrashContext, type CrashOs } from "@/lib/crash-scrub";
import { APP_VERSION } from "@/lib/project-info";
import {
  getCrashReportSettings,
  setCrashReportSettings,
  type CrashReportSettings,
} from "@/lib/tauri";

declare global {
  interface Window {
    /** Development builds only (tests): a stand-in for the UI DSN. Never read in a release build. */
    __sentryTestDsn?: string;
  }
}

type SentrySdk = typeof SentryBrowser;
type SentryClient = NonNullable<ReturnType<SentrySdk["init"]>>;
type SentryTransport = ReturnType<NonNullable<BrowserOptions["transport"]>>;
type Envelope = Parameters<SentryTransport["send"]>[0];

/** The DSN of the UI's Sentry project (a build variable), or `undefined` when the build has none. */
export function crashReportDsn(): string | undefined {
  const test = import.meta.env.DEV ? window.__sentryTestDsn : undefined;
  return test || import.meta.env.VITE_SENTRY_DSN_FRONTEND || undefined;
}

/** The operating system family (never a version), or `undefined` when it is not one of three. */
export function detectOs(userAgent: string = navigator.userAgent): CrashOs | undefined {
  if (/Windows/i.test(userAgent)) return "windows";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "macos";
  if (/Linux|X11/i.test(userAgent) && !/Android/i.test(userAgent)) return "linux";
  return undefined;
}

export function crashContext(): CrashContext {
  return {
    release: APP_VERSION,
    environment: import.meta.env.PROD ? "production" : "development",
    os: detectOs(),
  };
}

/** Whether reports may be sent now: the user opted in, the build can send, the UI has a DSN. */
export function shouldSendCrashReports(settings: CrashReportSettings | null): boolean {
  return Boolean(settings?.enabled && settings.available && crashReportDsn());
}

/** True while a client may send; set to false the moment the user switches reports off. */
export interface CrashSession {
  live: boolean;
}

/** An envelope that holds error events only (no session, attachment, replay, log or report). */
function onlyErrorEvents(envelope: Envelope): boolean {
  return envelope[1].every(([header]) => header.type === "event");
}

/**
 * The whole Sentry configuration. Everything not named here stays at the SDK's own default,
 * which is off for tracing, replay, logs and profiling; `crash-reports.test.ts` checks the options.
 */
export function crashReportOptions(
  dsn: string,
  session: CrashSession,
  sdk: Pick<SentrySdk, "globalHandlersIntegration" | "makeFetchTransport">,
): BrowserOptions {
  const context = crashContext();
  return {
    dsn,
    release: context.release,
    environment: context.environment,
    // No default integrations: no breadcrumbs, console capture, http context, sessions or culture.
    defaultIntegrations: false,
    integrations: [sdk.globalHandlersIntegration()],
    // The SDK's switches for personal data: none of it is collected.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    maxBreadcrumbs: 0,
    attachStacktrace: false,
    sendClientReports: false,
    beforeSend: (event) =>
      session.live ? (scrubCrashEvent(event, context) as unknown as typeof event | null) : null,
    transport: (options) => {
      const inner = sdk.makeFetchTransport(options);
      return {
        send: (envelope) =>
          session.live && onlyErrorEvents(envelope) ? inner.send(envelope) : Promise.resolve({}),
        flush: (timeout) => inner.flush(timeout),
      };
    },
  };
}

let wanted = false;
let running: { client: SentryClient; session: CrashSession; sdk: SentrySdk } | null = null;
let starting: Promise<void> | null = null;

async function start(): Promise<void> {
  if (running) return;
  starting ??= (async () => {
    try {
      const dsn = crashReportDsn();
      if (!dsn) return;
      const sdk = await import("@sentry/browser");
      // The user may have switched reports off while the SDK was loading.
      if (!wanted || running) return;
      const session: CrashSession = { live: true };
      const client = sdk.init(crashReportOptions(dsn, session, sdk));
      if (client) running = { client, session, sdk };
    } finally {
      starting = null;
    }
  })();
  await starting;
}

/** Stops sending now: events already queued are dropped, not flushed. */
function stop(): void {
  const current = running;
  running = null;
  if (!current) return;
  current.session.live = false;
  current.client.getOptions().enabled = false;
  current.sdk.getCurrentScope().setClient(undefined);
  void Promise.resolve(current.client.close(0)).catch(() => {});
}

/**
 * Brings the client in line with the stored setting: starts it when reports are on and possible,
 * and closes it when they are not.
 */
export async function applyCrashReportSettings(settings: CrashReportSettings | null) {
  wanted = shouldSendCrashReports(settings);
  if (wanted) await start().catch(() => {});
  else stop();
}

/** Reads the setting from the core and applies it. Call once at startup, before the app renders. */
export async function initCrashReports(): Promise<void> {
  await applyCrashReportSettings(await getCrashReportSettings().catch(() => null));
}

/**
 * The Settings switch: turning reports off stops the UI client first, then stores the choice; a
 * stored choice that did not go through is re-read, so the client never runs against the setting.
 */
export async function setCrashReports(enabled: boolean): Promise<CrashReportSettings> {
  if (!enabled) await applyCrashReportSettings({ enabled: false, available: true });
  try {
    const stored = await setCrashReportSettings(enabled);
    await applyCrashReportSettings(stored);
    return stored;
  } catch (error) {
    await initCrashReports();
    throw error;
  }
}
