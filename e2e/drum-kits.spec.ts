import type { Page } from "@playwright/test";

import { emitMenuAction, expect, expectNoA11yViolations, openSong, test } from "./fixtures";

async function withEngineOnDrums(app: Page) {
  await openSong(app);
  await app.getByRole("switch", { name: "Native engine with effects" }).click();
  await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
  await app.getByRole("combobox", { name: "Track" }).click();
  await app.getByRole("option", { name: "Drums" }).click();
}

async function importKit(app: Page, path: string) {
  await app.evaluate((p) => (window.__dialogResult = p), path);
  await app.getByRole("button", { name: "Kits…" }).click();
  const dialog = app.getByRole("dialog", { name: "Drum kits" });
  await dialog.getByRole("button", { name: "Import a kit…" }).click();
  return dialog;
}

/** Imported drum kits (#40). */
test.describe("drum kits (#40)", () => {
  test("imports a CC BY kit, plays it on the drum track and credits it", async ({ app }) => {
    await withEngineOnDrums(app);
    const dialog = await importKit(app, "/kits/cc-by/Free Kit/kit.sfz");
    const kit = dialog.getByTestId("drum-kit");
    await expect(kit).toContainText("Free Kit");
    await expect(kit).toContainText("Recorded by Test Drummer");
    await expectNoA11yViolations(app);
    await dialog.getByRole("button", { name: "Done" }).click();

    await app.getByRole("combobox", { name: "Drum kit" }).click();
    await app.getByRole("option", { name: "Free Kit" }).click();
    await expect
      .poll(() => app.evaluate(() => window.__engineConfig.kits[2] ?? null))
      .toBe("kit-1");

    // The drum mixer works with the imported kit.
    await app.getByRole("button", { name: "Drum mixer…" }).click();
    const mixer = app.getByRole("dialog", { name: "Drum mixer: Drums" });
    await expect(mixer.getByTestId("drum-element")).toHaveCount(17);
    await mixer.getByRole("button", { name: "Done" }).click();

    await emitMenuAction(app, "licenses");
    const licences = app.getByRole("dialog", { name: "Open-source licenses" });
    await expect(licences.getByTestId("kit-credit")).toContainText(
      "Free Kit — CC BY (credit the author). Recorded by Test Drummer",
    );
  });

  test("refuses a non-commercial kit", async ({ app }) => {
    await withEngineOnDrums(app);
    const dialog = await importKit(app, "/kits/nc/Not For Sale/kit.sfz");
    await expect(dialog.getByRole("alert")).toContainText("non-commercial");
    await expect(
      dialog.getByRole("heading", { name: "This kit cannot be imported" }),
    ).toBeVisible();
    await expect(dialog.getByTestId("drum-kit")).toHaveCount(0);
  });

  test("asks about an unknown licence and imports after confirmation", async ({ app }) => {
    await app.emulateMedia({ colorScheme: "dark" });
    await withEngineOnDrums(app);
    const dialog = await importKit(app, "/kits/Mystery Kit/kit.sf2");
    await expect(dialog.getByRole("alert")).toContainText("confirm");
    await dialog.getByRole("combobox", { name: "Licence" }).click();
    await app.getByRole("option", { name: "I don't know the licence" }).click();
    await dialog.getByRole("checkbox", { name: /I have the right to use this kit/ }).click();
    await expectNoA11yViolations(app);
    await dialog.getByRole("button", { name: "Import the kit" }).click();
    await expect(dialog.getByTestId("drum-kit")).toContainText("Mystery Kit");
    await expect(dialog.getByTestId("drum-kit")).toContainText("Unknown");

    // Removing it puts the track back on the built-in sounds.
    await dialog.getByRole("button", { name: "Remove Mystery Kit" }).click();
    await expect(dialog.getByTestId("drum-kit")).toHaveCount(0);
  });
});
