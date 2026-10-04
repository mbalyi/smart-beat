import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __splashShownAt?: number;
  }
}

/** The startup splash (#53): the animated logo on black, at least 3 s, never a white frame. */
test("shows the animated logo, then the app, after at least three seconds", async ({ page }) => {
  await page.goto("/");
  const image = page.locator("#splash img");
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("src", "/splash.webp");
  // The animation decodes and plays without a click (an image, not a video).
  await expect
    .poll(() => image.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth))
    .toBe(512);
  const shownAt = await page.evaluate(() => window.__splashShownAt!);

  await expect(page.locator("#splash")).toHaveCount(0, { timeout: 10_000 });
  const removedAt = await page.evaluate(() => performance.now());
  expect(removedAt - shownAt).toBeGreaterThanOrEqual(3000);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("the page is black, not white, from the first frame", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#splash")).toHaveCount(1);
  for (const element of ["documentElement", "body"] as const) {
    const background = await page.evaluate(
      (name) => getComputedStyle(document[name]).backgroundColor,
      element,
    );
    expect(background).toBe("rgb(0, 0, 0)");
  }
});

test("shows the still logo when the animation cannot load", async ({ page }) => {
  await page.route("**/splash.webp", (route) => route.fulfill({ status: 404 }));
  await page.goto("/");
  const image = page.locator("#splash img");
  await expect(image).toHaveAttribute("src", "/splash.png");
  await expect.poll(() => image.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(512);
});

test("does not fade with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("#splash")).toHaveCount(0, { timeout: 10_000 });
});
