import { defineConfig, devices } from "@playwright/test";

const PORT = 1420;
// Explicit IPv4 host: "localhost" may resolve to ::1 only, which stalls the readiness check.
const HOST = "127.0.0.1";
const isCI = Boolean(process.env.CI);

/**
 * CI runs two jobs per browser so neither hits a timeout (one serial run of everything took
 * over an hour in WebKit): "smoke" is the core flows, "additional" the guided-tour tests.
 * `E2E_GROUP` picks one; unset runs everything (local `pnpm test:e2e`).
 */
const ADDITIONAL_SPECS = ["**/tour*.spec.ts"];
const group = process.env.E2E_GROUP || undefined;
if (group !== undefined && group !== "smoke" && group !== "additional") {
  throw new Error(`E2E_GROUP must be "smoke" or "additional", not "${group}".`);
}
const GROUP_TIMEOUT_MINUTES = { smoke: 50, additional: 40 } as const;

/**
 * Browser integration tests. They run the real UI in Chromium (Windows uses
 * WebView2) and WebKit (macOS WKWebView, Linux WebKitGTK) with the Tauri IPC
 * mocked in the page (see e2e/fixtures.ts).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  // The whole run. WebKit on CI renders in software, one test at a time: about an hour for
  // everything, so CI runs the two groups as separate jobs.
  globalTimeout: (group ? GROUP_TIMEOUT_MINUTES[group] : 75) * 60_000,
  ...(group === "smoke" && { testIgnore: ADDITIONAL_SPECS }),
  ...(group === "additional" && { testMatch: ADDITIONAL_SPECS }),
  retries: isCI ? 2 : 0,
  // One test at a time on CI: every song test synthesizes audio in real time,
  // and parallel tests on a 2-core runner starve each other's audio and
  // rendering (in WebKit's software renderer especially).
  workers: isCI ? 1 : undefined,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://${HOST}:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        // "Desktop Safari" renders at 2x. Headless WebKit on Linux (CI) then
        // produces ~1 animation frame per second, so every click waits seconds
        // for the element to be "stable" and tests time out. Layout and
        // behaviour are the same at 1x, and no screenshots are compared.
        deviceScaleFactor: 1,
      },
      // CI's headless WebKit renders in software and runs several times slower
      // than on a Mac; the longer song tests need more than the default 30 s.
      ...(isCI && { timeout: 90_000, expect: { timeout: 15_000 } }),
    },
  ],
  webServer: {
    // Run Vite directly: `pnpm dev` does not forward the shutdown signal.
    command: `node node_modules/vite/bin/vite.js --host ${HOST}`,
    url: `http://${HOST}:${PORT}`,
    reuseExistingServer: !isCI,
    timeout: 60_000,
  },
});
