import { emitMenuAction, expect, playedSeconds, test, waitForScore } from "./fixtures";

import type { Page } from "@playwright/test";

/** The Editing and Speed Trainer tours (#84) on the demo song, at the smallest supported window. */

const coachMark = (page: Page) => page.getByTestId("coach-mark");
const next = (page: Page) => coachMark(page).getByRole("button", { name: "Next" }).click();
const tourState = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("smart-beat:tour") ?? "null"));

/** Opens the demo song with the mixer and the inspector closed, so the tours must open them. */
async function openDemo(app: Page) {
  await app.setViewportSize({ width: 1280, height: 720 });
  await app.evaluate(() =>
    localStorage.setItem("smart-beat:layout", JSON.stringify({ mixer: false, inspector: false })),
  );
  await app.reload();
  await expect(app.getByRole("heading", { level: 1 })).toBeVisible();
  await emitMenuAction(app, "demo-song");
  await waitForScore(app);
}

/** Waits until the LCD timer moves on from where it is now (a loop may also send it back). */
async function expectPlaying(app: Page) {
  const from = await playedSeconds(app);
  await expect.poll(() => playedSeconds(app), { timeout: 20_000 }).not.toBe(from);
}

test.describe("the Editing tour", () => {
  test("walks through edit mode, the palette, tracks and the inspector, then puts it all back", async ({
    app,
  }) => {
    test.setTimeout(120_000);
    await openDemo(app);
    const editToggle = app.locator("[data-tour=edit]");
    await expect(editToggle).toHaveAttribute("aria-pressed", "false");
    await expect(app.getByRole("region", { name: "Tracks and mixer" })).toHaveCount(0);

    await emitMenuAction(app, "tour-editing");
    await expect(coachMark(app)).toContainText("Edit mode");
    await expect(coachMark(app)).toContainText("Step 1 of 6");

    await next(app);
    await expect(coachMark(app)).toContainText("Note palette");
    await expect(coachMark(app)).toContainText("scrolls");
    const palette = app.getByRole("complementary", { name: "Note palette" });
    await expect(palette).toBeVisible();
    // The palette scrolls with the mouse wheel while the tour points at it (WebKit too).
    await expect
      .poll(async () => palette.evaluate((el) => el.scrollHeight > el.clientHeight))
      .toBe(true);
    const box = (await palette.boundingBox())!;
    await app.mouse.move(box.x + box.width / 2, box.y + box.height * 0.75);
    await expect
      .poll(
        async () => {
          await app.mouse.wheel(0, 300);
          return palette.evaluate((el) => el.scrollTop);
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);

    await next(app);
    await expect(coachMark(app)).toContainText("Undo and redo");

    await next(app);
    await expect(coachMark(app)).toContainText("Add a track");
    await expect(coachMark(app)).toContainText("General MIDI");
    await expect(app.getByRole("region", { name: "Tracks and mixer" })).toBeVisible();
    await expect(app.locator("[data-tour=add-track]")).toHaveAttribute("data-tour-active", "");

    await next(app);
    await expect(coachMark(app)).toContainText("Copy a track to another instrument");
    const copy = app.locator("[data-tour=copy-instrument]");
    await expect(copy).toBeVisible();
    await expect(copy).toHaveAttribute("data-tour-active", "");

    await next(app);
    await expect(coachMark(app)).toContainText("Normalize drum notation");
    const normalize = app.locator("[data-tour=normalize-drums]");
    await expect(normalize).toBeVisible();
    await expect(normalize).toHaveAttribute("data-tour-active", "");
    // The last step offers the other tours.
    await expect(coachMark(app).getByRole("button", { name: /Speed Trainer tour/ })).toBeVisible();

    await coachMark(app).getByRole("button", { name: "Done" }).click();
    await expect(coachMark(app)).toHaveCount(0);
    await expect(palette).toHaveCount(0);
    await expect(editToggle).toHaveAttribute("aria-pressed", "false");
    await expect(app.getByRole("region", { name: "Tracks and mixer" })).toHaveCount(0);
    await expect(normalize).toHaveCount(0);
    await expect(copy).toHaveCount(0);
    await expect.poll(async () => (await tourState(app))?.tours.editing).toBe("done");
  });
});

test.describe("the Speed Trainer tour", () => {
  test("loops, plays, opens the dialog, runs the trainer and puts everything back", async ({
    app,
  }) => {
    test.setTimeout(120_000);
    await openDemo(app);
    const speed = app.getByRole("combobox", { name: "Speed" });
    const loop = app.getByRole("button", { name: "Loop" });

    await emitMenuAction(app, "tour-speed-trainer");
    await expect(coachMark(app)).toContainText("Choose a passage");
    await expect(loop).toHaveAttribute("aria-pressed", "true");
    await expect(app.getByRole("spinbutton", { name: "Loop from bar" })).toHaveValue("5");
    await expect(app.getByRole("spinbutton", { name: "Loop to bar" })).toHaveValue("8");

    await next(app);
    await expect(coachMark(app)).toContainText("Play it slowly");
    await expect(speed).toHaveText("70%");
    await expect(app.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 20_000 });
    await expectPlaying(app);

    await next(app);
    await expect(coachMark(app)).toContainText("Count in instead");
    await expect(speed).toHaveText("100%");
    await expect(app.getByRole("button", { name: "Count-in" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(app.getByRole("button", { name: "Play" })).toBeVisible();

    await next(app);
    await expect(coachMark(app)).toContainText("Hear the count-in");
    await expectPlaying(app);

    await next(app);
    const dialog = app.getByRole("dialog", { name: "Speed Trainer", exact: true });
    await expect(dialog).toBeVisible();
    // The coach card is drawn inside the modal dialog, not over the page.
    await expect(dialog.getByTestId("coach-mark")).toContainText("Speed Trainer: the bars");
    await expect(dialog.getByRole("spinbutton", { name: "From bar" })).toHaveValue("5");
    // Playback stops while the dialog is open (the modal hides the toolbar from the a11y tree).
    await expect(app.locator("[data-tour=play]")).toHaveAttribute("aria-label", "Play");

    await next(app);
    await expect(dialog.getByTestId("coach-mark")).toContainText("Speed Trainer: the speeds");
    await next(app);
    await expect(dialog.getByTestId("coach-mark")).toContainText("loops and Start");

    await next(app);
    await expect(dialog).toHaveCount(0);
    await expect(coachMark(app)).toContainText("The trainer runs");
    await expect(app.getByRole("status").filter({ hasText: "Trainer 60% → 100%" })).toBeVisible();
    await expect(app.getByRole("button", { name: "Stop the Speed Trainer" })).toBeVisible();
    await expectPlaying(app);

    await next(app);
    await expect(coachMark(app)).toContainText("Stop when you are done");
    await expect(speed).toHaveText("100%");
    await coachMark(app).getByRole("button", { name: "Done" }).click();
    await expect(coachMark(app)).toHaveCount(0);

    // Everything the tour changed is back.
    await expect(speed).toHaveText("100%");
    await expect(loop).toHaveAttribute("aria-pressed", "false");
    await expect(app.getByRole("button", { name: "Play" })).toBeVisible();
    await expect(app.getByRole("dialog")).toHaveCount(0);
    await expect(app.getByRole("button", { name: "Count-in" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
