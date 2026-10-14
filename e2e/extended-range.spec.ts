import type { Page } from "@playwright/test";

import {
  editorStatus,
  emitMenuAction,
  expect,
  expectNoA11yViolations,
  expectTab,
  newSong,
  playedSeconds,
  scoreRegion,
  test,
} from "./fixtures";

/**
 * Extended-range guitars, low tunings, odd meters and nested tuplets (#43),
 * with the real renderer and player.
 */

async function addTrack(page: Page, instrument: string) {
  await emitMenuAction(page, "add-track");
  const dialog = page.getByRole("dialog", { name: "Add track" });
  await dialog.getByRole("combobox", { name: "Instrument" }).click();
  await page.getByRole("option", { name: instrument }).click();
  await dialog.getByRole("button", { name: "Add track" }).click();
  await expect(dialog).toBeHidden();
}

/** The lines of the staves in the first bar of the score: 5 for the notes, one per string for the tab. */
async function staffLines(page: Page): Promise<number> {
  return scoreRegion(page)
    .locator(".at-surface svg")
    .evaluateAll((svgs) => {
      const lines = svgs.flatMap((svg) =>
        [...svg.querySelectorAll("rect")]
          .map((r) => ({
            x: Number(r.getAttribute("x")),
            w: Number(r.getAttribute("width")),
            h: Number(r.getAttribute("height")),
          }))
          // A staff line is a long, thin rectangle.
          .filter((r) => r.w > 80 && r.h <= 2),
      );
      const first = Math.min(...lines.map((l) => l.x));
      return lines.filter((l) => l.x === first).length;
    });
}

/** What the track list says about each track's instrument (the tooltip of its name). */
const trackInstruments = (page: Page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        "[aria-label='Tracks and mixer'] ol > li button[aria-label^='Show ']",
      ),
    ].map((b) => b.getAttribute("title")),
  );

test.describe("extended-range guitars (#43)", () => {
  test("a 9-string guitar has nine tab lines, takes notes on its lowest string and re-tunes", async ({
    app,
  }) => {
    await newSong(app);
    // The first track is the 6-string guitar: five lines of notes and six of tab.
    await expect.poll(() => staffLines(app)).toBe(5 + 6);
    await addTrack(app, "Guitar (9 strings)");
    await expect(scoreRegion(app)).toBeFocused();
    await expect.poll(() => staffLines(app)).toBe(5 + 9);

    // The low C# is the ninth string down; an open string is fret 0.
    for (let i = 0; i < 8; i++) await app.keyboard.press("ArrowDown");
    await app.keyboard.press("0");
    await expectTab(app, ["0"]);
    expect(await editorStatus(app)).toContain("string 9");

    // Drop B (the lowest string a whole step down) keeps the pitch: the note moves up two frets.
    await emitMenuAction(app, "track-settings");
    const dialog = app.getByRole("dialog", { name: "Track settings" });
    await expect(dialog.getByRole("combobox", { name: "Strings" })).toHaveText("9 strings");
    await expect(dialog.getByRole("combobox", { name: "Tuning" })).toContainText("C# standard");
    await dialog.getByRole("combobox", { name: "Tuning" }).click();
    await app.getByRole("option", { name: /^Drop B \(/ }).click();
    await dialog.getByRole("button", { name: "Apply" }).click();
    await expect(dialog).toBeHidden();
    await expectTab(app, ["2"]);
    expect((await trackInstruments(app))[1]).toBe("Distortion Guitar · Drop B");
    await expect.poll(() => staffLines(app)).toBe(5 + 9);
  });

  test("writes on a 10-string guitar", async ({ app }) => {
    await newSong(app);
    await addTrack(app, "Guitar (8 strings)");
    await emitMenuAction(app, "track-settings");
    const dialog = app.getByRole("dialog", { name: "Track settings" });
    await dialog.getByRole("combobox", { name: "Strings" }).click();
    await app.getByRole("option", { name: "10 strings" }).click();
    // Two strings added a fourth lower each give G# standard.
    await expect(dialog.getByRole("combobox", { name: "Tuning" })).toContainText("G# standard");
    await dialog.getByRole("button", { name: "Apply" }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => staffLines(app)).toBe(5 + 10);
    for (let i = 0; i < 9; i++) await app.keyboard.press("ArrowDown");
    await app.keyboard.press("3");
    await expectTab(app, ["3"]);
    expect(await editorStatus(app)).toContain("string 10");
    await app.getByRole("button", { name: "Play" }).click();
    await expect(app.getByRole("button", { name: "Pause" })).toBeVisible();
  });

  test("warns about strings far below the sound, in the track settings and the track list", async ({
    app,
  }) => {
    await newSong(app);
    await addTrack(app, "Guitar (8 strings)");
    // The track list marks the 8-string guitar (F#1 is below the standard sound's recordings)...
    const mark = app.getByTestId("low-sound-mark");
    await expect(mark).toHaveCount(1);
    await expect(mark).toHaveAttribute("aria-label", /^7-String Guitar|^8-String Guitar/);

    await emitMenuAction(app, "track-settings");
    const dialog = app.getByRole("dialog", { name: "Track settings" });
    const warning = dialog.getByTestId("low-sound-warning");
    await expect(warning).toContainText("The lowest string (F#1)");
    await expect(warning).toContainText("High quality");
    await app.mouse.move(0, 0); // the button under the last click shows its hover colour
    await expectNoA11yViolations(app);
    // ...and it goes away with seven strings.
    await dialog.getByRole("combobox", { name: "Strings" }).click();
    await app.getByRole("option", { name: "7 strings" }).click();
    await expect(warning).toHaveCount(0);
    await dialog.getByRole("combobox", { name: "Strings" }).click();
    await app.getByRole("option", { name: "8 strings" }).click();
    await expect(warning).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });

  test("the track settings with a warning pass the accessibility checks in dark mode", async ({
    app,
  }) => {
    await app.emulateMedia({ colorScheme: "dark" });
    await newSong(app);
    await addTrack(app, "Guitar (9 strings)");
    await emitMenuAction(app, "track-settings");
    const dialog = app.getByRole("dialog", { name: "Track settings" });
    await expect(dialog.getByTestId("low-sound-warning")).toBeVisible();
    await expectNoA11yViolations(app);
  });
});

test.describe("odd time signatures (#43)", () => {
  /** Sets the time signature of every bar from the first one with the Bar dialog. */
  async function setTime(page: Page, beats: string, unit: string) {
    await page.getByRole("button", { name: "Bar…" }).click();
    const dialog = page.getByRole("dialog", { name: "Bar 1" });
    await dialog.getByRole("spinbutton", { name: "Beats per bar" }).fill(beats);
    await dialog.getByRole("combobox", { name: "Beat unit" }).click();
    await page.getByRole("option", { name: unit, exact: true }).click();
    await dialog.getByRole("button", { name: "Apply" }).click();
    await expect(dialog).toBeHidden();
  }

  test("7/8 and 5/8 bars are as long as they say, take their notes and play", async ({ app }) => {
    await newSong(app); // four 4/4 bars at 120 BPM
    await setTime(app, "7", "1/8 notes");
    // Four bars of seven eighths: 4 × 1.75 s.
    await expect(app.getByRole("timer")).toHaveText("0:00 / 0:07");
    await expect(app.getByRole("status", { name: "Bar lengths" })).toHaveCount(0);

    // Seven eighth notes fill the first bar exactly.
    await app.getByRole("radio", { name: "Eighth" }).click();
    for (let beat = 0; beat < 7; beat++) {
      await app.keyboard.press("0");
      if (beat < 6) await app.keyboard.press("ArrowRight");
    }
    await expectTab(app, ["0", "0", "0", "0", "0", "0", "0"]);
    await expect(app.getByRole("status", { name: "Bar lengths" })).toHaveCount(0);

    await setTime(app, "5", "1/8 notes");
    // The written bar is now two eighths too long, and the song says so.
    await expect(app.getByRole("status", { name: "Bar lengths" })).toContainText(
      "Bar 1 is 1 beat too long",
    );
    // The empty bars follow the new signature: 3 × 1.25 s, and the full bar is played as written.
    await expect(app.getByRole("timer")).toHaveText(/^0:00 \/ 0:0[56]$/);
    await app.getByRole("button", { name: "Fix bar" }).click();
    await expect(app.getByRole("status", { name: "Bar lengths" })).toHaveCount(0);
    await expect(app.getByRole("timer")).toHaveText("0:00 / 0:05");

    await app.getByRole("button", { name: "Play" }).click();
    await expect.poll(() => playedSeconds(app), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    await app.getByRole("button", { name: "Stop" }).click();
  });

  test("an 11/16 bar is 2.75 beats long", async ({ app }) => {
    await newSong(app);
    await setTime(app, "11", "1/16 notes");
    // Four bars of eleven sixteenths: 4 × 1.375 s = 5.5 s.
    await expect(app.getByRole("timer")).toHaveText(/^0:00 \/ 0:0[56]$/);
    await expect(app.getByRole("status", { name: "Bar lengths" })).toHaveCount(0);
    await expectNoA11yViolations(app);
  });
});

test.describe("nested tuplets (#43)", () => {
  test("a triplet of triplets is entered from the tuplet menu and shown as 9:4", async ({
    app,
  }) => {
    await newSong(app);
    await app.getByRole("radio", { name: "Eighth" }).click();
    await app.keyboard.press("0");

    await app.getByRole("combobox", { name: "Tuplet" }).click();
    await app.getByRole("option", { name: "Nested…" }).click();
    const dialog = app.getByRole("dialog", { name: "Nested tuplet" });
    await expect(dialog.getByTestId("nested-tuplet-result")).toContainText(
      "9 notes in the time of 4 (9:4)",
    );
    await expectNoA11yViolations(app);
    await dialog.getByRole("button", { name: "Apply" }).click();
    await expect(dialog).toBeHidden();
    await expect(scoreRegion(app)).toBeFocused();

    await expect(app.getByRole("combobox", { name: "Tuplet" })).toHaveText("9:4");
    await expectTab(app, ["0"]);
    // The score still draws and plays with the group in it.
    await expect.poll(() => app.getByRole("status").allTextContents()).toContain("Tuplet 9 in 4");
    await app.getByRole("button", { name: "Play" }).click();
    await expect(app.getByRole("button", { name: "Pause" })).toBeVisible();
    await app.getByRole("button", { name: "Stop" }).click();

    // Back to plain notes.
    await app.getByRole("combobox", { name: "Tuplet" }).click();
    await app.getByRole("option", { name: "None" }).click();
    await expect(app.getByRole("combobox", { name: "Tuplet" })).toHaveText("None");
  });
});
