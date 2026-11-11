import type { Page } from "@playwright/test";

import {
  PRACTICE_SONG,
  editorStatus,
  expect,
  openSong,
  scoreRegion,
  test,
  waitForAnimations,
} from "./fixtures";

/**
 * Keep the edit position when switching tabs (#228, story 10): each open tab keeps its edit
 * cursor, and switching back to a tab in edit mode puts the keyboard back in its score, so the
 * arrow keys go on from where the user was without a click in the score.
 */

const STRUCTURE_SONG = "/Users/me/Music/structure-song.gp";

const tabBar = (app: Page) => app.getByRole("navigation", { name: "Open songs" });
const tabButton = (app: Page, name: string) =>
  tabBar(app).getByRole("button", { name, exact: true });

/** Shows an open song's tab by clicking it in the tab bar (not the score). */
async function switchTo(app: Page, name: string) {
  await tabButton(app, name).click();
  await expect(tabButton(app, name)).toHaveAttribute("aria-current", "true");
  await expect(app.getByRole("heading", { level: 1, name })).toBeVisible();
}

/** Turns on edit mode in the shown song; entering it focuses the score. */
async function startEditing(app: Page) {
  await app.getByRole("button", { name: "Edit" }).click();
  await waitForAnimations(app); // the palette slides in and moves the score
  await expect(scoreRegion(app)).toBeFocused();
}

/**
 * The editor's status line of a song whether its tab is shown or not: a hidden song stays
 * mounted (aria-hidden), so it is found by its workspace's name rather than by role.
 */
function statusOf(app: Page, title: string): Promise<string> {
  return app
    .locator(`[role="group"][aria-label="${title}"] [role="region"][aria-label^="Score:"]`)
    .evaluate(
      (region) =>
        document.getElementById(region.getAttribute("aria-describedby") ?? "")?.textContent ?? "",
    );
}

/** Whether the keyboard focus is in the shown song's score (the editor). */
const focusIsInScore = (app: Page) =>
  scoreRegion(app).evaluate((region) => region.contains(document.activeElement));

test.describe("switching tabs in edit mode (#228)", () => {
  test("coming back to a tab puts the keyboard back on its edit cursor", async ({ app }) => {
    // Two songs, each in its own tab (the second one opened is shown).
    await openSong(app, PRACTICE_SONG);
    await openSong(app, STRUCTURE_SONG);
    await expect(tabBar(app).getByRole("listitem")).toHaveCount(2);
    await expect(tabButton(app, "Structure Song")).toHaveAttribute("aria-current", "true");

    // Tab B: edit mode, cursor on bar 3, beat 2.
    await startEditing(app);
    await app.keyboard.press("ControlOrMeta+ArrowRight");
    await app.keyboard.press("ControlOrMeta+ArrowRight");
    await app.keyboard.press("ArrowRight");
    await expect.poll(() => editorStatus(app)).toMatch(/^Bar 3, beat 2 of 4/);
    const statusB = await editorStatus(app);

    // Tab A: edit mode, cursor on bar 2, beat 3 with the arrow keys.
    await switchTo(app, "Practice Song");
    await startEditing(app);
    await app.keyboard.press("ControlOrMeta+ArrowRight");
    await app.keyboard.press("ArrowRight");
    await app.keyboard.press("ArrowRight");
    await expect.poll(() => editorStatus(app)).toMatch(/^Bar 2, beat 3 of 4/);
    const statusA = await editorStatus(app);

    // Over to tab B and back to tab A, only through the tab bar.
    await switchTo(app, "Structure Song");
    await expect(scoreRegion(app)).toHaveAttribute("data-editing", "true");
    expect(await editorStatus(app)).toBe(statusB);
    await switchTo(app, "Practice Song");
    await expect(scoreRegion(app)).toHaveAttribute("data-editing", "true");
    expect(await editorStatus(app)).toBe(statusA);

    // The keyboard is back in the score: no click needed. Soft, so that the arrow key and tab B
    // are still checked when it fails.
    const softly = expect.configure({ soft: true });
    await softly
      .poll(() => focusIsInScore(app), { message: "focus is in the score after switching back" })
      .toBe(true);

    // ArrowRight goes on from the remembered cursor: bar 2, beat 4.
    await app.keyboard.press("ArrowRight");
    await softly
      .poll(() => editorStatus(app), { message: "ArrowRight moves the restored cursor one beat" })
      .toMatch(/^Bar 2, beat 4 of 4/);

    // The round trip left tab B's cursor where it was.
    expect(await statusOf(app, "Structure Song")).toBe(statusB);
  });
});
