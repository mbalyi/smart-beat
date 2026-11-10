import type { Page } from "@playwright/test";

import {
  editorStatus,
  emitMenuAction,
  expect,
  expectTab,
  newSong,
  scoreRegion,
  test,
} from "./fixtures";

/**
 * Delete every selected bar (#228, story 14): with a selection over several bars, the
 * right-click menu's delete item removes all of them in one undo step, and its label says how
 * many. Right-clicking a bar outside the selection deletes only that bar.
 */

/** Four full bars of quarter notes on the top string, every fret different. */
const SONG = [
  [1, 2, 3, 4],
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
];

/** The tab drawn for these bars of SONG (1-based bar numbers), in reading order. */
const tabOf = (...bars: number[]) => bars.flatMap((bar) => SONG[bar - 1]).map(String);

/** The bar menu's delete item: "Delete bar" today, "Delete 2 bars" for a selection of two. */
const DELETE_BARS = /^Delete( \d+)? bars?$/;

/** The "/ 4" next to the bar field in the toolbar display. */
async function barCount(app: Page): Promise<number> {
  const text = await app.getByText(/^\/ \d+$/).textContent();
  return Number(text?.replace("/", "").trim());
}

/** Waits until the status line says the cursor is on `bar`, `beat` (1-based). */
async function expectCursor(app: Page, bar: number, beat: number) {
  await expect
    .poll(() => editorStatus(app))
    .toMatch(new RegExp(`^Bar ${bar}, beat ${beat} of \\d+`));
}

/** A new song with SONG typed in: one fret per beat, ArrowRight to the next beat (and bar). */
async function songWithFourBars(app: Page) {
  await newSong(app);
  const frets = SONG.flat();
  for (const [i, fret] of frets.entries()) {
    await app.keyboard.type(String(fret));
    if (i < frets.length - 1) await app.keyboard.press("ArrowRight");
  }
  await expectTab(app, tabOf(1, 2, 3, 4));
  await expect.poll(() => barCount(app)).toBe(SONG.length);
}

/**
 * Selects from bar 2, beat 2 to bar 3, beat 3: Ctrl/⌘+ArrowLeft back to bar 2, ArrowRight to
 * its second beat, then Shift+ArrowRight over the bar line.
 */
async function selectAcrossBarsTwoAndThree(app: Page) {
  await expectCursor(app, 4, 4);
  for (let i = 0; i < 2; i++) await app.keyboard.press("ControlOrMeta+ArrowLeft");
  await expectCursor(app, 2, 1);
  await app.keyboard.press("ArrowRight");
  await expectCursor(app, 2, 2);
  for (let i = 0; i < 5; i++) await app.keyboard.press("Shift+ArrowRight");
  await expectCursor(app, 3, 3);
  await expect(app.getByTestId("edit-selection")).not.toHaveCount(0);
}

/** Right-clicks the fret number `fret` drawn in the score and returns the menu that opens. */
async function rightClickFret(app: Page, fret: number) {
  const note = scoreRegion(app)
    .locator(".at-surface svg text")
    .filter({ hasText: new RegExp(`^${fret}$`) })
    .first();
  // WebKit counts the drawing above the text as covering it; the click lands on the note.
  await note.click({ button: "right", force: true });
  const menu = app.getByRole("menu", { name: "Score actions" });
  await expect(menu).toBeVisible();
  return menu;
}

test.describe("delete every selected bar (#228)", () => {
  test("deletes every bar of the selection, and one Undo brings them back", async ({ app }) => {
    test.slow(); // a song typed beat by beat
    await songWithFourBars(app);
    await selectAcrossBarsTwoAndThree(app);

    const menu = await rightClickFret(app, 10); // bar 3, inside the selection
    await expect(menu.getByText("Selection · ")).toBeVisible();
    await expect(menu.getByText("Bar 3", { exact: true })).toBeVisible();
    const remove = menu.getByRole("menuitem", { name: DELETE_BARS });
    await expect.soft(remove, "the label says how many bars go").toHaveText("Delete 2 bars");
    await remove.click();

    await expect
      .poll(() => barCount(app), { message: "bars 2 and 3 are deleted", timeout: 10_000 })
      .toBe(SONG.length - 2);
    await expectTab(app, tabOf(1, 4));

    // ⌘Z / Ctrl+Z reaches the page through the native Edit menu in the desktop app.
    await emitMenuAction(app, "undo");
    await expect.poll(() => barCount(app)).toBe(SONG.length);
    await expectTab(app, tabOf(1, 2, 3, 4));
  });

  test("right-clicking a bar outside the selection deletes only that bar", async ({ app }) => {
    test.slow(); // a song typed beat by beat
    await songWithFourBars(app);
    await selectAcrossBarsTwoAndThree(app);

    const menu = await rightClickFret(app, 14); // bar 4, outside the selection
    await expect(menu.getByText("Bar 4", { exact: true })).toBeVisible();
    const remove = menu.getByRole("menuitem", { name: DELETE_BARS });
    await expect(remove).toHaveText("Delete bar");
    await remove.click();

    await expect
      .poll(() => barCount(app), { message: "only bar 4 is deleted", timeout: 10_000 })
      .toBe(SONG.length - 1);
    await expectTab(app, tabOf(1, 2, 3));
  });
});
