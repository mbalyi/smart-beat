import type { Page } from "@playwright/test";

import {
  emitMenuAction,
  expect,
  expectNoA11yViolations,
  expectTab,
  newSong,
  openSong,
  scoreRegion,
  test,
  waitForAnimations,
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

/** The track list at the bottom: names, in order. */
const trackNames = (page: Page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        "[aria-label='Tracks and mixer'] ol > li button[aria-label^='Show ']",
      ),
    ].map((b) => b.getAttribute("aria-label")?.replace(/^Show /, "")),
  );

/** What the track list says about each track's instrument (the tooltip of its name). */
const trackInstruments = (page: Page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        "[aria-label='Tracks and mixer'] ol > li button[aria-label^='Show ']",
      ),
    ].map((b) => b.getAttribute("title")),
  );

/** Picks an action from a track row's "⋮" menu. */
async function trackAction(page: Page, track: string, action: string) {
  await page.getByRole("button", { name: `Actions for ${track}` }).click();
  await page.getByRole("menuitem", { name: action }).click();
}

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
    // Drums can be shown as a drum tab (#49).
    await expect(app.getByRole("radio", { name: "Tab", exact: true })).toBeEnabled();

    expect(await trackNames(app)).toEqual([
      "Guitar",
      "7-String Guitar",
      "5-String Bass",
      "Banjo",
      "Drums",
    ]);
    expect(await trackInstruments(app)).toEqual([
      "Acoustic Guitar (steel) · Guitar Standard Tuning",
      "Distortion Guitar · Guitar 7 strings",
      "Electric Bass (finger) · Bass 5 Strings Tuning",
      "Banjo · Banjo Open G Tuning",
      "Drums",
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
    await trackAction(app, "Piano", "Move up");
    await trackAction(app, "Guitar", "Duplicate");
    await trackAction(app, "Bass", "Remove");
    expect(await trackNames(app)).toEqual(["Guitar", "Guitar 2", "Piano", "Drums"]);

    await emitMenuAction(app, "undo");
    expect(await trackNames(app)).toEqual(["Guitar", "Guitar 2", "Bass", "Piano", "Drums"]);

    // The mixer follows: the duplicated guitar has its own strip.
    await expect(app.getByRole("slider", { name: "Volume, Guitar 2" })).toBeVisible();
    await expect(app.getByRole("button", { name: "Mute Piano" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("lists each tuning from the lowest string, E A D G B E (#119)", async ({ app }) => {
    await openSong(app);
    await emitMenuAction(app, "track-settings");
    const dialog = app.getByRole("dialog", { name: "Track settings" });
    await dialog.getByRole("combobox", { name: "Tuning" }).click();
    await expect(app.getByRole("option", { name: /\(E A D G B E\)$/ }).first()).toBeVisible();
    await expect(
      app.getByRole("option", { name: /^Guitar Dropped D Tuning \(D A D G B E\)$/ }),
    ).toBeVisible();
    await expect(app.getByRole("option", { name: /\(E B G D A E\)$/ })).toHaveCount(0);
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

    expect((await trackInstruments(app))[0]).toBe(
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

  test("only offers fretted sounds for a guitar and shows the current one again (#134)", async ({
    app,
  }) => {
    await openSong(app);
    await emitMenuAction(app, "track-settings");
    const dialog = app.getByRole("dialog", { name: "Track settings" });
    await dialog.getByRole("combobox", { name: "Sound (General MIDI)" }).click();
    await expect(app.getByRole("option", { name: "34. Electric Bass (finger)" })).toBeVisible();
    await expect(app.getByRole("option", { name: /Acoustic Grand Piano/ })).toHaveCount(0);
    await app.getByRole("option", { name: "28. Electric Guitar (clean)" }).click();
    await dialog.getByRole("button", { name: "Apply" }).click();

    await emitMenuAction(app, "track-settings");
    await expect(
      app
        .getByRole("dialog", { name: "Track settings" })
        .getByRole("combobox", { name: "Sound (General MIDI)" }),
    ).toHaveText("28. Electric Guitar (clean)");
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`copies a guitar to a piano track, accessibly in ${colorScheme} mode (#134)`, async ({
      app,
    }) => {
      await app.emulateMedia({ colorScheme });
      await openSong(app);
      await trackAction(app, "Guitar", "Copy to instrument…");
      const dialog = app.getByRole("dialog", { name: "Copy to instrument" });
      await expect(dialog).toBeVisible();
      await waitForAnimations(app);
      await expectNoA11yViolations(app);
      await dialog.getByRole("button", { name: "Copy track" }).click();
      await expect(dialog).toBeHidden();

      expect(await trackNames(app)).toEqual(["Guitar", "Guitar (Piano)", "Bass", "Drums", "Piano"]);
      expect((await trackInstruments(app))[1]).toBe("Acoustic Grand Piano");
      await emitMenuAction(app, "undo");
      expect(await trackNames(app)).toEqual(["Guitar", "Bass", "Drums", "Piano"]);
    });
  }
});
