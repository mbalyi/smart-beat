import type { Page } from "@playwright/test";

import { expect, expectNoA11yViolations, openSong, scoreRegion, test } from "./fixtures";

/** Customer feedback (#83 §13): the Speed Trainer and the score's own right-click menu. */

const STRUCTURE_SONG = "/Users/me/Music/structure-song.gp";

/** Right-clicks the first fret number drawn in the score. */
async function rightClickANote(app: Page) {
  const note = scoreRegion(app)
    .locator(".at-surface svg text")
    .filter({ hasText: /^\d+$/ })
    .filter({ hasNotText: /^1$/ }) // not the bar number
    .first();
  // WebKit counts the drawing above the text as covering it; the click lands on the note.
  await note.click({ button: "right", force: true });
}

test.describe("Speed Trainer and score menu (#83)", () => {
  test("tells the song's tempo from the one heard at a lower speed", async ({ app }) => {
    await openSong(app);
    await app.getByRole("combobox", { name: "Speed" }).click();
    await app.getByRole("option", { name: "50%", exact: true }).click();
    const tempo = app.getByRole("button", { name: /^Song tempo 60 BPM, heard at 30 BPM/ });
    await expect(tempo).toHaveText("Song 60 · Playback 30 BPM");
    await tempo.click();
    await expect(app.getByTestId("tempo-at-speed")).toContainText(
      "Song: 60 BPM · Playback: 30 BPM at 50% speed",
    );
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`right-clicking the score offers Smart Beat's actions, in ${colorScheme} mode`, async ({
      app,
    }) => {
      await app.emulateMedia({ colorScheme });
      await openSong(app);
      await rightClickANote(app);
      const menu = app.getByRole("menu", { name: "Score actions" });
      await expect(menu).toBeVisible();
      await expect(menu).toContainText(/Bar \d+/);
      await expect(menu.getByRole("menuitem", { name: "Play from here" })).toBeEnabled();
      await expectNoA11yViolations(app, { popup: "[role=menu]" });
      await menu.getByRole("menuitem", { name: "Loop this bar" }).click();
      await expect(app.getByRole("button", { name: "Loop" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      const from = await app.getByRole("spinbutton", { name: "Loop from bar" }).inputValue();
      await expect(app.getByRole("spinbutton", { name: "Loop to bar" })).toHaveValue(from);
    });
  }

  test("sets the loop's ends and starts the Speed Trainer from the menu", async ({ app }) => {
    await openSong(app);
    await rightClickANote(app);
    await app.getByRole("menuitem", { name: "Set loop start here" }).click();
    await expect(app.getByRole("button", { name: "Loop" })).toHaveAttribute("aria-pressed", "true");
    await rightClickANote(app);
    await app.getByRole("menuitem", { name: "Start Speed Trainer here…" }).click();
    const dialog = app.getByRole("dialog", { name: "Speed Trainer" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("checkbox", { name: "Count in before every loop" }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "Start" }).click();
    await expect(app.getByRole("status").filter({ hasText: "Trainer 60% → 100%" })).toBeVisible();
    await app.getByRole("button", { name: "Stay at this speed" }).click();
    await expect(
      app.getByRole("status").filter({ hasText: "Trainer staying at 60%" }),
    ).toBeVisible();
    await app.getByRole("button", { name: "Stop the Speed Trainer" }).click();
  });

  test("loops and trains a section chosen by name", async ({ app }) => {
    await openSong(app, STRUCTURE_SONG);
    await app.getByRole("button", { name: "Loop" }).click();
    await app.getByRole("combobox", { name: "Section" }).click();
    await app.getByRole("option", { name: /^Verse · bar/ }).click();
    const from = Number(await app.getByRole("spinbutton", { name: "Loop from bar" }).inputValue());
    expect(from).toBeGreaterThan(1);

    await app.getByRole("button", { name: "Speed Trainer…" }).click();
    const dialog = app.getByRole("dialog", { name: "Speed Trainer" });
    await dialog.getByRole("combobox", { name: "Section to practise" }).click();
    await app.getByRole("option", { name: /^Intro · bar/ }).click();
    await expect(dialog.getByRole("spinbutton", { name: "From bar" })).toHaveValue("1");
    await expectNoA11yViolations(app);
  });
});
