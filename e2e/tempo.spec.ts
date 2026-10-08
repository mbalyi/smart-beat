import type { Page } from "@playwright/test";

import { expect, expectNoA11yViolations, openSong, test } from "./fixtures";

/** Tempo editing (#46): the song's tempo, and a tempo for some bars only, with real playback timing. */

async function openTempo(page: Page) {
  await page.getByRole("button", { name: "Tools" }).click();
  await page.getByRole("menuitem", { name: "Tempo…" }).click();
  return page.getByRole("dialog", { name: "Tempo" });
}

test.describe("tempo (#46)", () => {
  test("a new song tempo changes the length of the song and the LCD", async ({ app }) => {
    await openSong(app); // 60 BPM for two bars, then 120: 12 seconds
    const timer = app.getByRole("timer");
    await expect(timer).toContainText("/ 0:12");

    const dialog = await openTempo(app);
    await dialog.getByRole("radio", { name: /The whole song/ }).check();
    await dialog.getByRole("spinbutton", { name: "Tempo" }).fill("120");
    await dialog.getByRole("button", { name: "Apply" }).click();

    // Bars 1-2 now play at 120 too: 4 + 4 seconds.
    await expect(timer).toContainText("/ 0:08", { timeout: 15_000 });
    await expect(app.getByRole("group", { name: "Display" })).toContainText("♩ = 120");

    await app.getByRole("button", { name: /^Undo Change the song tempo/ }).click();
    await expect(timer).toContainText("/ 0:12", { timeout: 15_000 });
  });

  test("a tempo for some bars only, and the tempo that comes back after them", async ({ app }) => {
    await openSong(app);
    const dialog = await openTempo(app);
    await dialog.getByRole("radio", { name: /Only some bars/ }).check();
    await dialog.getByRole("spinbutton", { name: "From bar" }).fill("1");
    await dialog.getByRole("spinbutton", { name: "To bar" }).fill("1");
    await dialog.getByRole("spinbutton", { name: "Tempo" }).fill("240");
    await dialog.getByRole("button", { name: "Apply" }).click();

    // Bar 1 at 240 BPM: 1 s instead of 4 s; bar 2 goes back to 60 BPM (4 s), then 2 + 2.
    await expect(app.getByRole("timer")).toContainText("/ 0:09", { timeout: 15_000 });
  });

  test("shows the tempo in the inspector and opens the dialog from there", async ({ app }) => {
    await openSong(app);
    await app.getByRole("tab", { name: "Song" }).click();
    const inspector = app.getByRole("complementary", { name: "Inspector" });
    await expect(inspector).toContainText("♩ = 60");

    await inspector.getByRole("button", { name: "Change the tempo…" }).click();
    await expect(app.getByRole("dialog", { name: "Tempo" })).toBeVisible();
  });

  test("marks tempo changes above the bar grid and opens the dialog from the LCD", async ({
    app,
  }) => {
    await openSong(app); // 60 BPM for two bars, then 120
    const markers = app.getByTestId("tempo-markers");
    await expect(markers).toContainText("♩60");
    await expect(markers).toContainText("♩120");

    await app.getByRole("button", { name: /^Tempo 60 BPM\. Change the tempo/ }).click();
    await expect(app.getByRole("dialog", { name: "Tempo" })).toBeVisible();
  });

  test("a slower practice speed follows the tempo map (speed trainer)", async ({ app }) => {
    await openSong(app);
    const display = app.getByRole("group", { name: "Display" });
    await app.getByRole("combobox", { name: "Speed" }).click();
    await app.getByRole("option", { name: "50%", exact: true }).click();
    // Bars 1–2 at 60 BPM play at 30, bars 3–4 at 120 play at 60: both tempos are shown (#83).
    await app.getByRole("button", { name: "Play" }).click();
    await expect(display).toContainText("Song 60 · Playback 30 BPM", { timeout: 10_000 });
    await app.getByRole("button", { name: "Stop" }).click();
    await display.getByRole("spinbutton", { name: "Bar" }).fill("3");
    await display.getByRole("spinbutton", { name: "Bar" }).press("Enter");
    await app.getByRole("button", { name: "Play" }).click();
    await expect(display).toContainText("Song 120 · Playback 60 BPM", { timeout: 10_000 });
    await app.getByRole("button", { name: "Stop" }).click();
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the tempo dialog has no WCAG violations in ${colorScheme} mode`, async ({ app }) => {
      await app.emulateMedia({ colorScheme });
      await openSong(app);
      const dialog = await openTempo(app);
      await dialog.getByRole("radio", { name: /Only some bars/ }).check();
      await expect(dialog.getByRole("spinbutton", { name: "To bar" })).toBeVisible();
      await expectNoA11yViolations(app);
    });
  }
});
