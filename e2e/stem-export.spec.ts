import type { Locator, Page } from "@playwright/test";

import features from "../src/lib/features.json" with { type: "json" };

import {
  PRACTICE_SONG,
  emitMenuAction,
  expect,
  expectNoA11yViolations,
  openSong,
  test,
} from "./fixtures";

declare global {
  interface Window {
    __stemExports: {
      mixed: { id: string; kinds: string[]; format: string; dest: string }[];
      batch: { id: string; kinds: string[]; format: string; dir: string }[];
      sources: { id: string; kind: string }[];
      hold: boolean;
      fail: string | null;
      clipped: boolean;
      release: (() => void) | null;
      abort: (() => void) | null;
    };
  }
}

/**
 * Export stems (#223): the chosen stems go out as one mixed file or one file per stem (WAV or
 * FLAC), or into a tab as audio lanes, with the stems commands mocked in e2e/tauri-mock.js.
 * The fast engine gives Drums, Bass, Vocals, Guitars and keys, and Other (not separated).
 */

const SONG_PATH = "/Users/me/Music/neon-nights.mp3";
const MIX_PATH = "/Users/me/Music/neon-nights (mix).wav";
const FOLDER = "/Users/me/Music";

test.describe("Export stems (#223)", () => {
  test.skip(!features["stem-separation"], "stem-separation is off in src/lib/features.json");

  /** Start screen to the stem page of the song, made by the built-in engine. */
  async function separate(app: Page) {
    await app.getByRole("button", { name: "Stem separation" }).click();
    const dialog = app.getByRole("dialog", { name: "Stem separation" });
    await expect(dialog).toBeVisible();
    await app.evaluate((p) => (window.__dialogResult = p), SONG_PATH);
    await dialog.getByRole("button", { name: "Choose a song" }).click();
    await expect(dialog.getByTestId("stem-file-name")).toBeVisible();
    await dialog.getByRole("button", { name: "Next" }).click();
    await dialog.getByRole("radio", { name: "Fast" }).check();
    await dialog.getByRole("button", { name: "Separate" }).click();
    await expect(app.getByRole("heading", { level: 1, name: "neon-nights" })).toBeVisible();
  }

  async function openExport(app: Page) {
    await app.getByRole("button", { name: "Export stems" }).click();
    const dialog = app.getByRole("dialog", { name: "Export stems" });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  const run = (dialog: Locator) => dialog.getByTestId("export-stems-run");
  const mixedRequests = (app: Page) => app.evaluate(() => window.__stemExports.mixed);
  const batchRequests = (app: Page) => app.evaluate(() => window.__stemExports.batch);
  const scan = (app: Page) => expectNoA11yViolations(app, { popup: "[role=dialog]" });

  test("offers every stem, ticked, with a file as the first choice", async ({ app }) => {
    await separate(app);
    const dialog = await openExport(app);
    for (const name of [/^Drums/, /^Bass/, /^Vocals/, /^Guitars and keys/, /^Other/]) {
      await expect(dialog.getByRole("checkbox", { name })).toBeChecked();
    }
    await expect(dialog.getByRole("radio", { name: "One mixed file" })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: "WAV" })).toBeChecked();
    await expect(run(dialog)).toBeEnabled();
    await expect(run(dialog)).toHaveText("Export mix");
  });

  test("exports the chosen stems mixed into one WAV file", async ({ app }) => {
    await separate(app);
    const dialog = await openExport(app);
    await dialog.getByRole("checkbox", { name: /^Other/ }).click();
    await app.evaluate((path) => (window.__saveResult = path), MIX_PATH);
    await run(dialog).click();

    await expect(dialog.getByText("Exported the mix")).toBeVisible();
    await expect(dialog.getByTestId("export-stems-path")).toHaveText(MIX_PATH);
    expect(await mixedRequests(app)).toEqual([
      {
        id: expect.stringMatching(/^neonnights/),
        kinds: ["drums", "bass", "vocals", "panned"],
        format: "wav",
        dest: MIX_PATH,
      },
    ]);
    expect(await batchRequests(app)).toEqual([]);
    await expect(dialog.getByRole("button", { name: "Show in folder" })).toBeVisible();
  });

  test("exports one FLAC file per stem into a new folder", async ({ app }) => {
    await separate(app);
    const dialog = await openExport(app);
    await dialog.getByRole("radio", { name: "One file per stem" }).click();
    await dialog.getByRole("radio", { name: "FLAC" }).click();
    await dialog.getByRole("checkbox", { name: /^Bass/ }).click();
    await app.evaluate((path) => (window.__dialogResult = path), FOLDER);
    await expect(run(dialog)).toHaveText("Export files");
    await run(dialog).click();

    await expect(dialog.getByText("Exported 4 files")).toBeVisible();
    await expect(dialog.getByTestId("export-stems-path")).toHaveText(`${FOLDER}/neon-nights stems`);
    expect(await batchRequests(app)).toEqual([
      {
        id: expect.stringMatching(/^neonnights/),
        kinds: ["drums", "vocals", "panned", "other"],
        format: "flac",
        dir: FOLDER,
      },
    ]);
    expect(await mixedRequests(app)).toEqual([]);
  });

  test("turns Export off with a message when no stem is chosen", async ({ app }) => {
    await separate(app);
    const dialog = await openExport(app);
    await dialog.getByRole("button", { name: "None" }).click();
    await expect(run(dialog)).toBeDisabled();
    await expect(dialog.getByTestId("export-stems-none")).toHaveText(
      "Choose at least one stem to export.",
    );
    // The same in the other modes, including adding to a tab.
    await dialog.getByRole("radio", { name: "One file per stem" }).click();
    await expect(run(dialog)).toBeDisabled();
    await dialog.getByRole("radio", { name: "Add to a tab" }).click();
    await expect(run(dialog)).toBeDisabled();
    await dialog.getByRole("button", { name: "All" }).click();
    await expect(run(dialog)).toBeEnabled();
    await expect(dialog.getByTestId("export-stems-none")).toHaveCount(0);
  });

  test("does nothing when the file or folder dialog is cancelled", async ({ app }) => {
    await separate(app);
    const dialog = await openExport(app);
    await app.evaluate(() => (window.__saveResult = null));
    await run(dialog).click();
    await expect(run(dialog)).toBeEnabled();
    await dialog.getByRole("radio", { name: "One file per stem" }).click();
    await app.evaluate(() => (window.__dialogResult = null));
    await run(dialog).click();
    await expect(run(dialog)).toBeEnabled();
    expect(await mixedRequests(app)).toEqual([]);
    expect(await batchRequests(app)).toEqual([]);
  });

  test("shows the progress, can be cancelled and then exports again", async ({ app }) => {
    await separate(app);
    const dialog = await openExport(app);
    await app.evaluate((path) => {
      window.__stemExports.hold = true;
      window.__saveResult = path;
    }, MIX_PATH);
    await run(dialog).click();

    const bar = dialog.getByRole("progressbar", { name: "Export progress" });
    await expect(bar).toHaveAttribute("aria-valuenow", "40");
    // Nothing can close it while it writes.
    await app.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close" }).last()).toBeDisabled();
    await scan(app);

    await dialog.getByRole("button", { name: "Cancel" }).click();
    // Stopped on purpose: back to the options, no error.
    await expect(run(dialog)).toBeEnabled();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(bar).toHaveCount(0);

    await app.evaluate(() => (window.__stemExports.hold = false));
    await run(dialog).click();
    await expect(dialog.getByText("Exported the mix")).toBeVisible();
  });

  test("shows a failed export as an alert and keeps the choices", async ({ app }) => {
    await separate(app);
    const dialog = await openExport(app);
    await dialog.getByRole("checkbox", { name: /^Drums/ }).click();
    await app.evaluate((path) => {
      window.__stemExports.fail = "There is not enough free space to export the stems.";
      window.__saveResult = path;
    }, MIX_PATH);
    await run(dialog).click();
    await expect(dialog.getByRole("alert")).toContainText("not enough free space");
    await expect(dialog.getByRole("checkbox", { name: /^Drums/ })).not.toBeChecked();
    await expect(run(dialog)).toBeEnabled();
  });

  test("says when the mix was limited", async ({ app }) => {
    await separate(app);
    const dialog = await openExport(app);
    await app.evaluate((path) => {
      window.__stemExports.clipped = true;
      window.__saveResult = path;
    }, MIX_PATH);
    await run(dialog).click();
    await expect(dialog.getByText(/loudest peaks were limited/)).toBeVisible();
  });

  test("works from the keyboard alone", async ({ app }) => {
    await separate(app);
    await app.getByRole("button", { name: "Export stems" }).focus();
    await app.keyboard.press("Enter");
    const dialog = app.getByRole("dialog", { name: "Export stems" });
    await expect(dialog).toBeVisible();

    // Space ticks and unticks a stem; the arrows move between the choices of a group and Space picks.
    const vocals = dialog.getByRole("checkbox", { name: /^Vocals/ });
    await vocals.focus();
    await app.keyboard.press("Space");
    await expect(vocals).not.toBeChecked();
    await dialog.getByRole("radio", { name: "One mixed file" }).focus();
    await app.keyboard.press("ArrowRight");
    await expect(dialog.getByRole("radio", { name: "One file per stem" })).toBeFocused();
    await app.keyboard.press("Space");
    await expect(dialog.getByRole("radio", { name: "One file per stem" })).toBeChecked();
    await dialog.getByRole("radio", { name: "WAV" }).focus();
    await app.keyboard.press("ArrowRight");
    await expect(dialog.getByRole("radio", { name: "FLAC" })).toBeFocused();
    await app.keyboard.press("Space");
    await expect(dialog.getByRole("radio", { name: "FLAC" })).toBeChecked();

    await app.evaluate((path) => (window.__dialogResult = path), FOLDER);
    await run(dialog).focus();
    await app.keyboard.press("Enter");
    await expect(dialog.getByText("Exported 4 files")).toBeVisible();
    expect(await batchRequests(app)).toMatchObject([
      { kinds: ["drums", "bass", "panned", "other"], format: "flac", dir: FOLDER },
    ]);

    // Escape closes it, and the focus goes back to the button that opened it.
    await app.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(app.getByRole("button", { name: "Export stems" })).toBeFocused();
  });

  const tabBar = (app: Page) => app.getByRole("navigation", { name: "Open songs and stems" });
  const laneButton = (app: Page, stem: string) =>
    app.getByRole("button", { name: `Edit the lane ${stem}` });

  test("adds the chosen stems to an open tab as audio lanes, saved with the file", async ({
    app,
  }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Smart Beat", exact: true }).click();
    await separate(app);
    const dialog = await openExport(app);
    await dialog.getByRole("checkbox", { name: /^Other/ }).click();
    await dialog.getByRole("radio", { name: "Add to a tab" }).click();
    // The open song is the first choice; adding writes no file and opens no file dialog.
    await expect(dialog.getByRole("radio", { name: "Practice Song" })).toBeChecked();
    await expect(run(dialog)).toHaveText("Add to tab");
    await run(dialog).click();

    await expect(dialog.getByText("Added 4 audio tracks")).toBeVisible();
    await expect(dialog.getByTestId("export-stems-added")).toContainText("Practice Song");
    expect(await app.evaluate(() => window.__stemExports.sources.map((s) => s.kind))).toEqual([
      "drums",
      "bass",
      "vocals",
      "panned",
    ]);
    await expect(dialog.getByRole("button", { name: "Show in folder" })).toHaveCount(0);
    await scan(app);
    await dialog.getByRole("button", { name: "Close" }).last().click();

    // The song now has a lane per stem, named after the stem and the model, and is unsaved.
    await tabBar(app)
      .getByRole("button", { name: /^Practice Song/ })
      .click();
    for (const stem of ["Drums", "Bass", "Vocals", "Guitars and keys"]) {
      await expect(laneButton(app, `${stem} · Fast`)).toBeVisible();
    }
    await expect(laneButton(app, "Other (not separated) · Fast")).toHaveCount(0);
    await expect(tabBar(app).getByRole("button", { name: "Practice Song (edited)" })).toBeVisible();

    await emitMenuAction(app, "save");
    await expect
      .poll(() => app.evaluate((p) => window.__projectSettings[p], PRACTICE_SONG))
      .toMatchObject({
        audio: {
          lanes: [
            { name: "Drums · Fast", clips: [{ startMs: 0 }] },
            { name: "Bass · Fast", clips: [{ startMs: 0 }] },
            { name: "Vocals · Fast", clips: [{ startMs: 0 }] },
            { name: "Guitars and keys · Fast", clips: [{ startMs: 0 }] },
          ],
          sources: [{ embedded: true }, { embedded: true }, { embedded: true }, { embedded: true }],
        },
      });
  });

  test("takes all the lanes back with one undo", async ({ app }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Smart Beat", exact: true }).click();
    await separate(app);
    const dialog = await openExport(app);
    await dialog.getByRole("radio", { name: "Add to a tab" }).click();
    await run(dialog).click();
    await expect(dialog.getByText("Added 5 audio tracks")).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).last().click();
    await tabBar(app)
      .getByRole("button", { name: /^Practice Song/ })
      .click();
    await expect(laneButton(app, "Drums · Fast")).toBeVisible();

    await emitMenuAction(app, "undo");
    for (const stem of ["Drums", "Bass", "Vocals", "Guitars and keys"]) {
      await expect(laneButton(app, `${stem} · Fast`)).toHaveCount(0);
    }
    await expect(laneButton(app, "Other (not separated) · Fast")).toHaveCount(0);
  });

  test("adds the stems to a new tab, next to the stem page", async ({ app }) => {
    await separate(app);
    const dialog = await openExport(app);
    await dialog.getByRole("radio", { name: "Add to a tab" }).click();
    // No tab is open: a new one is the choice.
    await expect(dialog.getByRole("radio", { name: "A new tab" })).toBeChecked();
    await run(dialog).click();
    await expect(dialog.getByText("Added 5 audio tracks")).toBeVisible();
    await expect(dialog.getByTestId("export-stems-added")).toContainText("neon-nights stems");
    await dialog.getByRole("button", { name: "Close" }).last().click();

    // The stem page stays; the new tab is in the bar, unsaved, with a lane per stem.
    await expect(app.getByRole("heading", { level: 1, name: "neon-nights" })).toBeVisible();
    const made = tabBar(app).getByRole("button", { name: /^neon-nights stems/ });
    await expect(made).toBeVisible();
    await made.click();
    for (const stem of ["Drums", "Bass", "Vocals", "Guitars and keys", "Other (not separated)"]) {
      await expect(laneButton(app, `${stem} · Fast`)).toBeVisible();
    }
  });

  for (const colorScheme of ["light", "dark"] as const) {
    for (const width of [375, 1280]) {
      test(`has no WCAG violations in the dialog at ${width} px in ${colorScheme} mode`, async ({
        app,
      }) => {
        // Many steps and five scans: with several chunks running at once the default 30 s is short.
        test.slow();
        await app.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        await app.emulateMedia({ colorScheme });
        await openSong(app);
        await app.getByRole("button", { name: "Smart Beat", exact: true }).click();
        await separate(app);
        const dialog = await openExport(app);
        await expect(run(dialog)).toBeVisible();
        await scan(app);
        expect(await dialog.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);

        // Nothing chosen: the message.
        await dialog.getByRole("button", { name: "None" }).click();
        await expect(dialog.getByTestId("export-stems-none")).toBeVisible();
        await scan(app);
        await dialog.getByRole("button", { name: "All" }).click();

        // The tab choices.
        await dialog.getByRole("radio", { name: "Add to a tab" }).click();
        await expect(dialog.getByRole("radio", { name: "A new tab" })).toBeVisible();
        await scan(app);

        // The result of a file export.
        await dialog.getByRole("radio", { name: "One mixed file" }).click();
        await app.evaluate((path) => (window.__saveResult = path), MIX_PATH);
        await run(dialog).click();
        await expect(dialog.getByText("Exported the mix")).toBeVisible();
        await app.mouse.move(0, 0);
        await scan(app);

        // A failure.
        await dialog.getByRole("button", { name: "Back" }).click();
        await app.evaluate(() => (window.__stemExports.fail = "There is not enough free space."));
        await run(dialog).click();
        await expect(dialog.getByRole("alert")).toBeVisible();
        await app.mouse.move(0, 0);
        await scan(app);
      });
    }
  }
});
