import { emitMenuAction, expect, test, waitForScore } from "./fixtures";

import type { Page } from "@playwright/test";

const coachMark = (page: Page) => page.getByTestId("coach-mark");

/** Opens the demo song, then a new song, so two songs are open and the second is shown. */
async function twoSongs(page: Page) {
  await emitMenuAction(page, "demo-song");
  await waitForScore(page);
  await emitMenuAction(page, "new-song");
  await expect(page.getByRole("navigation", { name: "Open songs" })).toContainText("Untitled");
  await waitForScore(page);
}

test("a tour points at the controls of the song that is shown, not at a hidden song's", async ({
  app,
}) => {
  await twoSongs(app);
  await emitMenuAction(app, "tour");
  await expect(coachMark(app)).toContainText("Your score");
  await coachMark(app).getByRole("button", { name: "Next" }).click();
  await expect(coachMark(app)).toContainText("Play it");
  const active = app.locator("[data-tour-active]");
  await expect(active).toHaveCount(1);
  await expect(active).toBeVisible();
  // The highlighted Play button is the shown song's: the only one that is not inert.
  expect(await active.evaluate((el) => el.closest("[inert]") === null)).toBe(true);
  await app.keyboard.press("Escape");
});

test("skipping a tour restores the song it started on, even after switching to another tab", async ({
  app,
}) => {
  await emitMenuAction(app, "demo-song");
  await waitForScore(app);
  await emitMenuAction(app, "tour-speed-trainer");
  await expect(coachMark(app)).toContainText("Choose a passage");
  await coachMark(app).getByRole("button", { name: "Next" }).click();
  await expect(coachMark(app)).toContainText("70%", { timeout: 15_000 });
  // The tour changed the speed of the demo song; now another song is opened and the tour skipped.
  await emitMenuAction(app, "new-song");
  await expect(app.getByRole("navigation", { name: "Open songs" })).toContainText("Untitled");
  await waitForScore(app);
  await coachMark(app).getByRole("button", { name: "Skip" }).click();
  await expect(coachMark(app)).toHaveCount(0);

  await app.getByRole("navigation", { name: "Open songs" }).getByText("Smart Beat Demo").click();
  await waitForScore(app);
  await expect(app.getByRole("combobox", { name: "Speed" })).toHaveText("100%");
  await expect(app.getByRole("button", { name: "Pause" })).toHaveCount(0);
});

test("a loop in a tour stays inside a song that is shorter than the tour assumes", async ({
  app,
}) => {
  // A new song has 4 bars; the Speed Trainer tour loops bars 5 to 8 of the demo song.
  await emitMenuAction(app, "new-song");
  await waitForScore(app);
  await emitMenuAction(app, "tour-speed-trainer");
  await coachMark(app).getByRole("button", { name: "Next" }).click();
  await expect(coachMark(app)).toContainText("70%", { timeout: 15_000 });
  const to = app.getByRole("spinbutton", { name: "Loop to bar" });
  await expect(to).toBeVisible();
  const last = Number(await to.getAttribute("max"));
  expect(last).toBe(4);
  expect(Number(await to.inputValue())).toBeLessThanOrEqual(last);
  expect(
    Number(await app.getByRole("spinbutton", { name: "Loop from bar" }).inputValue()),
  ).toBeLessThanOrEqual(last);
  await app.keyboard.press("Escape");
});
