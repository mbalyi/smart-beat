import type { Page } from "@playwright/test";

import features from "../src/lib/features.json" with { type: "json" };

import { expect, expectNoA11yViolations, test } from "./fixtures";

declare global {
  interface Window {
    __cloud: {
      folder: string | null;
      scores: unknown[];
      meta: Record<string, { size: number; modified_ms: number }>;
      placeholders: Record<string, boolean>;
      savePaths: string[];
      estimates: { id: string; includeOriginal: boolean }[];
      estimateBytes: number | null;
      download: (path: string) => void;
    };
  }
}

/**
 * Saved stems in the linked cloud folder (#186, #187), with the cloud commands mocked in
 * e2e/tauri-mock.js: the folder, `list_cloud_stems`, `stems_cloud_save_path` and
 * `stems_estimate_bundle`. Smart Beat never uploads: a save into the folder is all it does.
 */

const FOLDER = "/Users/me/Google Drive/Smart Beat";
const SONG_PATH = "/Users/me/Music/neon-nights.mp3";
const CLOUD_FILE = `${FOLDER}/neon-nights.sbstems`;
const ELSEWHERE = "/Users/me/Music/neon-nights.sbstems";
const MB = 1024 * 1024;
const SAVED_IN_CLOUD =
  "Saved in your cloud folder. Your drive app uploads it; Smart Beat does not upload anything.";

test.describe("Stems in the cloud folder (#186)", () => {
  test.skip(!features["stem-separation"], "stem-separation is off in src/lib/features.json");

  const link = (app: Page) => app.evaluate((folder) => (window.__cloud.folder = folder), FOLDER);

  /** Welcome button, song, Fast engine, Separate, and the page. */
  async function separate(app: Page, path = SONG_PATH) {
    await app.getByRole("button", { name: "Stem separation…" }).click();
    const dialog = app.getByRole("dialog", { name: "Stem separation" });
    await app.evaluate((p) => (window.__dialogResult = p), path);
    await dialog.getByRole("button", { name: "Choose a song…" }).click();
    await dialog.getByRole("button", { name: "Next" }).click();
    await dialog.getByRole("radio", { name: "Fast" }).check();
    await dialog.getByRole("button", { name: "Separate" }).click();
    const name = path
      .split("/")
      .pop()!
      .replace(/\.[^.]+$/, "");
    await expect(app.getByRole("heading", { level: 1, name })).toBeVisible();
  }

  async function openSaveDialog(app: Page) {
    await app.getByRole("button", { name: "Save stems…" }).click();
    const dialog = app.getByRole("dialog", { name: "Save stems" });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  const save = (dialog: ReturnType<Page["getByRole"]>) =>
    dialog.getByRole("button", { name: "Save", exact: true });
  const where = (dialog: ReturnType<Page["getByRole"]>) =>
    dialog.getByRole("radiogroup", { name: "Where to save" });

  /** Links the folder, separates and saves into it with the dialog's defaults. */
  async function saveToCloud(app: Page) {
    await link(app);
    await separate(app);
    const dialog = await openSaveDialog(app);
    await save(dialog).click();
    await expect(dialog.getByText(SAVED_IN_CLOUD)).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).first().click();
    await expect(dialog).toBeHidden();
  }

  /** The start screen's section of stems in the cloud folder. */
  const cloudSection = (app: Page) =>
    app.getByRole("region", { name: "Stems in your cloud folder" });

  /**
   * Saves into the cloud folder, forgets the library copy and goes home. `prepare` runs just
   * before going home (the page's mock state is lost on a reload, so a test changes it here: the
   * cloud list is read when the start screen opens).
   */
  async function saveAndForget(app: Page, prepare?: () => Promise<void>) {
    await saveToCloud(app);
    await app.evaluate(() => (window.__stems.songs = []));
    await prepare?.();
    await app.getByRole("button", { name: "Back to start" }).click();
    await expect(app.getByRole("heading", { level: 1, name: /Practice, create/ })).toBeVisible();
  }

  test("saves to the cloud folder by default, without the native dialog", async ({ app }) => {
    await link(app);
    await separate(app);
    // The native Save dialog must not open: it would pick this path.
    await app.evaluate((path) => (window.__saveResult = path), ELSEWHERE);
    const dialog = await openSaveDialog(app);
    const group = where(dialog);
    await expect(group).toBeVisible();
    const cloud = group.getByRole("radio", { name: "Cloud folder · Smart Beat" });
    await expect(cloud).toBeChecked();
    await expect(group.getByRole("radio", { name: "Another place…" })).not.toBeChecked();

    await save(dialog).click();
    await expect(dialog.getByText(SAVED_IN_CLOUD)).toBeVisible();
    const saves = await app.evaluate(() => window.__stemBundles.saves);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ dest: CLOUD_FILE, includeOriginal: true });
    expect(await app.evaluate(() => window.__stems.songs[0].savedPath)).toBe(CLOUD_FILE);
  });

  test("gives a second save of the same song a numbered name", async ({ app }) => {
    await saveToCloud(app);
    const dialog = await openSaveDialog(app);
    await save(dialog).click();
    await expect(dialog.getByText(SAVED_IN_CLOUD)).toBeVisible();
    const saves = await app.evaluate(() => window.__stemBundles.saves.map((s) => s.dest));
    expect(saves).toEqual([CLOUD_FILE, `${FOLDER}/neon-nights (2).sbstems`]);
  });

  test("saves somewhere else when Another place is chosen", async ({ app }) => {
    await link(app);
    await separate(app);
    await app.evaluate((path) => (window.__saveResult = path), ELSEWHERE);
    const dialog = await openSaveDialog(app);
    await where(dialog).getByRole("radio", { name: "Another place…" }).check();
    await save(dialog).click();
    await expect(dialog.getByText(ELSEWHERE)).toBeVisible();
    await expect(dialog.getByText(SAVED_IN_CLOUD)).toHaveCount(0);
    const saves = await app.evaluate(() => window.__stemBundles.saves);
    expect(saves).toHaveLength(1);
    expect(saves[0].dest).toBe(ELSEWHERE);
    // Nothing was put in the cloud folder, so its list stays empty.
    await dialog.getByRole("button", { name: "Close" }).first().click();
    await app.getByRole("button", { name: "Back to start" }).click();
    await expect(cloudSection(app)).toHaveCount(0);
  });

  test("offers only the file chooser and a hint when no folder is linked", async ({ app }) => {
    await separate(app);
    await app.evaluate((path) => (window.__saveResult = path), ELSEWHERE);
    const dialog = await openSaveDialog(app);
    await expect(where(dialog)).toHaveCount(0);
    await expect(dialog.getByRole("radio")).toHaveCount(0);
    await expect(
      dialog.getByText("Link a cloud folder in Settings to keep stems in your cloud."),
    ).toBeVisible();
    await save(dialog).click();
    await expect(dialog.getByText(ELSEWHERE)).toBeVisible();
    await expect(dialog.getByText(SAVED_IN_CLOUD)).toHaveCount(0);
  });

  test("shows about how big the file will be, and updates it with the original song", async ({
    app,
  }) => {
    await link(app);
    await app.evaluate((bytes) => (window.__cloud.estimateBytes = bytes), 62 * MB);
    await separate(app);
    const dialog = await openSaveDialog(app);
    await expect(dialog.getByText("About 62 MB")).toBeVisible();
    await app.evaluate((bytes) => (window.__cloud.estimateBytes = bytes), 40 * MB);
    await dialog.getByRole("checkbox", { name: "Include the original song" }).uncheck();
    await expect(dialog.getByText("About 40 MB")).toBeVisible();
    const estimates = await app.evaluate(() => window.__cloud.estimates);
    expect(estimates.at(-1)).toMatchObject({ includeOriginal: false });
    expect(estimates.some((request) => request.includeOriginal)).toBe(true);
  });

  test("lists the saved stems in the cloud section and opens the stem page from it", async ({
    app,
  }) => {
    await saveAndForget(app);
    const section = cloudSection(app);
    await expect(section).toBeVisible();
    const card = section.getByRole("button", { name: /neon-nights/ });
    await expect(card.getByText("Stems", { exact: true })).toBeVisible();
    await expect(card.getByText("Cloud", { exact: true })).toBeVisible();
    await expect(card).toContainText("MB");
    await expect(card).not.toContainText("Waiting for download");

    await card.click();
    await expect(app.getByRole("heading", { level: 1, name: "neon-nights" })).toBeVisible();
    await expect(app.getByRole("list", { name: "Stems" }).getByRole("listitem")).toHaveCount(5);
    expect(await app.evaluate(() => window.__stemBundles.opens)).toEqual([CLOUD_FILE]);
  });

  test("does not show the cloud section when no folder is linked", async ({ app }) => {
    await separate(app);
    await app.getByRole("button", { name: "Back to start" }).click();
    await expect(app.getByRole("heading", { level: 1, name: /Practice, create/ })).toBeVisible();
    await expect(cloudSection(app)).toHaveCount(0);
  });

  test("shows a file that is only online as waiting for download, then opens it", async ({
    app,
  }) => {
    await saveAndForget(app, () =>
      app.evaluate((path) => {
        window.__cloud.placeholders[path] = true;
      }, CLOUD_FILE),
    );
    const card = cloudSection(app).getByRole("button", { name: /neon-nights/ });
    await expect(card).toContainText("Waiting for download");

    await card.click();
    await expect(card).toContainText("Downloading…");
    // The drive app has not finished: still on the start screen.
    await expect(app.getByRole("heading", { level: 1, name: /Practice, create/ })).toBeVisible();
    await app.evaluate((path) => window.__cloud.download(path), CLOUD_FILE);
    await expect(app.getByRole("heading", { level: 1, name: "neon-nights" })).toBeVisible();
    expect(await app.evaluate(() => window.__stemBundles.opens)).toEqual([CLOUD_FILE]);
  });

  test("marks a Recent stem card saved in the cloud folder, and not one saved elsewhere", async ({
    app,
  }) => {
    await saveToCloud(app);
    await app.getByRole("button", { name: "Back to start" }).click();
    await separate(app, "/Users/me/Music/blue-moon.mp3");
    await app.evaluate((path) => (window.__saveResult = path), "/Users/me/Music/blue-moon.sbstems");
    const dialog = await openSaveDialog(app);
    await where(dialog).getByRole("radio", { name: "Another place…" }).check();
    await save(dialog).click();
    await expect(dialog.getByText("/Users/me/Music/blue-moon.sbstems")).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).first().click();
    await app.getByRole("button", { name: "Back to start" }).click();

    const recent = (name: string) =>
      app
        .getByRole("listitem")
        .filter({ has: app.getByRole("button", { name: new RegExp(`^${name}`) }) })
        .filter({ has: app.getByRole("button", { name: `Delete ${name}` }) });
    await expect(recent("neon-nights").getByText("Saved", { exact: true })).toBeVisible();
    await expect(recent("neon-nights").getByLabel("Saved in your cloud folder")).toBeVisible();
    await expect(recent("blue-moon").getByText("Saved", { exact: true })).toBeVisible();
    await expect(recent("blue-moon").getByLabel("Saved in your cloud folder")).toHaveCount(0);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    for (const width of [375, 1280]) {
      test(`has no WCAG violations in the Save dialog with the radio group at ${width} px in ${colorScheme} mode`, async ({
        app,
      }) => {
        await app.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        await app.emulateMedia({ colorScheme });
        await link(app);
        await app.evaluate((bytes) => (window.__cloud.estimateBytes = bytes), 62 * MB);
        await separate(app);
        const dialog = await openSaveDialog(app);
        await expect(where(dialog)).toBeVisible();
        await expect(dialog.getByText("About 62 MB")).toBeVisible();
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });
        expect(await dialog.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);

        // The other choice, with the original left out.
        await where(dialog).getByRole("radio", { name: "Another place…" }).check();
        await dialog.getByRole("checkbox", { name: "Include the original song" }).uncheck();
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });

        // Saved in the cloud folder.
        await where(dialog).getByRole("radio", { name: "Cloud folder · Smart Beat" }).check();
        await save(dialog).click();
        await expect(dialog.getByText(SAVED_IN_CLOUD)).toBeVisible();
        await app.mouse.move(0, 0);
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });
        expect(await dialog.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
      });

      test(`has no WCAG violations in the Save dialog with no folder linked at ${width} px in ${colorScheme} mode`, async ({
        app,
      }) => {
        await app.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        await app.emulateMedia({ colorScheme });
        await separate(app);
        const dialog = await openSaveDialog(app);
        await expect(
          dialog.getByText("Link a cloud folder in Settings to keep stems in your cloud."),
        ).toBeVisible();
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });
      });

      test(`has no WCAG violations on the start screen with stems in the cloud folder at ${width} px in ${colorScheme} mode`, async ({
        app,
      }) => {
        await app.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        await app.emulateMedia({ colorScheme });
        // A second file that is only online.
        await saveAndForget(app, () =>
          app.evaluate(
            ([folder, path]) => {
              const files = window.__stemBundles.files;
              files[`${folder}/blue-moon.sbstems`] = files[path];
              window.__cloud.placeholders[`${folder}/blue-moon.sbstems`] = true;
            },
            [FOLDER, CLOUD_FILE],
          ),
        );
        const section = cloudSection(app);
        await expect(section).toBeVisible();
        await expect(section.getByText("Waiting for download")).toBeVisible();
        await expectNoA11yViolations(app);
        expect(
          await app.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        ).toBeLessThanOrEqual(0);
      });
    }
  }
});
