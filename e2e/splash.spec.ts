import { expect, test } from "@playwright/test";

/** The startup animation must play by itself (WebKit blocks autoplay unless it is started muted). */
test("the startup animation plays without a click", async ({ page, browserName }) => {
  // Playwright's WebKit has no H.264 decoder: there the splash is skipped (by design).
  test.skip(browserName === "webkit", "Playwright's WebKit cannot play mp4");
  await page.goto("/");
  const video = page.locator("#splash video");
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > 0))
    .toBe(true);
  expect(await video.evaluate((v: HTMLVideoElement) => v.controls)).toBe(false);
  // It goes away once the app has started.
  await expect(page.locator("#splash")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
