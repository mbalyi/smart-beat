import pkg from "../../package.json";

/**
 * Crash reports are errors only (docs/crash-reports.md): no session replay, screen or video capture,
 * screenshots, tracing, performance, profiling, logs, user-feedback widget or breadcrumbs. These
 * tests fail when one of those is installed, imported or configured, even with a rate of 0.
 */
const sources = import.meta.glob(["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const FORBIDDEN = [
  /replayIntegration/,
  /replayCanvasIntegration/,
  /replaysSessionSampleRate/,
  /replaysOnErrorSampleRate/,
  /feedbackIntegration/,
  /feedbackAsyncIntegration/,
  /feedbackSyncIntegration/,
  /captureFeedback/,
  /sendFeedback/,
  /showReportDialog/,
  /browserTracingIntegration/,
  /tracesSampleRate/,
  /tracesSampler/,
  /tracePropagationTargets/,
  /browserProfilingIntegration/,
  /profilesSampleRate/,
  /profileSessionSampleRate/,
  /consoleLoggingIntegration/,
  /captureConsoleIntegration/,
  /breadcrumbsIntegration/,
  /addBreadcrumb/,
  /enableLogs/,
  /enableMetrics/,
  /browserSessionIntegration/,
  /httpContextIntegration/,
  /httpClientIntegration/,
  /contextLinesIntegration/,
  /attachScreenshot/,
  /getDisplayMedia/,
  /@sentry\/(?:replay|feedback|replay-canvas|react|tracing|profiling)/,
];

describe("crash reports stay errors only", () => {
  it("finds the application sources it scans", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(Object.keys(sources)).toContain("/src/lib/crash-reports.ts");
  });

  it("uses no replay, feedback, tracing, profiling, logs, breadcrumbs or screenshot API", () => {
    const found: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      for (const word of FORBIDDEN) {
        if (word.test(text)) found.push(`${file}: ${word.source}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("imports the Sentry SDK in one place only, by its smallest browser package", () => {
    const importers = Object.entries(sources)
      .filter(([, text]) => /@sentry\//.test(text))
      .map(([file]) => file)
      .sort();
    expect(importers).toEqual(["/src/lib/crash-reports.ts"]);
    const imported = [
      ...sources["/src/lib/crash-reports.ts"]!.matchAll(/["'](@sentry\/[^"']+)["']/g),
    ];
    expect(new Set(imported.map((m) => m[1]))).toEqual(new Set(["@sentry/browser"]));
  });

  it("declares no Sentry package but @sentry/browser", () => {
    const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) =>
      name.startsWith("@sentry/"),
    );
    expect(declared).toEqual(["@sentry/browser"]);
  });
});
