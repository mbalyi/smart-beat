import { expect, expectNoA11yViolations, openSong, playedSeconds, test } from "./fixtures";

/**
 * Effect chains (#34, #36, #42 via #49): the pedalboard, presets, the sound
 * library and the native engine switch. The engine itself is mocked (see
 * tauri-mock.js): these tests cover the UI and what it sends.
 */

test.describe("pedalboard and effects", () => {
  test("the EQ button opens the track's pedalboard at a new equaliser", async ({ app }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Equaliser and effects for Guitar" }).click();
    const dialog = app.getByRole("dialog", { name: "Effects: Guitar" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "1. Equalizer" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(dialog.getByRole("slider", { name: "Equalizer 1 kHz" })).toBeVisible();
    await expectNoA11yViolations(app);

    await dialog.getByRole("button", { name: "Add effect" }).click();
    await app.getByRole("menuitem", { name: "Noise gate" }).click();
    await expect(dialog.getByTestId("effect-block")).toHaveCount(2);
    await dialog.getByRole("button", { name: "Done" }).click();

    const chain = app.getByTestId("mini-chain");
    await expect(chain.getByRole("listitem")).toHaveCount(2);
    await expect(chain).toContainText("Equalizer");
    await expect(chain).toContainText("Noise gate");
  });

  test("loads a genre preset from the inspector's pedalboard", async ({ app }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Pedalboard…" }).click();
    const dialog = app.getByRole("dialog", { name: "Effects: Guitar" });
    await dialog.getByRole("combobox", { name: "Genre" }).click();
    await app.getByRole("option", { name: "Metalcore" }).click();
    await dialog.getByRole("combobox", { name: "Guitar presets" }).click();
    await app.getByRole("option", { name: /Metalcore tight/ }).click();
    await expect(dialog.getByTestId("effect-block")).toHaveCount(5);
    await expect(dialog.getByRole("button", { name: "4. Cabinet" })).toBeVisible();
  });

  test("the master chain holds three effects", async ({ app }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Master effects" }).click();
    const dialog = app.getByRole("dialog", { name: "Effects: Master" });
    await dialog.getByRole("combobox", { name: "Master presets" }).click();
    await app.getByRole("option", { name: /Loud metal master/ }).click();
    await expect(dialog.getByTestId("effect-block")).toHaveCount(3);
    await expect(dialog.getByRole("button", { name: "Add effect" })).toBeDisabled();
  });

  test("imports a cabinet into the sound library, renames and removes it", async ({ app }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Pedalboard…" }).click();
    await app.getByRole("button", { name: "Sound library…" }).click();
    const library = app.getByRole("dialog", { name: "Sound library" });
    await expect(library.getByText("4×12 modern (generated)")).toBeVisible();
    // Before the import: axe cannot judge the toast over the blurred backdrop.
    await expectNoA11yViolations(app);
    await app.evaluate(() => (window.__dialogResult = "/irs/V30 Mesa.wav"));
    await library.getByRole("button", { name: "Import .wav…" }).click();
    await expect(library.getByText("V30 Mesa", { exact: true })).toBeVisible();

    await library.getByRole("button", { name: "Rename V30 Mesa" }).click();
    await library.getByRole("textbox", { name: "Name of V30 Mesa" }).fill("Mesa 4×12");
    await library.getByRole("button", { name: "Save the name and tags" }).click();
    await expect(library.getByText("Mesa 4×12", { exact: true })).toBeVisible();
    await library.getByRole("button", { name: "Remove Mesa 4×12" }).click();
    await expect(library.getByText("Mesa 4×12", { exact: true })).toHaveCount(0);
  });

  test("the pedalboard passes the accessibility checks in dark mode", async ({ app }) => {
    await app.emulateMedia({ colorScheme: "dark" });
    await openSong(app);
    await app.getByRole("button", { name: "Master effects" }).click();
    await expect(app.getByRole("dialog", { name: "Effects: Master" })).toBeVisible();
    await expectNoA11yViolations(app);
  });

  test("the native engine plays through the effects and drives the cursor", async ({ app }) => {
    await openSong(app);
    await app.getByRole("switch", { name: "Native engine with effects" }).click();
    await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });

    await app.getByRole("button", { name: "Equaliser and effects for Guitar" }).click();
    await app
      .getByRole("dialog", { name: "Effects: Guitar" })
      .getByRole("button", { name: "Done" })
      .click();
    await expect
      .poll(() =>
        app.evaluate(() => window.__engineChains?.[0]?.map((s: { type: string }) => s.type)),
      )
      .toEqual(["eq"]);

    await app.getByRole("button", { name: "Play" }).click();
    await expect.poll(() => playedSeconds(app), { timeout: 10_000 }).toBeGreaterThan(0);
    await app.getByRole("button", { name: "Stop" }).click();
  });
});
