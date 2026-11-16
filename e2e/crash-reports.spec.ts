import type { Page } from "@playwright/test";

import { expect, expectNoA11yViolations, test } from "./fixtures";

/**
 * Opt-in crash reports (docs/crash-reports.md). Nothing here reaches the network: every request
 * to a Sentry host is answered by the test, which also records it. The DSN is a stand-in that only
 * development builds read (`window.__sentryTestDsn`).
 */

const TEST_DSN = "https://0123456789abcdef@o1.ingest.de.sentry.io/1";

interface SentryRequest {
  url: string;
  body: string;
}

/** Answers every request to a Sentry host and records it. */
async function captureSentry(app: Page) {
  const requests: SentryRequest[] = [];
  await app.route(/sentry\.io/, async (route) => {
    requests.push({ url: route.request().url(), body: route.request().postData() ?? "" });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: "{}",
    });
  });
  return requests;
}

/** Throws an uncaught error whose stack holds private places and one frame of the app. */
async function crash(app: Page) {
  await app.evaluate(() => {
    const error = new Error(
      "Cannot open /Users/jane/Music/My Secret Song.gp5 for jane@example.com",
    );
    error.name = "TypeError";
    error.stack = [
      "TypeError: Cannot open /Users/jane/Music/My Secret Song.gp5",
      "    at openSong (http://127.0.0.1:1420/src/lib/score/player.ts?t=9:10:5)",
      "    at readIt (file:///Users/jane/x.js:1:1)",
      "    at Object.<anonymous> (C:\\Users\\jane\\x.js:2:2)",
      "    at go (tauri://localhost/index.html:3:3)",
      "    at fetchIt (https://x.test/a?token=abc123:4:4)",
    ].join("\n");
    setTimeout(() => {
      throw error;
    }, 0);
  });
}

/** Throws errors until the client (it loads after the switch is turned on) has sent one. */
async function crashUntilSent(app: Page, requests: SentryRequest[]) {
  await expect
    .poll(
      async () => {
        await crash(app);
        return eventsOf(requests).length;
      },
      { intervals: [250, 500, 1000], timeout: 15_000 },
    )
    .toBeGreaterThan(0);
}

/** The error events in the recorded envelopes. */
function eventsOf(requests: SentryRequest[]) {
  return requests.flatMap(({ body }) =>
    body
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((part) =>
        Array.isArray((part.exception as { values?: unknown } | undefined)?.values),
      ),
  );
}

const envelopeTypes = (requests: SentryRequest[]) =>
  requests.flatMap(({ body }) =>
    body
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string })
      .filter((part) => typeof part.type === "string")
      .map((part) => part.type),
  );

const FORBIDDEN = [
  "jane",
  "/users",
  "secret song",
  ".gp5",
  "token",
  "x.test",
  "file://",
  "tauri://",
  "127.0.0.1",
  "example.com",
];

async function openSettings(app: Page) {
  await app.getByRole("button", { name: "Help" }).click();
  await app.getByRole("menuitem", { name: "Settings" }).click();
  return app.getByRole("dialog", { name: "Settings" });
}

test.describe("opt-in crash reports", () => {
  test.beforeEach(async ({ app }) => {
    await app.evaluate((dsn) => {
      window.__sentryTestDsn = dsn;
      window.__crashReports = { enabled: false, available: true };
    }, TEST_DSN);
  });

  test("while the switch is off, an error sends nothing to any Sentry host", async ({ app }) => {
    const requests = await captureSentry(app);
    const dialog = await openSettings(app);
    await expect(dialog.getByRole("switch", { name: "Send crash reports" })).not.toBeChecked();
    await dialog.getByRole("button", { name: "Close" }).last().click();

    await crash(app);
    await crash(app);
    await app.waitForTimeout(1500);
    expect(requests).toEqual([]);
  });

  test("switching on sends scrubbed error events only, switching off stops them", async ({
    app,
  }) => {
    const requests = await captureSentry(app);
    const dialog = await openSettings(app);
    const toggle = dialog.getByRole("switch", { name: "Send crash reports" });
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect.poll(() => app.evaluate(() => window.__crashReports.enabled)).toBe(true);
    await dialog.getByRole("button", { name: "Close" }).last().click();

    await crashUntilSent(app, requests);
    expect(requests.every(({ url }) => new URL(url).host.endsWith(".ingest.de.sentry.io"))).toBe(
      true,
    );

    // Only error events: no session, replay, attachment or client report.
    expect(new Set(envelopeTypes(requests))).toEqual(new Set(["event"]));
    const [event] = eventsOf(requests) as {
      exception: { values: { type: string; stacktrace: { frames: unknown[] } }[] };
      server_name: string;
      tags: Record<string, string>;
    }[];
    expect(event!.exception.values).toHaveLength(1);
    expect(event!.exception.values[0]!.type).toBe("TypeError");
    expect(event!.exception.values[0]!.stacktrace.frames).toEqual([
      { filename: "src/lib/score/player.ts", function: "openSong", lineno: 10, colno: 5 },
    ]);
    expect(event!.server_name).toBe("");
    expect(Object.keys(event!.tags)).toEqual(["os"]);
    const sent = requests
      .map(({ body }) => body)
      .join("\n")
      .toLowerCase();
    for (const word of FORBIDDEN) expect(sent).not.toContain(word);
    for (const key of ["user", "request", "breadcrumbs", "contexts", "extra", "message"]) {
      expect(event).not.toHaveProperty(key);
    }

    // Off again: later errors are not sent.
    const again = await openSettings(app);
    await again.getByRole("switch", { name: "Send crash reports" }).click();
    await expect.poll(() => app.evaluate(() => window.__crashReports.enabled)).toBe(false);
    await again.getByRole("button", { name: "Close" }).last().click();
    const before = eventsOf(requests).length;
    await crash(app);
    await app.waitForTimeout(1500);
    expect(eventsOf(requests)).toHaveLength(before);
  });

  test("an app that starts with the setting on sends the error", async ({ app }) => {
    const requests = await captureSentry(app);
    await app.addInitScript((dsn) => {
      window.__sentryTestDsn = dsn;
      window.__crashReports = { enabled: true, available: true };
    }, TEST_DSN);
    await app.reload();
    await expect(app.getByRole("heading", { level: 1 })).toBeVisible();
    await crashUntilSent(app, requests);
  });

  test("without a core DSN the switch is not offered and nothing is sent", async ({ app }) => {
    const requests = await captureSentry(app);
    await app.evaluate(() => {
      window.__crashReports = { enabled: true, available: false };
    });
    const dialog = await openSettings(app);
    await expect(dialog).toContainText("does not send crash reports");
    await expect(dialog.getByRole("switch", { name: "Send crash reports" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close" }).last().click();
    await app.reload();
    await expect(app.getByRole("heading", { level: 1 })).toBeVisible();
    await crash(app);
    await app.waitForTimeout(1500);
    expect(requests).toEqual([]);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the crash reports switch has no WCAG violations in ${colorScheme} mode`, async ({
      app,
    }) => {
      await app.emulateMedia({ colorScheme });
      if (colorScheme === "dark") await expect(app.locator("html")).toHaveClass(/dark/);
      else await expect(app.locator("html")).not.toHaveClass(/dark/);
      const dialog = await openSettings(app);
      const toggle = dialog.getByRole("switch", { name: "Send crash reports" });
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAccessibleDescription(/never makes screenshots/);
      await expectNoA11yViolations(app);

      await toggle.click();
      await expect(toggle).toBeChecked();
      await expectNoA11yViolations(app);
    });
  }
});
