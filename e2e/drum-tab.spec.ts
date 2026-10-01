import type { Page } from "@playwright/test";

import {
  editorStatus,
  expect,
  expectNoA11yViolations,
  openSong,
  scoreRegion,
  tabNumbers,
  test,
} from "./fixtures";

/** The drum tab (#49): drum numbers on six lines, drawn by alphaTab through a mirror staff. */

async function showDrums(app: Page, notation: "Tab" | "Score + tab" | "Score") {
  await app.getByRole("combobox", { name: "Track" }).click();
  await app.getByRole("option", { name: "Drums" }).click();
  await app
    .getByRole("radiogroup", { name: "Notation" })
    .getByRole("radio", { name: notation, exact: true })
    .click();
}

const DRUM_NUMBERS = /^(3[5-9]|4\d|5\d)$/;

test.describe("drum tab (#49)", () => {
  test("writes the drums as numbers on a tab staff", async ({ app }) => {
    await openSong(app);
    await showDrums(app, "Tab");
    await expect
      .poll(async () => (await tabNumbers(app)).filter((n) => DRUM_NUMBERS.test(n)).length, {
        timeout: 15_000,
      })
      .toBeGreaterThan(4);
    // The tab staff is labelled TAB and there is no tuning line for it.
    await expect(
      scoreRegion(app).locator(".at-surface svg text").filter({ hasText: "Tuning" }),
    ).toHaveCount(0);
    await expectNoA11yViolations(app);
  });

  test("shows score and drum tab together, and goes back to the score", async ({ app }) => {
    await openSong(app);
    await showDrums(app, "Score + tab");
    await expect
      .poll(async () => (await tabNumbers(app)).filter((n) => DRUM_NUMBERS.test(n)).length, {
        timeout: 15_000,
      })
      .toBeGreaterThan(4);
    await app
      .getByRole("radiogroup", { name: "Notation" })
      .getByRole("radio", { name: "Score", exact: true })
      .click();
    await expect
      .poll(async () => (await tabNumbers(app)).filter((n) => DRUM_NUMBERS.test(n)).length)
      .toBe(0);
  });

  test("plays as before (the mirror is silent) and moves the edit cursor on a click", async ({
    app,
  }) => {
    await openSong(app);
    await showDrums(app, "Tab");
    await app.getByRole("button", { name: "Edit" }).click();
    const firstHit = scoreRegion(app)
      .locator(".at-surface svg text")
      .filter({ hasText: DRUM_NUMBERS })
      .first();
    // alphaTab's drawing surface takes the pointer events for the text on it.
    await firstHit.click({ force: true });
    await expect.poll(() => editorStatus(app)).toMatch(/Bar 1/);
    await expect(app.getByTestId("edit-cursor")).toBeVisible();

    await app.getByRole("button", { name: "Edit" }).click();
    await app.getByRole("button", { name: "Play" }).click();
    await expect(app.getByRole("button", { name: "Pause" })).toBeVisible();
    await app.getByRole("button", { name: "Stop" }).click();
  });

  test("is readable in dark mode", async ({ app }) => {
    await app.emulateMedia({ colorScheme: "dark" });
    await openSong(app);
    await showDrums(app, "Tab");
    await expectNoA11yViolations(app);
  });

  test("the virtual drumkit enters a drum by name at the cursor (#45)", async ({ app }) => {
    await openSong(app);
    await app.getByRole("combobox", { name: "Track" }).click();
    await app.getByRole("option", { name: "Drums" }).click();
    await app.getByRole("button", { name: "Drum pads" }).click();
    await app.getByRole("button", { name: "Edit" }).click();
    await app
      .getByRole("radiogroup", { name: "Drum view" })
      .getByRole("radio", { name: "Virtual drumkit" })
      .click();
    const kit = app.getByTestId("virtual-drumkit");
    await expect(kit.getByRole("region", { name: "Cymbals" })).toBeVisible();
    await expectNoA11yViolations(app);

    await kit.getByRole("button", { name: "Snare (rim shot), 91" }).click();
    await expect.poll(() => editorStatus(app)).toMatch(/Snare \(rim shot\)/);
    await expect(kit.getByRole("button", { name: "Snare (rim shot), 91" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });
});
