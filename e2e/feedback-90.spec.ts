import {
  emitMenuAction,
  expect,
  expectNoA11yViolations,
  newSong,
  openSong,
  test,
} from "./fixtures";

/** Customer feedback (#90): fretboard delete, note preview, the Export dialog and EQ labels. */

test.describe("editing ergonomics (#90)", () => {
  test("double-clicking a fretboard note deletes it, and undo brings it back", async ({ app }) => {
    await newSong(app);
    await app.getByRole("button", { name: "Fretboard" }).click();
    const fret = app.getByRole("button", { name: "Fret 5, A4" });
    await fret.click();
    await expect(fret).toHaveAttribute("aria-pressed", "true");

    await fret.dblclick();
    await expect(fret).toHaveAttribute("aria-pressed", "false");

    await app.getByRole("button", { name: "Undo Delete note" }).click();
    await expect(fret).toHaveAttribute("aria-pressed", "true");
  });

  test("offers to switch off the note preview", async ({ app }) => {
    await newSong(app);
    const toggle = app.getByRole("switch", { name: "Play notes while editing" });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await app.reload();
    await newSong(app);
    await expect(app.getByRole("switch", { name: "Play notes while editing" })).not.toBeChecked();
  });
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the Export dialog lists the formats and has no WCAG violations in ${colorScheme} mode`, async ({
    app,
  }) => {
    await app.emulateMedia({ colorScheme });
    await openSong(app);
    await emitMenuAction(app, "export-all");
    const dialog = app.getByRole("dialog", { name: "Export" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Guitar Pro 5/ })).toContainText(".gp5");
    await expect(dialog.getByRole("button", { name: /MIDI/ })).toContainText(".mid");
    await expectNoA11yViolations(app);
  });
}

test.describe("EQ labels (#90)", () => {
  test("label each of the ten bands by frequency at a narrow width", async ({ app }) => {
    await app.setViewportSize({ width: 375, height: 800 });
    await openSong(app);
    await app.getByRole("button", { name: "EQ for Bass" }).click();
    await app.getByRole("switch", { name: "10-band EQ, Bass" }).click();
    const group = app.getByRole("group", { name: "Graphic EQ, Bass" });
    for (const freq of ["31 Hz", "125 Hz", "1 kHz", "8 kHz", "16 kHz"]) {
      await expect(group.getByText(freq, { exact: true })).toBeVisible();
    }
    await expect(group.getByText("Bass", { exact: true })).toHaveCount(0);
    await expectNoA11yViolations(app);
  });
});
