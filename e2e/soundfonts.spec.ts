import type { Page } from "@playwright/test";

import { expect, expectNoA11yViolations, openSong, test } from "./fixtures";

declare global {
  interface Window {
    __soundfonts: {
      items: { id: string; name: string; catalogue: string | null }[];
      activated: string[];
      downloads: string[];
      cancelled: number;
      hold: boolean;
      fail?: string;
    };
  }
}

async function openDialog(app: Page) {
  await app.getByRole("button", { name: "SoundFonts…" }).click();
  return app.getByRole("dialog", { name: "SoundFonts" });
}

async function importFile(app: Page, path: string) {
  await app.evaluate((p) => (window.__dialogResult = p), path);
  const dialog = await openDialog(app);
  await dialog.getByRole("button", { name: "Import a SoundFont…" }).click();
  return dialog;
}

/** Extra SoundFonts: import, download, remove (#81). The fixture serves Sonivox as High quality. */
test.describe("SoundFonts (#81)", () => {
  test("plays with High quality until the user picks something else", async ({ app }) => {
    // Nothing chosen yet (the fixture picks Sonivox so that other tests stay as they were).
    await app.addInitScript(() => localStorage.removeItem("smart-beat:soundfont"));
    await app.reload();
    await openSong(app);
    await expect(app.getByRole("combobox", { name: "Instrument sounds" })).toHaveText(
      /High quality/,
    );
    await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
  });

  test("imports a file, picks it as the instrument sounds and removes it again", async ({
    app,
  }) => {
    await openSong(app);
    const dialog = await importFile(app, "/music/My Bank.sf2");
    const row = dialog.getByTestId("imported-soundfont");
    await expect(row).toContainText("My Bank");
    await dialog.getByRole("button", { name: "Done" }).click();

    // It is in the list of instrument sounds, after the two built-in sets.
    await app.getByRole("combobox", { name: "Instrument sounds" }).click();
    await expect(app.getByRole("option")).toHaveText([
      /Standard/,
      /High quality/,
      /My Bank · Imported/,
    ]);
    await app.getByRole("option", { name: /My Bank/ }).click();
    await expect(app.getByRole("combobox", { name: "Instrument sounds" })).toHaveText(/My Bank/);
    await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });

    // Removing the one in use goes back to the default sounds.
    const again = await openDialog(app);
    await again.getByRole("button", { name: "Remove My Bank" }).click();
    await expect(again).toContainText("In use. Playback switches to the default sounds.");
    await again.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(again.getByTestId("imported-soundfont")).toHaveCount(0);
    await again.getByRole("button", { name: "Done" }).click();
    await expect(app.getByRole("combobox", { name: "Instrument sounds" })).toHaveText(
      /High quality/,
    );
    await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
    expect(await app.evaluate(() => window.__soundfonts.items)).toEqual([]);
  });

  test("refuses a file that is not a SoundFont", async ({ app }) => {
    await openSong(app);
    const dialog = await importFile(app, "/music/notes.txt");
    await expect(dialog.getByRole("alert")).toContainText("Choose a SoundFont file");
    await expect(dialog.getByTestId("imported-soundfont")).toHaveCount(0);
  });

  test("lists the recommended banks and downloads one, which then appears in the list", async ({
    app,
  }) => {
    await openSong(app);
    const dialog = await openDialog(app);
    const banks = dialog.getByTestId("catalogue-soundfont");
    await expect(banks).toHaveCount(5);
    await expect(banks.nth(0)).toContainText("MuseScore General");
    await expect(banks.nth(0)).toContainText("MIT");
    await expect(banks.nth(3)).toContainText("Timbres of Heaven");
    await expect(banks.nth(3)).toContainText("Personal use only");
    await expect(banks.nth(4)).toContainText("Arachno");

    await dialog.getByRole("button", { name: "Download MuseScore General" }).click();
    await expect(banks.nth(0)).toContainText("Installed");
    await expect(banks.nth(0).getByRole("button", { name: /^Download/ })).toHaveCount(0);
    expect(await app.evaluate(() => window.__soundfonts.downloads)).toEqual(["musescore-general"]);
    await dialog.getByRole("button", { name: "Done" }).click();

    await app.getByRole("combobox", { name: "Instrument sounds" }).click();
    await app.getByRole("option", { name: /MuseScore General · Downloaded/ }).click();
    await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
  });

  test("shows progress, lets the user cancel and then try again", async ({ app }) => {
    await openSong(app);
    await app.evaluate(() => (window.__soundfonts.hold = true));
    const dialog = await openDialog(app);

    await dialog.getByRole("button", { name: "Download Arachno" }).click();
    await expect(dialog.getByRole("progressbar", { name: "Downloading Arachno" })).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    // One at a time.
    await expect(dialog.getByRole("button", { name: "Download MuseScore General" })).toBeDisabled();
    await expectNoA11yViolations(app);

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog.getByRole("progressbar")).toHaveCount(0);
    await expect(dialog.getByRole("alert")).toHaveCount(0); // cancelling is not an error
    expect(await app.evaluate(() => window.__soundfonts.cancelled)).toBe(1);
    await expect(dialog.getByRole("button", { name: "Download Arachno" })).toBeEnabled();
  });

  test("tells the user when a download fails", async ({ app }) => {
    await openSong(app);
    await app.evaluate(
      () => (window.__soundfonts.fail = "The downloaded file is not the expected one."),
    );
    const dialog = await openDialog(app);

    await dialog.getByRole("button", { name: "Download GeneralUser GS" }).click();

    await expect(dialog.getByRole("alert")).toContainText("not the expected one");
    await expect(dialog.getByRole("button", { name: "Download GeneralUser GS" })).toBeEnabled();
    expect(await app.evaluate(() => window.__soundfonts.items)).toEqual([]);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the dialog has no WCAG violations in ${colorScheme} mode`, async ({ app }) => {
      await app.emulateMedia({ colorScheme });
      await openSong(app);
      const dialog = await importFile(app, "/music/My Bank.sf2");
      await dialog.getByRole("button", { name: "Download Arachno" }).click();
      await expect(dialog.getByTestId("catalogue-soundfont").nth(4)).toContainText("Installed");
      await expectNoA11yViolations(app);
    });
  }
});
