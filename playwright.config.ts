import { defineConfig, devices } from "@playwright/test";

const PORT = 1420;
// Explicit IPv4 host: "localhost" may resolve to ::1 only, which stalls the readiness check.
const HOST = "127.0.0.1";
const isCI = Boolean(process.env.CI);

/**
 * Browser integration tests. They run the real UI in Chromium (Windows uses
 * WebView2) and WebKit (macOS WKWebView, Linux WebKitGTK) with the Tauri IPC
 * mocked in the page (see e2e/fixtures.ts).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  globalTimeout: 15 * 60_000,
  retries: isCI ? 2 : 0,
  workers: isCI ? 2 : undefined,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://${HOST}:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    // Run Vite directly: `pnpm dev` does not forward the shutdown signal.
    command: `node node_modules/vite/bin/vite.js --host ${HOST}`,
    url: `http://${HOST}:${PORT}`,
    reuseExistingServer: !isCI,
    timeout: 60_000,
  },
});
