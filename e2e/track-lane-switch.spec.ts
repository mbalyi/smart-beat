import type { Page } from "@playwright/test";

import { expect, openSong, scoreRegion, test, waitForScore } from "./fixtures";

/**
 * A bar clicked in another track's lane of the track panel opens that track at the bar (#228):
 * with the drums shown, a click on a guitar bar used to leave the score on the drums.
 * The practice song has four bars (60 BPM for bars 1–2, 120 BPM after), so bar 4 starts at 0:10.
 */
const mixer = (page: Page) => page.getByRole("region", { name: "Tracks and mixer" });

/** The bar cells of a track's lane (mouse only: hidden from the accessibility tree). */
const laneBars = (page: Page, track: number) =>
  mixer(page).getByRole("listitem").nth(track).locator("button[tabindex='-1']");

/** Where alphaTab drew a bar number, and the visible part of the score, in page coordinates. */
async function barNumberInView(page: Page, number: number) {
  const barNumber = scoreRegion(page)
    .locator('svg:visible text[fill="#C80000"]', { hasText: new RegExp(`^${number}\\s*$`) })
    .first();
  // WebKit reports wrong client boxes for SVG text: use its box within its SVG.
  const text = await barNumber.evaluate((el: SVGTextElement) => {
    const svg = el.ownerSVGElement!.getBoundingClientRect();
    const box = el.getBBox();
    return { x: svg.x + box.x, y: svg.y + box.y };
  });
  const view = await page.getByTestId("score-viewport").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: el.clientWidth, height: el.clientHeight };
  });
  return (
    text.x >= view.x &&
    text.x <= view.x + view.width &&
    text.y >= view.y &&
    text.y <= view.y + view.height
  );
}

test.describe("track lanes (#228)", () => {
  test.beforeEach(async ({ app }) => {
    await app.emulateMedia({ reducedMotion: "reduce" });
  });

  test("a bar clicked in another track's lane shows that track at the bar", async ({ app }) => {
    await openSong(app);
    await mixer(app)
      .getByRole("button", { name: /^Show Drums/ })
      .click();
    await expect(scoreRegion(app)).toHaveAccessibleName("Score: Drums");
    await waitForScore(app);

    await laneBars(app, 0).nth(3).click();

    await expect(scoreRegion(app)).toHaveAccessibleName("Score: Guitar");
    await expect(mixer(app).getByRole("button", { name: /^Show Guitar/ })).toContainText("(shown)");
    await waitForScore(app);
    await expect(app.getByRole("spinbutton", { name: "Bar" })).toHaveValue("4");
    await expect(app.getByRole("timer")).toHaveText("0:10 / 0:12");
    await expect(laneBars(app, 0).nth(3)).toHaveClass(/ring-2/);
    await expect.poll(() => barNumberInView(app, 4)).toBe(true);
  });

  test("a bar clicked in the shown track's lane only goes to the bar", async ({ app }) => {
    await openSong(app);

    await laneBars(app, 0).nth(2).click();

    await expect(app.getByRole("spinbutton", { name: "Bar" })).toHaveValue("3");
    await expect(app.getByRole("timer")).toHaveText("0:08 / 0:12");
    await expect(scoreRegion(app)).toHaveAccessibleName("Score: Guitar");
  });
});
