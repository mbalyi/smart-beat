import type { Page } from "@playwright/test";

import { editorStatus, emitMenuAction, expect, newSong, scoreRegion, test } from "./fixtures";

/**
 * Deleting several selected rests (#228, story 9): a bar filled with 16th rests, a few of
 * them selected, and Delete (or the right-click menu) removes them all; one Undo brings
 * them all back.
 */

/** How many beats the cursor's bar holds, from the status line ("Bar 1, beat 3 of 16, …"). */
async function beatsInBar(app: Page): Promise<number> {
  const match = /beat \d+ of (\d+)/.exec(await editorStatus(app));
  return match ? Number(match[1]) : NaN;
}

const SIXTEENTHS_PER_BAR = 16;
const SELECTED = 4;

/** A new song whose first bar is sixteen 16th rests, with beats 3 to 6 selected. */
async function selectFourRests(app: Page) {
  await newSong(app);
  await app.keyboard.press("Shift+Digit5"); // the 16th note value
  await app.keyboard.press("Shift+R"); // fill the bar with 16th rests
  await expect.poll(() => beatsInBar(app)).toBe(SIXTEENTHS_PER_BAR);
  expect(await editorStatus(app)).toMatch(/^Bar 1, beat 1 of 16/);

  await app.keyboard.press("ArrowRight");
  await app.keyboard.press("ArrowRight"); // beat 3
  for (let i = 1; i < SELECTED; i++) await app.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => editorStatus(app)).toMatch(/^Bar 1, beat 6 of 16/);
  await expect(app.getByTestId("edit-selection")).not.toHaveCount(0);
}

test.describe("delete several selected rests (#228)", () => {
  test("Delete removes every selected rest, and one Undo brings them back", async ({ app }) => {
    await selectFourRests(app);

    await app.keyboard.press("Delete");
    await expect
      .poll(() => beatsInBar(app), {
        message: "the four selected rests are removed",
        timeout: 10_000,
      })
      .toBe(SIXTEENTHS_PER_BAR - SELECTED);
    await expect(app.getByTestId("edit-selection")).toHaveCount(0);

    // ⌘Z / Ctrl+Z reaches the page through the native Edit menu in the desktop app.
    await emitMenuAction(app, "undo");
    await expect.poll(() => beatsInBar(app)).toBe(SIXTEENTHS_PER_BAR);
    // One step: the next undo is the bar fill, not another deleted beat.
    await expect.poll(() => app.evaluate(() => window.__menuState?.undo)).toBe("Fill with rests");
    await expect(scoreRegion(app)).toBeFocused();
  });

  test("the right-click menu deletes the selected rests too", async ({ app }) => {
    await selectFourRests(app);

    const box = (await app.getByTestId("edit-selection").first().boundingBox())!;
    await app.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    const menu = app.getByRole("menu", { name: "Score actions" });
    await expect(menu.getByText("Selection · ")).toBeVisible();
    // Today's label is "Delete"; "Delete selection" is accepted as well.
    await menu.getByRole("menuitem", { name: /^Delete( selection)?$/i }).click();

    await expect
      .poll(() => beatsInBar(app), {
        message: "the four selected rests are removed",
        timeout: 10_000,
      })
      .toBe(SIXTEENTHS_PER_BAR - SELECTED);

    await emitMenuAction(app, "undo");
    await expect.poll(() => beatsInBar(app)).toBe(SIXTEENTHS_PER_BAR);
  });
});
