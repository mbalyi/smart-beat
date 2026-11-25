import type { Locator, Page } from "@playwright/test";

import { expect, expectNoA11yViolations, openSong, test } from "./fixtures";

declare global {
  interface Window {
    __samples: {
      folders: Record<string, unknown>[];
      files: Record<string, Record<string, unknown>[]>;
      previews: { rel?: string; volume?: number; stop?: boolean }[];
      removed: { id: string; deleteCopy: boolean }[];
      fileImports: { paths: string[]; name: string }[];
    };
    __sampleFile: (name: string, ext?: string) => Record<string, unknown>;
  }
}

/**
 * The sample browser (#232): the Samples tab of the Inspector, the Add samples dialog (link a
 * folder, import a folder, import an archive), search, auditioning without touching the score,
 * and putting a sample on a lane. The sample commands are mocked in e2e/tauri-mock.js.
 */

test.use({ viewport: { width: 1280, height: 1000 } });

const FOLDER = "/Users/me/Music/Drum Kits";

/** A folder the core already knows, with `count` files that are not measured yet. */
async function seedFolder(app: Page, count: number, over: Record<string, unknown> = {}) {
  await app.evaluate(
    ({ count, over }) => {
      const id = "a".repeat(12);
      window.__samples.folders = [
        {
          id,
          name: "Drum Kits",
          kind: "linked",
          path: "/Users/me/Music/Drum Kits",
          available: true,
          fileCount: count,
          addedMs: 1,
          ...over,
        },
      ];
      window.__samples.files[id] = Array.from({ length: count }, (_, i) =>
        window.__sampleFile(`Sample_${String(i + 1).padStart(2, "0")}`),
      );
    },
    { count, over },
  );
}

/** Opens the practice song with the native engine on (previews need it) and the Samples tab. */
async function openSamples(app: Page) {
  await openSong(app);
  await app.getByRole("switch", { name: "Native engine with effects" }).click();
  await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
}

/** Puts a lane on the song (the audio lane's menu is where the sample items live). */
async function addLane(app: Page) {
  await app.evaluate((path) => (window.__dialogResult = path), "/Users/me/Music/bass-take.wav");
  await app.getByRole("button", { name: "Import audio" }).first().click();
  const row = app.locator("[data-testid^='lane-row-']").first();
  await expect(row).toBeVisible();
  return row;
}

const laneMenu = async (row: Locator) => {
  await row.getByRole("button", { name: /^More for / }).click();
};

const showSamples = (app: Page) => app.getByRole("tab", { name: "Samples" }).click();
const rows = (app: Page): Locator => app.getByTestId("sample-row");

/** Walks the Add samples dialog to its review step for `source`, with `path` as the choice. */
async function chooseSource(app: Page, source: "link" | "folder" | "archive", path: string) {
  await app.getByRole("button", { name: "Add samples" }).first().click();
  const dialog = app.getByRole("dialog", { name: "Add samples" });
  await dialog.getByTestId(`source-${source}`).click();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await app.evaluate((p) => (window.__dialogResult = p), path);
  await dialog
    .getByRole("button", { name: source === "archive" ? "Choose archive…" : "Choose folder…" })
    .click();
  return dialog;
}

test.describe("sample browser (#232)", () => {
  test("links a folder, finds a sample, previews it and puts it on a new lane", async ({ app }) => {
    await openSamples(app);
    await showSamples(app);
    await expect(app.getByTestId("samples-empty")).toBeVisible();

    const dialog = await chooseSource(app, "link", FOLDER);
    await expect(dialog.getByText("12 samples found")).toBeVisible();
    await dialog.getByRole("button", { name: "Add folder" }).click();
    await expect(dialog.getByRole("heading", { name: "Drum Kits is ready" })).toBeVisible();
    await dialog.getByRole("button", { name: "Show samples" }).click();
    await expect(dialog).toBeHidden();

    await expect(rows(app)).toHaveCount(12);
    // Measured as they come into view.
    await expect(rows(app).first()).toContainText("kHz");
    await app.getByRole("searchbox", { name: "Search samples" }).fill("sample_03");
    await expect(rows(app)).toHaveCount(1);

    await rows(app).first().click();
    await expect
      .poll(() => app.evaluate(() => window.__samples.previews.at(-1)))
      .toEqual({ rel: "Sample_03.wav", volume: 0.8 });
    // The score did not start: a preview has its own voice.
    await expect(app.getByRole("button", { name: "Play" })).toBeVisible();

    await app.getByRole("listbox", { name: "Samples" }).press("Enter");
    await expect(app.getByRole("button", { name: "Edit the lane Sample_03" })).toBeVisible();
    await expect(app.getByRole("button", { name: "Play" })).toBeVisible();
  });

  test("moves through the list with the arrow keys and stops with Space", async ({ app }) => {
    await openSamples(app);
    await seedFolder(app, 12);
    await showSamples(app);
    await expect(rows(app)).toHaveCount(12);
    const list = app.getByRole("listbox", { name: "Samples" });
    await list.focus();
    await list.press("ArrowDown");
    await list.press("ArrowDown");
    await expect
      .poll(() => app.evaluate(() => window.__samples.previews.filter((p) => p.rel).at(-1)?.rel))
      .toBe("Sample_02.wav");
    await expect(rows(app).nth(1)).toHaveAttribute("aria-selected", "true");
    await list.press("Space");
    await expect(rows(app).nth(1)).toHaveAttribute("data-playing", "false");
    await expect
      .poll(() => app.evaluate(() => window.__samples.previews.at(-1)))
      .toEqual({ stop: true });
  });

  test("imports an archive after checking it, and refuses an unsafe one", async ({ app }) => {
    await openSamples(app);
    await showSamples(app);
    const evil = await chooseSource(app, "archive", "/Users/me/Downloads/evil.zip");
    await expect(evil.getByText("Archive was not unpacked")).toBeVisible();
    await expect(evil.getByText(/point outside the target folder/)).toBeVisible();
    await expect(evil.getByRole("button", { name: "Unpack and add" })).toBeDisabled();

    await app.evaluate(() => (window.__dialogResult = "/Users/me/Downloads/Loops-Vol2.zip"));
    await evil.getByRole("button", { name: "Choose archive…" }).click();
    await expect(evil.getByText("Loops-Vol2.zip: 214 samples")).toBeVisible();
    await evil.getByRole("button", { name: "Unpack and add" }).click();
    await expect(evil.getByRole("heading", { name: "Loops-Vol2 is ready" })).toBeVisible();
    await evil.getByRole("button", { name: "Show samples" }).click();
    await expect(app.getByRole("button", { name: /Loops-Vol2/ })).toBeVisible();
    await expect(app.getByText(/Unpacked from an archive/)).toBeVisible();
  });

  test("copies a folder in and keeps going if the choice is changed", async ({ app }) => {
    await openSamples(app);
    await showSamples(app);
    const dialog = await chooseSource(app, "folder", FOLDER);
    await expect(dialog.getByText("12 samples found")).toBeVisible();
    await dialog.getByRole("button", { name: "Copy files" }).click();
    await expect(dialog.getByRole("heading", { name: "Drum Kits is ready" })).toBeVisible();
    await dialog.getByRole("button", { name: "Show samples" }).click();
    await expect(app.getByText("Imported: a copy kept by Smart Beat.")).toBeVisible();
  });

  test("a folder with thousands of files draws only the rows in view and scrolls to the end", async ({
    app,
  }) => {
    await openSamples(app);
    await seedFolder(app, 5000);
    await showSamples(app);
    await expect(rows(app).first()).toBeVisible();
    expect(await rows(app).count()).toBeLessThan(40);
    await expect(app.getByText("5,000 samples")).toBeVisible();
    await app.getByTestId("sample-list").evaluate((el) => (el.scrollTop = el.scrollHeight));
    // Sorted by name, the last of 5,000 is the one that sorts last as text: "Sample_999".
    await expect(app.getByRole("option", { name: /Sample_999/ })).toHaveAttribute(
      "aria-posinset",
      "5000",
    );
    expect(await rows(app).count()).toBeLessThan(40);
  });

  test("a folder that went missing can be located again", async ({ app }) => {
    await openSamples(app);
    await seedFolder(app, 3, { available: false });
    await showSamples(app);
    await expect(app.getByText(/Drum Kits.* was not found/)).toBeVisible();
    await app.evaluate(() => (window.__dialogResult = "/Volumes/Back/Drum Kits"));
    await app.getByRole("button", { name: "Locate…" }).click();
    await expect(rows(app)).toHaveCount(3);
    await expect(app.getByText(/was not found/)).toBeHidden();
  });

  test("removing a linked folder explains that the files stay", async ({ app }) => {
    await openSamples(app);
    await seedFolder(app, 3);
    await showSamples(app);
    await app.getByRole("button", { name: /Drum Kits/ }).click();
    await app.getByRole("button", { name: "Remove" }).click();
    await expect(app.getByText(/Your files are not deleted/)).toBeVisible();
    await app.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(app.getByTestId("samples-empty")).toBeVisible();
    expect(await app.evaluate(() => window.__samples.removed)).toHaveLength(1);
  });

  test("dragging a sample onto a lane shows where it lands and adds the clip there", async ({
    app,
  }) => {
    await openSamples(app);
    await seedFolder(app, 6);
    await app.evaluate((path) => (window.__dialogResult = path), "/Users/me/Music/bass-take.wav");
    await app.getByRole("button", { name: "Import audio" }).first().click();
    const lane = app.locator("[data-lane-id]").first();
    await expect(lane).toBeVisible();
    await showSamples(app);
    await expect(rows(app)).toHaveCount(6);
    const from = (await rows(app).nth(1).boundingBox())!;
    const to = (await lane.boundingBox())!;
    await app.mouse.move(from.x + 80, from.y + from.height / 2);
    await app.mouse.down();
    await app.mouse.move(from.x + 40, from.y + 20, { steps: 4 });
    await app.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
    await expect(app.getByTestId("lane-drop-label")).toHaveText(/^Drop to add to .* · \d:\d\d$/);
    await app.mouse.up();
    await expect(app.getByRole("button", { name: /^Sample_02\.wav on / })).toBeVisible();
    // No preview was started by the drag, and the song did not move.
    expect(await app.evaluate(() => window.__samples.previews.filter((p) => p.rel))).toEqual([]);
  });

  test("the lane's menu shows the samples, also when the inspector is closed", async ({ app }) => {
    await openSamples(app);
    await seedFolder(app, 6);
    const row = await addLane(app);
    const inspector = app.getByRole("complementary", { name: "Inspector" });
    await app.getByRole("button", { name: "Inspector", exact: true }).click();
    await expect(inspector).toBeHidden();

    await laneMenu(row);
    // Right after "Add audio file…".
    const items = app.getByRole("menu").getByRole("menuitem");
    await expect(items.nth(1)).toHaveText("Add audio file…");
    await expect(items.nth(2)).toHaveText("Show samples");
    await expect(items.nth(3)).toHaveText("Import samples…");
    await items.nth(2).click();

    await expect(inspector).toBeVisible();
    await expect(app.getByRole("tab", { name: "Samples" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(rows(app)).toHaveCount(6);
  });

  test("the lane's menu opens the Add samples dialog without the Samples tab ever opened", async ({
    app,
  }) => {
    await openSamples(app);
    const row = await addLane(app);
    await expect(app.getByRole("tab", { name: "Samples" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await laneMenu(row);
    await app.getByRole("menuitem", { name: "Import samples…" }).click();
    const dialog = app.getByRole("dialog", { name: "Add samples" });
    await expect(dialog).toBeVisible();
    await app.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // With the Samples tab on screen it is the same dialog, opened once.
    await showSamples(app);
    await laneMenu(row);
    await app.getByRole("menuitem", { name: "Import samples…" }).click();
    await expect(app.getByRole("dialog", { name: "Add samples" })).toHaveCount(1);
    await expect(app.getByRole("dialog", { name: "Add samples" })).toBeVisible();
  });

  test("resting the mouse on a waveform previews it and leaving stops it", async ({ app }) => {
    await openSamples(app);
    await seedFolder(app, 6);
    await showSamples(app);
    await expect(rows(app)).toHaveCount(6);
    await expect(rows(app).nth(1)).toContainText("kHz");
    const previews = () => app.evaluate(() => window.__samples.previews);

    // The name is not the waveform: nothing plays.
    await rows(app).nth(1).getByText("Sample_02").hover();
    await app.waitForTimeout(400);
    expect((await previews()).filter((p) => p.rel)).toEqual([]);

    await rows(app).nth(1).getByTestId("sample-wave").hover();
    await expect
      .poll(async () => (await previews()).at(-1))
      .toMatchObject({ rel: "Sample_02.wav" });
    await expect(rows(app).nth(1)).toHaveAttribute("data-playing", "true");

    // Moving to the next row switches the preview, then leaving the list ends it.
    await rows(app).nth(2).getByTestId("sample-wave").hover();
    await expect
      .poll(async () => (await previews()).filter((p) => p.rel).at(-1))
      .toMatchObject({
        rel: "Sample_03.wav",
      });
    await expect(rows(app).nth(1)).toHaveAttribute("data-playing", "false");
    await app.getByRole("heading", { name: "Samples" }).hover();
    await expect(rows(app).nth(2)).toHaveAttribute("data-playing", "false");
    expect((await previews()).at(-1)).toEqual({ stop: true });
  });

  test("a preview started by click keeps playing when the mouse leaves", async ({ app }) => {
    await openSamples(app);
    await seedFolder(app, 4);
    await showSamples(app);
    await rows(app).first().click();
    await expect(rows(app).first()).toHaveAttribute("data-playing", "true");
    await rows(app).first().getByTestId("sample-wave").hover();
    await app.getByRole("heading", { name: "Samples" }).hover();
    await app.waitForTimeout(400);
    await expect(rows(app).first()).toHaveAttribute("data-playing", "true");
    expect((await app.evaluate(() => window.__samples.previews)).at(-1)).not.toEqual({
      stop: true,
    });
  });

  test("a playhead sweeps the waveform of the playing sample", async ({ app }) => {
    await openSamples(app);
    await seedFolder(app, 4);
    await showSamples(app);
    await expect(rows(app).first()).toContainText("kHz");
    const playhead = rows(app).first().getByTestId("sample-playhead");
    await expect(playhead).toBeHidden();
    await rows(app).first().click();
    await expect(playhead).toBeVisible();
    await expect(playhead).toHaveAttribute("aria-hidden", "true");
    await expect
      .poll(() => playhead.evaluate((el) => (el as HTMLElement).style.transform))
      .not.toBe("translateX(0px)");
    await rows(app).first().getByTestId("sample-play").click();
    await expect(playhead).toBeHidden();
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the Samples tab and the Add samples dialog have no WCAG violations in ${colorScheme} mode`, async ({
      app,
    }) => {
      await app.emulateMedia({ colorScheme });
      await openSamples(app);
      await seedFolder(app, 12);
      await showSamples(app);
      await expect(rows(app)).toHaveCount(12);
      await expect(rows(app).first()).toContainText("kHz");
      // With a sample playing, so the playhead is scanned too.
      await rows(app).first().click();
      await expect(rows(app).first().getByTestId("sample-playhead")).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[aria-label='Inspector']" });
      const dialog = await chooseSource(app, "archive", "/Users/me/Downloads/Loops-Vol2.zip");
      await expect(dialog.getByText("Loops-Vol2.zip: 214 samples")).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role='dialog']" });
    });
  }
});
