import { defineConfig, devices } from "@playwright/test";

import {
  CI_GROUPS,
  FEATURE_GROUPS,
  FEATURE_SPECS,
  SMOKE_GROUPS,
  type FeatureGroup,
  type SmokeGroup,
} from "./e2e/groups";

const PORT = 1420;
// Explicit IPv4 host: "localhost" may resolve to ::1 only, which stalls the readiness check.
const HOST = "127.0.0.1";
const isCI = Boolean(process.env.CI);

/**
 * CI runs one job per group and browser, so a slow group never runs out of time (one serial run
 * of everything took over an hour in WebKit, and a single "additional" group of the feature specs
 * later did the same). The groups are in `e2e/groups.ts`: the core flows ("smoke") are every spec
 * in no feature group, split by theme into the `smoke-*` groups; a feature group is a list of spec
 * globs. `E2E_GROUP` picks one; "smoke" is a local shortcut for all the smoke themes together and
 * "additional" for all the feature groups together; unset runs everything (local
 * `pnpm test:e2e`).
 */
const group = process.env.E2E_GROUP || undefined;
const LOCAL_SHORTCUTS = ["smoke", "additional"];
if (group !== undefined && !LOCAL_SHORTCUTS.includes(group) && !CI_GROUPS.includes(group)) {
  throw new Error(
    `E2E_GROUP must be "smoke", "additional" or one of ${CI_GROUPS.join(", ")}, not "${group}".`,
  );
}
/** The specs one group runs (undefined for the smoke shortcut and for a run of everything). */
const groupSpecs =
  group === "additional"
    ? FEATURE_SPECS
    : group !== undefined && group in FEATURE_GROUPS
      ? [...FEATURE_GROUPS[group as FeatureGroup]]
      : group !== undefined && group in SMOKE_GROUPS
        ? [...SMOKE_GROUPS[group as SmokeGroup]]
        : undefined;
// A CI group has a 65 minute job limit; the local shortcuts run many groups in one go.
const GLOBAL_TIMEOUT_MINUTES = group === undefined || LOCAL_SHORTCUTS.includes(group) ? 75 : 60;
/**
 * Playwright workers: the CI job sets it per group (a group that flakes goes back to 1), and a
 * local queue (`pnpm test:e2e:queue`) sets it to the workers CI gives the group.
 * Unset, CI uses 1 and a local run lets Playwright choose.
 */
const envWorkers = process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : undefined;
const workers = envWorkers ?? (isCI ? 1 : undefined);

/**
 * Browser integration tests. They run the real UI in Chromium (Windows uses
 * WebView2) and WebKit (macOS WKWebView, Linux WebKitGTK) with the Tauri IPC
 * mocked in the page (see e2e/fixtures.ts).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  // The whole run. WebKit on CI renders in software, a test at a time: about an hour for
  // everything, so CI runs the groups as separate jobs.
  globalTimeout: GLOBAL_TIMEOUT_MINUTES * 60_000,
  ...(group === "smoke" && { testIgnore: FEATURE_SPECS }),
  ...(groupSpecs && { testMatch: groupSpecs }),
  retries: isCI ? 2 : 0,
  // Every song test synthesizes audio in real time, so parallel tests can starve each other's
  // audio and rendering (in WebKit's software renderer especially). CI starts with one test at a
  // time and the job raises it (`E2E_WORKERS`): the runner of a public repo has 4 vCPUs.
  workers,
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
