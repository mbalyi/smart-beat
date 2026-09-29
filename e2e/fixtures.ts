import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { test as base, expect, type Page } from "@playwright/test";

type MenuAction = "open" | "toggle-theme" | "shortcuts" | "licenses" | "about";

declare global {
  interface Window {
    __emitMenuAction: (action: MenuAction) => number;
  }
}

const TAURI_MOCK = path.join(import.meta.dirname, "tauri-mock.js");

export const LICENSE_TEXT = "react 19.3.0 — MIT License\n\nPermission is hereby granted…\n";

export const test = base.extend<{ app: Page }>({
  app: async ({ page }, use) => {
    await page.addInitScript({ path: TAURI_MOCK });
    // The notice file is generated at package time; serve a stand-in.
    await page.route("**/third-party-licenses.txt", (route) =>
      route.fulfill({ contentType: "text/plain; charset=utf-8", body: LICENSE_TEXT }),
    );
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await use(page);
  },
});

/** Simulates a native menu click once the UI has subscribed to menu events. */
export async function emitMenuAction(page: Page, action: MenuAction) {
  await expect
    .poll(() => page.evaluate((a) => window.__emitMenuAction(a), action))
    .toBeGreaterThan(0);
}

/**
 * Key that moves focus to the next control. WebKit on macOS follows the OS
 * "keyboard navigation" setting, which is off by default: plain Tab only
 * reaches text fields there, Option+Tab reaches buttons and links (as in Safari).
 */
export function tabKey(browserName: string): string {
  return browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
}

/** Runs axe-core against WCAG 2.2 A/AA rules and fails on any violation. */
export async function expectNoA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  const violations = results.violations.map(
    (v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );
  expect(violations).toEqual([]);
}

export { expect };
