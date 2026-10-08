import type { Page } from "@playwright/test";

import {
  emitMenuAction,
  expect,
  expectNoA11yViolations,
  openSong,
  scoreRegion,
  test,
} from "./fixtures";

/** Customer feedback (#83 §7): in dark mode the score itself is dark too. */

/** The paper's background and the colours the notation is drawn in. */
const scoreColours = (app: Page) =>
  scoreRegion(app).evaluate((region) => {
    const paper = region.querySelector(".score-paper")!;
    const fills = [...region.querySelectorAll(".at-surface svg text")]
      .map((t) => t.getAttribute("fill"))
      .filter((f): f is string => !!f);
    return { paper: getComputedStyle(paper).backgroundColor, fills: [...new Set(fills)] };
  });

test.describe("dark score (#83)", () => {
  for (const notation of ["Score + tab", "Score", "Tab"]) {
    test(`draws ${notation} light on dark paper in dark mode`, async ({ app }) => {
      await app.emulateMedia({ colorScheme: "dark" });
      await openSong(app);
      await app.getByRole("radio", { name: notation, exact: true }).click();
      // Bar numbers in the dark palette's salmon, notes and text in its near white.
      await expect
        .poll(async () => (await scoreColours(app)).fills)
        .toEqual(expect.arrayContaining(["#FF8A80"]));
      const colours = await scoreColours(app);
      expect(colours.paper).toBe("rgb(24, 24, 27)");
      // Nothing left in the light palette's dark colours.
      expect(colours.fills).not.toContain("#C80000");
      expect(colours.fills).not.toContain("#222211");
      await expectNoA11yViolations(app);
    });
  }

  test("switching the theme redraws the score, and light mode stays as it was", async ({ app }) => {
    await app.emulateMedia({ colorScheme: "light" });
    await openSong(app);
    await expect
      .poll(async () => (await scoreColours(app)).fills)
      .toEqual(expect.arrayContaining(["#C80000"]));
    expect((await scoreColours(app)).paper).toBe("rgb(255, 255, 255)");
    await emitMenuAction(app, "toggle-theme");
    await expect
      .poll(async () => (await scoreColours(app)).fills)
      .toEqual(expect.arrayContaining(["#FF8A80"]));
    expect((await scoreColours(app)).paper).toBe("rgb(24, 24, 27)");
  });
});
