import type { Locator, Page } from "@playwright/test";

import { expect, expectNoA11yViolations, openSong, test } from "./fixtures";

/**
 * Adding single audio files to the sample library: the fourth source of the Add samples
 * dialog. The files are always copied (never linked) into a folder of their own. The sample
 * commands are mocked in e2e/tauri-mock.js.
 */

test.use({ viewport: { width: 1280, height: 1000 } });

const PICKED = [
  "/Users/me/Music/Big Kick.wav",
  "/Users/me/Music/Loops/snare.flac",
  "/Users/me/Music/notes.txt",
];

async function openSamples(app: Page) {
  await openSong(app);
  await app.getByRole("tab", { name: "Samples" }).click();
}

/** Opens the dialog on its review step for the audio files source, with `paths` chosen. */
async function chooseFiles(app: Page, paths: string[]): Promise<Locator> {
  await app.getByRole("button", { name: "Add samples" }).first().click();
  const dialog = app.getByRole("dialog", { name: "Add samples" });
  await dialog.getByTestId("source-files").click();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await app.evaluate((p) => Object.assign(window, { __dialogResult: p }), paths);
  await dialog.getByRole("button", { name: "Choose files…" }).click();
  return dialog;
}

test.describe("adding audio files to the samples", () => {
  test("shows the file source as its own choice and says the files are copied", async ({ app }) => {
    await openSamples(app);
    await app.getByRole("button", { name: "Add samples" }).first().click();
    const dialog = app.getByRole("dialog", { name: "Add samples" });
    await expect(dialog.getByRole("radio")).toHaveCount(4);
    const files = dialog.getByTestId("source-files");
    await expect(files).toContainText("Add audio files");
    await expect(files).toContainText("copied");
    await files.focus();
    await app.keyboard.press("Enter");
    await expect(files).toHaveAttribute("aria-checked", "true");
    await dialog.getByRole("button", { name: "Continue" }).click();
    await expect(dialog.getByTestId("chosen-path")).toHaveText("No files chosen");
    await expect(dialog.getByRole("button", { name: "Copy files" })).toBeDisabled();
  });

  test("copies the chosen audio into a new folder and shows it in the list", async ({ app }) => {
    await openSamples(app);
    const dialog = await chooseFiles(app, PICKED);
    await expect(dialog.getByText("2 samples will be copied")).toBeVisible();
    const names = dialog.getByRole("list", { name: "Chosen files" }).getByRole("listitem");
    await expect(names).toHaveText(["Big Kick.wav", "snare.flac"]);
    await expect(dialog.getByText("1 skipped (not audio)")).toBeVisible();
    await expect(dialog.getByText(/The files are copied/)).toBeVisible();
    const name = dialog.getByRole("textbox", { name: "Folder name" });
    await expect(name).toHaveValue("Imported samples");
    await name.fill("My picks");
    await dialog.getByRole("button", { name: "Copy files" }).click();
    await expect(dialog.getByRole("heading", { name: "My picks is ready" })).toBeVisible();
    // Only the audio went to the core, and always as a copy.
    expect(await app.evaluate(() => window.__samples.fileImports)).toEqual([
      { paths: PICKED.slice(0, 2), name: "My picks" },
    ]);
    expect(await app.evaluate(() => window.__samples.folders[0]?.kind)).toBe("imported");
    await dialog.getByRole("button", { name: "Show samples" }).click();
    await expect(dialog).toBeHidden();
    await expect(app.getByRole("button", { name: /My picks/ })).toBeVisible();
    await expect(app.getByTestId("sample-row")).toHaveCount(2);
    await expect(app.getByText("Imported: a copy kept by Smart Beat.")).toBeVisible();
  });

  test("names the folder after a single file and will not copy a choice without audio", async ({
    app,
  }) => {
    await openSamples(app);
    const dialog = await chooseFiles(app, ["/Users/me/Music/notes.txt"]);
    await expect(dialog.getByText("No audio files in that choice")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Copy files" })).toBeDisabled();

    await app.evaluate(() =>
      Object.assign(window, { __dialogResult: ["/Users/me/Music/Big Kick.wav"] }),
    );
    await dialog.getByRole("button", { name: "Choose files…" }).click();
    await expect(dialog.getByRole("textbox", { name: "Folder name" })).toHaveValue("Big Kick");
    await expect(dialog.getByRole("button", { name: "Copy files" })).toBeEnabled();
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the audio files steps have no WCAG violations in ${colorScheme} mode`, async ({
      app,
    }) => {
      await app.emulateMedia({ colorScheme });
      await openSamples(app);
      await app.getByRole("button", { name: "Add samples" }).first().click();
      await expect(app.getByTestId("source-files")).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role='dialog']" });
      await app.getByRole("button", { name: "Close" }).last().click();
      const dialog = await chooseFiles(app, PICKED);
      await expect(dialog.getByText("2 samples will be copied")).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role='dialog']" });
    });
  }
});
