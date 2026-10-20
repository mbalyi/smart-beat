import type { Page } from "@playwright/test";

import {
  editorStatus,
  emitMenuAction,
  expect,
  expectNoA11yViolations,
  openSong,
  scoreRegion,
  tabNumbers,
  test,
  waitForAnimations,
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
    // The score redraws when edit mode opens: click once it has settled.
    await expect(app.getByRole("toolbar", { name: "Edit" })).toBeVisible();
    await waitForAnimations(app);
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

  test("the cursor moves over every line of the drum tab and stays after a delete (#178)", async ({
    app,
  }) => {
    await openSong(app);
    await showDrums(app, "Tab");
    await app.getByRole("button", { name: "Edit" }).click();
    await expect(app.getByRole("toolbar", { name: "Edit" })).toBeVisible();
    await waitForAnimations(app);
    const firstHit = scoreRegion(app)
      .locator(".at-surface svg text")
      .filter({ hasText: DRUM_NUMBERS })
      .first();
    await firstHit.click({ force: true });
    await expect(app.getByTestId("edit-cursor")).toBeVisible();
    // Up goes to the drum on the top line of the beat (WebKit's click does not pick the note).
    await app.keyboard.press("ArrowUp");
    await expect(app.getByTestId("edit-cursor-note").first()).toBeVisible();
    const frame = () => app.getByTestId("edit-cursor-note").last();
    const before = (await frame().boundingBox())!;

    // Down through the lines, empty ones too: the frame always follows.
    const ys = new Set<number>();
    for (let i = 0; i < 5; i++) {
      await app.keyboard.press("ArrowDown");
      await expect(frame()).toBeVisible();
      ys.add(Math.round((await frame().boundingBox())!.y));
    }
    expect(ys.size).toBeGreaterThanOrEqual(4);

    // Back on the first hit's line: delete it, the cursor stays on that line.
    for (let i = 0; i < 5; i++) await app.keyboard.press("ArrowUp");
    await expect
      .poll(async () => Math.abs((await frame().boundingBox())!.y - before.y))
      .toBeLessThan(2);
    await app.keyboard.press("Delete");
    await expect(frame()).toBeVisible();
    expect(Math.abs((await frame().boundingBox())!.y - before.y)).toBeLessThan(2);
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

  test("normalizes the drum notation from the track menu and the inspector (#135)", async ({
    app,
  }) => {
    await openSong(app);
    await showDrums(app, "Tab");
    await expect(app.getByRole("toolbar", { name: "Edit" })).toBeHidden();

    // From the hamburger menu of the track bar: edit mode opens, the score is not saved.
    await app.getByRole("button", { name: "Actions for Drums" }).click();
    await app.getByRole("menuitem", { name: "Normalize drum notation" }).click();
    await expect(app.getByRole("toolbar", { name: "Edit" })).toBeVisible();
    await expect(app.getByText("Drum notation normalized")).toBeVisible();
    // One undo step puts the notation back.
    await emitMenuAction(app, "undo");

    // The same action from the inspector, from view mode again.
    await app.getByRole("button", { name: "Edit" }).click();
    await expect(app.getByRole("toolbar", { name: "Edit" })).toBeHidden();
    await app.getByRole("tab", { name: "Track" }).click();
    await app.getByRole("button", { name: "Normalize drum notation", exact: true }).click();
    await expect(app.getByRole("toolbar", { name: "Edit" })).toBeVisible();

    // Other tracks do not offer it.
    await app.getByRole("button", { name: "Actions for Guitar" }).click();
    await expect(app.getByRole("menuitem", { name: "Normalize drum notation" })).toHaveCount(0);
  });
});
