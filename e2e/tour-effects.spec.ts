import { emitMenuAction, expect, test, waitForScore } from "./fixtures";

import type { Page } from "@playwright/test";

const coachMark = (page: Page) => page.getByTestId("coach-mark");
const mixer = (page: Page) => page.getByRole("region", { name: "Tracks and mixer" });
const inspector = (page: Page) => page.getByRole("complementary", { name: "Inspector" });
const pedalboard = (page: Page) => page.getByRole("dialog", { name: /^Pedalboard:/ });
const drumMixer = (page: Page) => page.getByRole("dialog", { name: /^Drum mixer:/ });

/** Goes to the next step and checks its title. */
async function next(page: Page, title: string) {
  await coachMark(page).getByRole("button", { name: "Next" }).click();
  await expect(coachMark(page).getByRole("heading", { name: title })).toBeVisible();
}

/** The control the step points at is outlined. */
const expectActive = (page: Page, target: string) =>
  expect(page.locator(`[data-tour="${target}"]`)).toHaveAttribute("data-tour-active", "");

test("the effects tour shows the EQ, opens the pedalboard and the drum mixer, and puts it all back", async ({
  app,
}) => {
  await emitMenuAction(app, "demo-song");
  await waitForScore(app);
  // Both panels closed: the tour opens them and must close them again.
  await app.getByRole("button", { name: "Mixer" }).click();
  await app.getByRole("button", { name: "Inspector" }).click();
  await expect(mixer(app)).toHaveCount(0);
  await expect(inspector(app)).toHaveCount(0);

  await emitMenuAction(app, "tour-effects");
  // The tour starts although the mixer it is about is closed.
  await expect(coachMark(app).getByRole("heading", { name: "Shape the sound" })).toBeVisible();
  await next(app, "The mixer");
  await expect(coachMark(app)).toContainText("double-click it to centre");
  await expect(mixer(app)).toBeVisible();

  // The EQ of the shown track (the guitar), not of every row.
  await next(app, "EQ per track");
  await expect(coachMark(app)).toContainText("10-band EQ");
  await expect(app.locator('[data-tour="track-eq"]')).toHaveCount(1);
  await expectActive(app, "track-eq");
  await expect(app.locator('[data-tour="track-eq"]')).toHaveAccessibleName(/^EQ for Guitar/);

  // The pedalboard steps are drawn inside the pedalboard dialog.
  for (const [title, target] of [
    ["Add an effect", "pedalboard-library"],
    ["The signal chain", "pedalboard-chain"],
    ["Presets", "pedalboard-presets"],
  ]) {
    await next(app, title!);
    await expect(pedalboard(app)).toBeVisible();
    await expect(pedalboard(app).getByTestId("coach-mark")).toContainText(title!);
    await expect(pedalboard(app).locator(`[data-tour="${target}"]`)).toBeVisible();
  }
  await expect(pedalboard(app)).toHaveAccessibleName("Pedalboard: Guitar");

  await next(app, "Mastering");
  await expect(pedalboard(app).getByTestId("coach-mark")).toContainText("up to 3 effects");
  await expect(pedalboard(app).getByRole("radio", { name: "Mastering" })).toBeChecked();

  // Leaving the dialog closes it.
  await next(app, "Master row");
  await expect(pedalboard(app)).toHaveCount(0);
  await expectActive(app, "mastering");

  for (const [title, target] of [
    ["Kit pieces", "drum-kit-pieces"],
    ["Mono or stereo", "drum-kit-output"],
    ["Bus compressor", "drum-bus"],
  ]) {
    await next(app, title!);
    await expect(drumMixer(app)).toBeVisible();
    await expect(drumMixer(app).getByTestId("coach-mark")).toContainText(title!);
    await expect(drumMixer(app).locator(`[data-tour="${target}"]`)).toBeVisible();
  }
  await expect(drumMixer(app)).toHaveAccessibleName("Drum mixer: Drums");

  await next(app, "That's the sound");
  await expect(drumMixer(app)).toHaveCount(0);
  await expect(coachMark(app).getByRole("button", { name: /Speed Trainer tour/ })).toBeVisible();
  await coachMark(app).getByRole("button", { name: "Done" }).click();

  await expect(coachMark(app)).toHaveCount(0);
  await expect(app.getByRole("dialog")).toHaveCount(0);
  await expect(mixer(app)).toHaveCount(0);
  await expect(inspector(app)).toHaveCount(0);
  await expect(app.getByRole("region", { name: "Score: Guitar" })).toBeVisible();
});

test("closing the pedalboard during the tour ends it", async ({ app }) => {
  await emitMenuAction(app, "demo-song");
  await waitForScore(app);
  await emitMenuAction(app, "tour-effects");
  for (const title of ["The mixer", "EQ per track", "Add an effect"]) await next(app, title);
  await pedalboard(app).getByRole("button", { name: "Done" }).click();
  await expect(coachMark(app)).toHaveCount(0);
  await expect(app.getByRole("dialog")).toHaveCount(0);
});
