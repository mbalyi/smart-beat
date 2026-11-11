import type { Page } from "@playwright/test";

import {
  editorStatus,
  expect,
  openSong,
  scoreRegion,
  tabNumbers,
  test,
  waitForAnimations,
} from "./fixtures";

/**
 * The drum tab in the continuous layout (#228): a drum track shown as "Tab" (numbers on lines)
 * in the one-line view draws its drums, and edits redraw it. In alphaTab 1.8.4 every lazy redraw
 * of that view threw "Cannot read properties of null (reading 'x')" in StaffSystem.getBarX, so
 * the drum numbers were never drawn (the page layout was fine). Covered: switching to the view,
 * typing a drum in edit mode and deleting it again.
 */

/** The bar edited: in view next to bar 1 when the continuous layout opens. */
const BAR = 2;
/** The drum typed on beat 1 of that bar, and the name the status line reads for it. */
const CRASH = 49;
const CRASH_NAME = /Crash high/;
/** Drum numbers of the practice song's kit drawn on the tab (bar numbers are told apart by colour). */
const DRUM_NUMBERS = /^(3[5-9]|4\d|5\d)$/;
/**
 * A drawing error that alphaTab catches and logs. Chromium names the null `.x` of
 * StaffSystem.getBarX, WebKit the expression `getRendererForBar(...).x`; both start the same.
 */
const RENDER_ERROR =
  /\[AlphaTab\]\[\w+\] An unexpected error|getBarX|getRendererForBar|reading 'x'/;

/**
 * Collects the errors thrown in the page, and the redraw error that alphaTab catches and logs
 * to the console.
 */
function collectRenderErrors(app: Page): string[] {
  const errors: string[] = [];
  app.on("pageerror", (error) => errors.push(error.message));
  app.on("console", (message) => {
    if (message.type() === "error" && RENDER_ERROR.test(message.text())) {
      errors.push(message.text().split("\n")[0]!);
    }
  });
  return errors;
}

/**
 * The drum numbers of a bar as the drum tab draws them, lowest first. The bar of a number is
 * the red bar number nearest to its left on the same row.
 */
async function barDrums(app: Page, bar: number): Promise<number[]> {
  return scoreRegion(app)
    .locator(".at-surface svg text")
    .evaluateAll((texts, wanted) => {
      const BAR_NUMBER_FILLS = ["#C80000", "#FF8A80"]; // light and dark mode
      // getBoundingClientRect, not Playwright's boundingBox: WebKit misplaces SVG text there.
      const numbers = texts
        .filter((t) => /^\d+$/.test(t.textContent?.trim() ?? ""))
        .map((t) => {
          const box = t.getBoundingClientRect();
          return {
            x: box.x + box.width / 2,
            left: box.x,
            y: box.y,
            value: Number(t.textContent!.trim()),
            isBar: BAR_NUMBER_FILLS.includes(t.getAttribute("fill") ?? ""),
          };
        });
      const bars = numbers.filter((n) => n.isBar);
      const barOf = (hit: { x: number; y: number }) => {
        const before = bars.filter((b) => b.y <= hit.y && b.left <= hit.x);
        const row = Math.max(...before.map((b) => b.y));
        const inRow = before.filter((b) => Math.abs(b.y - row) < 4);
        return inRow.sort((a, b) => b.left - a.left)[0]?.value ?? 0;
      };
      return numbers
        .filter((n) => !n.isBar && barOf(n) === wanted)
        .map((n) => n.value)
        .sort((a, b) => a - b);
    }, bar);
}

/** How many drum numbers the tab draws in the score. */
async function drawnDrums(app: Page): Promise<number> {
  return (await tabNumbers(app)).filter((n) => DRUM_NUMBERS.test(n)).length;
}

/** Shows the practice song's drums as a drum tab in the continuous layout. */
async function showContinuousDrumTab(app: Page) {
  await openSong(app);
  await app.getByRole("combobox", { name: "Track" }).click();
  await app.getByRole("option", { name: "Drums" }).click();
  await expect(scoreRegion(app)).toHaveAccessibleName("Score: Drums");
  await app
    .getByRole("radiogroup", { name: "Notation" })
    .getByRole("radio", { name: "Tab", exact: true })
    .click();
  await app
    .getByRole("radiogroup", { name: "Layout" })
    .getByRole("radio", { name: "Continuous", exact: true })
    .click();
  await expect(app.getByTestId("score-viewport")).toHaveAttribute("data-layout", "horizontal");
  await waitForAnimations(app);
}

const sorted = (drums: number[]) => [...drums].sort((a, b) => a - b);

test.describe("drum tab in the continuous layout (#228)", () => {
  test.use({ reducedMotion: "reduce" });

  test("draws the drum numbers and redraws them after typing and deleting a drum", async ({
    app,
  }) => {
    const errors = collectRenderErrors(app);
    await showContinuousDrumTab(app);

    // The drums are drawn as numbers on the tab, in the one-line view, without a redraw error.
    // Soft, so that a failure also reports the errors below.
    await expect
      .configure({ soft: true })
      .poll(() => drawnDrums(app), { message: "drum numbers drawn in the continuous layout" })
      .toBeGreaterThan(4);
    expect(errors, "errors while drawing the drum tab").toEqual([]);
    const before = await barDrums(app, BAR);
    expect(before, `bar ${BAR} has drums to edit around`).not.toEqual([]);
    expect(before).not.toContain(CRASH);

    await app.getByRole("button", { name: "Edit" }).click();
    await expect(app.getByRole("toolbar", { name: "Edit" })).toBeVisible();
    await waitForAnimations(app);
    await scoreRegion(app).focus();
    await expect.poll(() => editorStatus(app)).toMatch(/^Bar 1, beat 1 of 4/);
    await app.keyboard.press("ControlOrMeta+ArrowRight");
    await expect.poll(() => editorStatus(app)).toMatch(new RegExp(`^Bar ${BAR}, beat 1 of 4`));

    // Typing a drum redraws the tab with it.
    await app.keyboard.type(String(CRASH));
    await expect.poll(() => editorStatus(app)).toMatch(CRASH_NAME);
    await expect
      .poll(() => barDrums(app, BAR), { message: `the typed ${CRASH} is drawn in bar ${BAR}` })
      .toEqual(sorted([...before, CRASH]));

    // Deleting it redraws the tab without it, and the other drums stay drawn.
    await app.keyboard.press("Delete");
    await expect.poll(() => editorStatus(app)).toMatch(/drum tab, empty/);
    await expect
      .poll(() => barDrums(app, BAR), { message: `bar ${BAR} after deleting the ${CRASH}` })
      .toEqual(before);
    expect(await drawnDrums(app)).toBeGreaterThan(4);

    expect(errors, "errors while drawing the drum tab").toEqual([]);
  });
});
