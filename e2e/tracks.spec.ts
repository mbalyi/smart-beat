import type { Page } from "@playwright/test";

import {
  emitMenuAction,
  expect,
  expectTab,
  newSong,
  openSong,
  scoreRegion,
  test,
} from "./fixtures";

/** Track and instrument management (#10) with the real renderer. */

async function addTrack(page: Page, instrument: string) {
  await emitMenuAction(page, "add-track");
  const dialog = page.getByRole("dialog", { name: "Add track" });
  await dialog.getByRole("combobox", { name: "Instrument" }).click();
  await page.getByRole("option", { name: instrument }).click();
  await dialog.getByRole("button", { name: "Add track" }).click();
  await expect(dialog).toBeHidden();
}

const trackNames = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[role=dialog] ol > li h3")].map((h) =>
      h.textContent?.replace(/^\d+\.\s*/, "").replace(" (shown)", ""),
    ),
  );

test.describe("tracks and instruments (#10)", () => {
  test("adds guitars, basses, banjo and drums, each with its own staff", async ({ app }) => {
    await newSong(app);

    await addTrack(app, "Guitar (7 strings)");
    await expect(scoreRegion(app)).toHaveAccessibleName("Score: 7-String Guitar");
    await expect(app.getByRole("radio", { name: "Score + tab" })).toBeChecked();
    await addTrack(app, "Bass (5 strings)");
    await addTrack(app, "Banjo (5 strings)");
    await addTrack(app, "Drums");
    await expect(scoreRegion(app)).toHaveAccessibleName("Score: Drums");
    await expect(app.getByRole("radio", { name: "Tab", exact: true })).toBeDisabled();

    await app.getByRole("button", { name: "Tracks" }).click();
    const panel = app.getByRole("dialog", { name: "Tracks" });
    await expect(panel.getByRole("listitem")).toHaveText([
      /Guitar.*Acoustic Guitar \(steel\) · Guitar Standard Tuning/,
      /7-String Guitar.*Distortion Guitar · Guitar 7 strings/,
      /5-String Bass.*Electric Bass \(finger\) · Bass 5 Strings Tuning/,
      /Banjo.*Banjo · Banjo Open G Tuning/,
      /Drums.*Drums/,
    ]);
  });

  test("writes on a new 8-string guitar and plays it", async ({ app }) => {
    await newSong(app);
    await addTrack(app, "Guitar (8 strings)");
    await expect(scoreRegion(app)).toBeFocused(); // back in the score to write

    for (let i = 0; i < 7; i++) await app.keyboard.press("ArrowDown"); // the low F#
    await app.keyboard.press("0");
    await expectTab(app, ["0"]);

    await app.getByRole("button", { name: "Play" }).click();
    await expect(app.getByRole("button", { name: "Pause" })).toBeVisible();
  });

  test("removes, reorders and duplicates tracks, with undo", async ({ app }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Tracks" }).click();
    const panel = app.getByRole("dialog", { name: "Tracks" });

    await panel.getByRole("button", { name: "Move Piano up" }).click();
    await panel.getByRole("button", { name: "Duplicate Guitar" }).click();
    await panel.getByRole("button", { name: "Remove Bass" }).click();
    expect(await trackNames(app)).toEqual(["Guitar", "Guitar 2", "Piano", "Drums"]);

    await app.keyboard.press("Escape");
    await emitMenuAction(app, "undo");
    await app.getByRole("button", { name: "Tracks" }).click();
    expect(await trackNames(app)).toEqual(["Guitar", "Guitar 2", "Bass", "Piano", "Drums"]);

    // The mixer follows: the duplicated guitar has its own strip.
    await app.keyboard.press("Escape");
    await app.getByRole("button", { name: "Mixer" }).click();
    await expect(app.getByRole("slider", { name: "Volume, Guitar 2" })).toBeVisible();
    await expect(app.getByRole("button", { name: "Mute Piano" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("changes tuning, capo and instrument", async ({ app }) => {
    await openSong(app);
    await emitMenuAction(app, "track-settings");
    const dialog = app.getByRole("dialog", { name: "Track settings" });

    await dialog.getByRole("combobox", { name: "Tuning" }).click();
    await app.getByRole("option", { name: /^Guitar Dropped D Tuning \(/ }).click();
    await dialog.getByRole("spinbutton", { name: "Capo" }).fill("2");
    await dialog.getByRole("combobox", { name: "Sound (General MIDI)" }).click();
    await app.getByRole("option", { name: "26. Acoustic Guitar (steel)" }).click();
    await dialog.getByRole("button", { name: "Apply" }).click();

    await app.getByRole("button", { name: "Tracks" }).click();
    await expect(app.getByRole("dialog", { name: "Tracks" })).toContainText(
      "Acoustic Guitar (steel) · Guitar Dropped D Tuning · Capo 2",
    );
  });

  test("shows the drum-kit notation of drum tracks", async ({ app }) => {
    await newSong(app);
    await emitMenuAction(app, "add-track");
    const dialog = app.getByRole("dialog", { name: "Add track" });
    await dialog.getByRole("combobox", { name: "Instrument" }).click();
    await app.getByRole("option", { name: "Drums" }).click();

    const kit = dialog.getByRole("table");
    await expect(kit.getByRole("row", { name: /Kick drum/ })).toContainText("36");
    await expect(kit.getByRole("row", { name: /Hi-hat \(closed\)/ })).toContainText(
      "Space above the staff",
    );
  });
});
