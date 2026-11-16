import type { Page } from "@playwright/test";

import { emitMenuAction, expect, openSong, test } from "./fixtures";

/**
 * The audio lanes tour (#84, #235): the "Turn a clip into sheet music" step points at a clip and
 * is skipped when no lane has one.
 */

const coachMark = (page: Page) => page.getByTestId("coach-mark");

/** Starts the Audio lanes tour from Help > Tours. */
async function startTour(page: Page) {
  await page.getByRole("button", { name: "Help" }).click();
  await page.getByRole("menuitem", { name: "Tours" }).click();
  await page.getByRole("menuitem", { name: "Audio lanes tour" }).click();
  await expect(coachMark(page).getByRole("heading", { name: "Audio next to the tab" })).toBeVisible(
    { timeout: 30_000 },
  );
}

/** Goes to the next step and checks its title. */
async function next(page: Page, title: string) {
  await coachMark(page).getByRole("button", { name: "Next" }).click();
  await expect(coachMark(page).getByRole("heading", { name: title })).toBeVisible();
}

test.describe("Audio lanes tour: Convert audio to sheet", () => {
  let errors: string[] = [];
  test.beforeEach(({ app }) => {
    errors = [];
    app.on("pageerror", (error) => errors.push(error.message));
  });
  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test("points at a clip right after the clip editing step", async ({ app }) => {
    test.slow();
    await openSong(app);
    // A lane with one clip (the audio is decoded by the mocked engine).
    await app.evaluate((path) => (window.__dialogResult = path), "/Users/me/Music/vocals.wav");
    await emitMenuAction(app, "import-audio-file");
    await expect(app.locator("[data-clip-id]").first()).toBeVisible();

    await startTour(app);
    await next(app, "Add an empty lane");
    await next(app, "Import an audio file");
    await next(app, "Stems as lanes");
    await next(app, "Colour each lane");
    await next(app, "Effects on a lane");
    await next(app, "Edit the clips");
    await next(app, "Turn a clip into sheet music");
    await expect(coachMark(app)).toContainText("Convert audio to sheet…");
    await expect(app.locator('[data-tour="lane-clip"]').first()).toHaveAttribute(
      "data-tour-active",
      "",
    );
  });

  test("skips the step when no lane has a clip", async ({ app }) => {
    test.slow();
    await openSong(app);
    await startTour(app);
    await next(app, "Add an empty lane");
    await next(app, "Import an audio file");
    await next(app, "Stems as lanes");
    // Every step after this one is about a lane or a clip: with none, they are all skipped and
    // the tour ends, never stopping on the clip step.
    await coachMark(app).getByRole("button", { name: "Next" }).click();
    await expect(coachMark(app)).toHaveCount(0);
    await expect(app.getByText("Turn a clip into sheet music")).toHaveCount(0);
  });
});
