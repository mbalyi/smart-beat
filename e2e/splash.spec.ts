import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __splashPlayingAt?: number;
  }
}
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

test("the animation plays in full at least once before the app shows", async ({
  page,
  browserName,
}) => {
  test.skip(browserName === "webkit", "Playwright's WebKit cannot play mp4");
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => window.__splashPlayingAt !== undefined)).toBe(true);
  const playingAt = await page.evaluate(() => window.__splashPlayingAt!);

  await expect(page.locator("#splash")).toHaveCount(0, { timeout: 10_000 });

  const removedAt = await page.evaluate(() => performance.now());
  expect(removedAt - playingAt).toBeGreaterThanOrEqual(2300); // one loop is 2.3 s
});

test("the page is black, not white, while the animation loads", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#splash")).toHaveCount(1);
  const background = await page.evaluate(
    () => getComputedStyle(document.documentElement).backgroundColor,
  );
  expect(background).toBe("rgb(0, 0, 0)");
});
