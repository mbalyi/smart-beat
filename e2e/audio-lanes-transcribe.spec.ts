import type { Page } from "@playwright/test";

import { emitMenuAction, expect, expectNoA11yViolations, openSong, test } from "./fixtures";

/**
 * Sheet from an audio lane (#235): split a clip, right-click it, choose Convert audio to sheet…,
 * pick the track and the bar, check the preview, add the notes (or drag them to the score) and
 * undo. The notes come from the mocked Rust core (`window.__laneTranscription`, e2e/tauri-mock.js).
 */

declare global {
  interface Window {
    __laneTranscription: {
      requests: {
        laneId: string;
        clipId?: string;
        startMs?: number;
        endMs?: number;
        instrument: string;
        engine?: string;
      }[];
      cancelled: number;
      hold: boolean;
      fail: string | null;
      release: (() => void) | null;
      notes: { pitch: number; start: number; end: number; velocity: number }[] | null;
    };
  }
}

// The track list, the score and the dialog need room (a menu opened by a click must not move).
test.use({ viewport: { width: 1280, height: 1000 } });

const CONVERT = "Convert audio to sheet…";

/** Opens the practice song with the native engine on (the lanes play there). */
async function openWithEngine(app: Page) {
  await openSong(app);
  await app.getByRole("switch", { name: "Native engine with effects" }).click();
  await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
}

/** Adds `file` as a lane through the Track menu's Import Audio; returns the lane's row. */
async function addLane(app: Page, file: string) {
  await app.evaluate((path) => (window.__dialogResult = path), file);
  await emitMenuAction(app, "import-audio-file");
  const name = file
    .split("/")
    .pop()!
    .replace(/\.[^.]+$/, "");
  const row = app
    .locator("[data-testid^='lane-row-']")
    .filter({ has: app.getByRole("button", { name: `Edit the lane ${name}` }) });
  await expect(row).toBeVisible();
  return row;
}

const dialog = (app: Page) => app.getByRole("dialog", { name: "Sheet from an audio lane" });
const requests = (app: Page) => app.evaluate(() => window.__laneTranscription.requests);

/** A lane with one clip, right-clicked, with the dialog opened from the menu. */
async function openFromClip(app: Page) {
  await openWithEngine(app);
  const row = await addLane(app, "/Users/me/Music/take.mp3");
  const clip = row.getByRole("button", { name: /take\.mp3 on take/ });
  await clip.click({ button: "right", position: { x: 10, y: 10 } });
  await app.getByRole("menuitem", { name: CONVERT }).click();
  await expect(dialog(app)).toBeVisible();
  return { row, clip };
}

test.describe("Sheet from an audio lane", () => {
  let errors: string[] = [];
  test.beforeEach(({ app }) => {
    errors = [];
    app.on("pageerror", (error) => errors.push(error.message));
  });
  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test("right-click a clip: defaults, track and bar, preview, add and undo", async ({ app }) => {
    test.slow();
    await openFromClip(app);
    const form = dialog(app);
    // Opens on Instrument with the clip shown as the source; the logo is decoration.
    await expect(form.getByRole("heading", { name: "What is playing?" })).toBeVisible();
    await expect(form.getByTestId("lane-to-tab-logo")).toHaveAttribute("alt", "");
    await expect(form.getByTestId("lane-to-tab-source-summary")).toContainText("take, clip 1");
    await form.getByRole("button", { name: /Find the notes/ }).click();
    await expect(form.getByRole("heading", { name: "Where do the notes go?" })).toBeVisible();
    // The clip starts at the start of the song: bar 1, on a stringed track.
    expect(await requests(app)).toHaveLength(1);
    expect((await requests(app))[0]!.clipId).toBeTruthy();
    await expect(form.getByLabel("Start bar")).toHaveValue("1");
    await expect(form.getByText("Same bar as the audio.")).toBeVisible();
    // The preview is a real alphaTab drawing of the notes that will be written.
    await expect(form.getByTestId("score-preview")).toHaveAttribute("data-drawn", "true", {
      timeout: 30_000,
    });
    await expect(form.getByTestId("placement-caption")).toContainText(/bar 1/);
    await expect(form.getByTestId("note-count")).toContainText("4 notes");
    // Another bar: the caption and the picture follow.
    await form.getByLabel("Start bar").fill("3");
    await expect(form.getByTestId("placement-caption")).toContainText(/bar 3/);
    await form.getByRole("button", { name: "Add to score" }).click();
    await expect(form.getByRole("heading", { name: "Your sheet is ready" })).toBeVisible();
    await expect(form.getByTestId("lane-to-tab-result")).toContainText("bar 3");
    await form.getByRole("button", { name: "Undo" }).click();
    await expect(form.getByTestId("lane-to-tab-result")).toContainText("Undone");
    await form.getByRole("button", { name: "Done" }).click();
    await expect(dialog(app)).toHaveCount(0);
  });

  test("a failure, a stop and a retry", async ({ app }) => {
    test.slow();
    await openFromClip(app);
    const form = dialog(app);
    await app.evaluate(() => {
      window.__laneTranscription.fail = "The note finder could not start.";
    });
    await form.getByRole("button", { name: /Find the notes/ }).click();
    await expect(form.getByRole("alert")).toContainText("The note finder could not start.");
    await app.evaluate(() => {
      window.__laneTranscription.fail = null;
      window.__laneTranscription.hold = true;
    });
    await form.getByRole("button", { name: /Find the notes/ }).click();
    await expect(form.getByTestId("lane-to-tab-progress")).toContainText("%");
    await form.getByRole("button", { name: "Stop" }).click();
    await expect.poll(() => app.evaluate(() => window.__laneTranscription.cancelled)).toBe(1);
    await expect(form.getByTestId("lane-to-tab-progress")).toHaveCount(0);
    await app.evaluate(() => {
      window.__laneTranscription.hold = false;
    });
    await form.getByRole("button", { name: /Find the notes/ }).click();
    await expect(form.getByRole("heading", { name: "Where do the notes go?" })).toBeVisible();
  });

  test("Record to tab has an Audio lane source that opens the dialog", async ({ app }) => {
    await openWithEngine(app);
    await addLane(app, "/Users/me/Music/take.mp3");
    await emitMenuAction(app, "record-to-tab");
    const record = app.getByRole("dialog", { name: /^Record to Tab/ });
    await record.getByRole("radio", { name: "Audio lane" }).click();
    await record.getByRole("button", { name: "Choose the audio" }).click();
    await expect(dialog(app)).toBeVisible();
    await expect(dialog(app).getByRole("heading", { name: "Choose the audio" })).toBeVisible();
    await expect(dialog(app).getByTestId("lane-to-tab-summary")).toContainText("take");
  });

  /** The dialog on its Place step, with the preview drawn. */
  async function atPlace(app: Page) {
    await openFromClip(app);
    const form = dialog(app);
    await form.getByRole("button", { name: /Find the notes/ }).click();
    await expect(form.getByTestId("score-preview")).toHaveAttribute("data-drawn", "true", {
      timeout: 30_000,
    });
    return form;
  }

  /** A point over the first bars of the score on the page (the dialog is see-through meanwhile). */
  async function overScore(app: Page) {
    const box = (await app.getByTestId("score-viewport").boundingBox())!;
    return { x: box.x + 160, y: box.y + 110 };
  }

  test.describe("drag the sheet to the score", () => {
    test("drops on the bar under the pointer, with Undo in the toast", async ({ app }) => {
      test.slow();
      const form = await atPlace(app);
      const grip = (await form.getByTestId("part-drag-grip").boundingBox())!;
      const at = await overScore(app);
      await app.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await app.mouse.down();
      await app.mouse.move(grip.x + 40, grip.y + 60, { steps: 4 });
      // The dialog is see-through while the part is carried, and the score outlines the bars.
      await app.mouse.move(at.x, at.y, { steps: 8 });
      await expect(form).toHaveAttribute("data-placing", "true");
      // The score may still be drawing when the part is picked up (slow CI): keep nudging the
      // pointer until a bar is under it, because the target is only found on a move.
      // The pointer also tries a few other spots, in case the first lines of the score sit lower.
      const spots = [
        [0, 0],
        [60, 0],
        [0, 50],
        [120, 50],
        [60, 100],
      ];
      let attempt = 0;
      await expect(async () => {
        const [dx, dy] = spots[attempt++ % spots.length];
        await app.mouse.move(at.x + dx + 2, at.y + dy + 2);
        await app.mouse.move(at.x + dx, at.y + dy);
        await expect(app.getByTestId("part-drag-chip")).toContainText(/Guitar to .*bar/, {
          timeout: 1_000,
        });
      }).toPass({ timeout: 20_000 });
      await expect(app.getByTestId("part-drop-bar").first()).toBeVisible();
      await expect(app.getByTestId("part-drag-hud")).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[data-testid=part-drag-hud]" });
      await app.mouse.up();
      await expect(dialog(app)).toHaveCount(0);
      const toast = app.locator("[data-sonner-toast]").filter({ hasText: /Added Guitar to/ });
      await expect(toast).toBeVisible();
      await toast.getByRole("button", { name: "Undo" }).click();
      await expect(app.getByTestId("part-drop-overlay")).toHaveCount(0);
    });

    test("a release outside the score, or Escape, puts the dialog back with its choices", async ({
      app,
    }) => {
      test.slow();
      const form = await atPlace(app);
      await form.getByLabel("Start bar").fill("3");
      await expect(form.getByTestId("placement-caption")).toContainText(/bar 3/);
      const grip = (await form.getByTestId("part-drag-grip").boundingBox())!;
      const at = await overScore(app);
      // Released over nothing (the corner of the window).
      await app.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await app.mouse.down();
      await app.mouse.move(at.x, at.y, { steps: 6 });
      await app.mouse.move(2, 2, { steps: 6 });
      await expect(form).toHaveAttribute("data-placing", "true");
      await app.mouse.up();
      await expect(form).not.toHaveAttribute("data-placing");
      await expect(form.getByLabel("Start bar")).toHaveValue("3");
      await expect(form.getByTestId("placement-caption")).toContainText(/bar 3/);
      // Escape while carried cancels the carry; a second Escape closes the dialog.
      await app.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await app.mouse.down();
      await app.mouse.move(at.x, at.y, { steps: 6 });
      await expect(form).toHaveAttribute("data-placing", "true");
      await app.keyboard.press("Escape");
      await app.mouse.up();
      await expect(dialog(app)).toBeVisible();
      await expect(form).not.toHaveAttribute("data-placing");
      await expect(app.locator("[data-sonner-toast]").filter({ hasText: /Added/ })).toHaveCount(0);
      await app.keyboard.press("Escape");
      await expect(dialog(app)).toHaveCount(0);
    });

    test("works from the keyboard alone: Space, arrows, Enter", async ({ app }) => {
      test.slow();
      const form = await atPlace(app);
      const grip = form.getByTestId("part-drag-grip");
      await grip.focus();
      await app.keyboard.press("Space");
      await expect(form.getByTestId("lane-to-tab-live")).toContainText(/Picked up the sheet/);
      await expect(form).toHaveAttribute("data-placing", "true");
      await expect(app.getByTestId("part-drag-hud")).toContainText("Escape cancels");
      await app.keyboard.press("ArrowRight");
      await expect(form.getByTestId("lane-to-tab-live")).toContainText(/bar 2/);
      await app.keyboard.press("ArrowLeft");
      await expect(form.getByTestId("lane-to-tab-live")).toContainText(/bar 1/);
      await app.keyboard.press("Escape");
      await expect(form).not.toHaveAttribute("data-placing");
      await expect(grip).toBeFocused();
      await app.keyboard.press("Enter");
      await app.keyboard.press("ArrowRight");
      await app.keyboard.press("Enter");
      await expect(dialog(app)).toHaveCount(0);
      await expect(
        app.locator("[data-sonner-toast]").filter({ hasText: /Added Guitar to .*bar 2/ }),
      ).toBeVisible();
    });
  });

  test("keyboard only: the clip's context menu, the steps and Add to score", async ({
    app,
    browserName,
  }) => {
    test.slow();
    // WebKit has no key for the context menu: there the lane's own menu is the way (see below).
    test.skip(browserName !== "chromium", "The context-menu key opens no menu in WebKit.");
    await openWithEngine(app);
    const row = await addLane(app, "/Users/me/Music/take.mp3");
    const clip = row.getByRole("button", { name: /take\.mp3 on take/ });
    await clip.focus();
    await app.keyboard.press("ContextMenu");
    await app.getByRole("menuitem", { name: CONVERT }).focus();
    await app.keyboard.press("Enter");
    await expect(dialog(app)).toBeVisible();
    // Source (collapsed) is behind us; Tab reaches Find the notes.
    const find = dialog(app).getByRole("button", { name: /Find the notes/ });
    await find.focus();
    await app.keyboard.press("Enter");
    await expect(
      dialog(app).getByRole("heading", { name: "Where do the notes go?" }),
    ).toBeVisible();
    const add = dialog(app).getByRole("button", { name: "Add to score" });
    await expect(add).toBeEnabled();
    await add.focus();
    await app.keyboard.press("Enter");
    await expect(dialog(app).getByTestId("lane-to-tab-result")).toBeVisible();
  });

  test("the lane's own menu opens the dialog on its Source step", async ({ app }) => {
    test.slow();
    await openWithEngine(app);
    const row = await addLane(app, "/Users/me/Music/take.mp3");
    await row.getByRole("button", { name: "More for take" }).click();
    await app.getByRole("menuitem", { name: /Convert (this )?audio to sheet/ }).click();
    await expect(dialog(app).getByRole("heading", { name: "Choose the audio" })).toBeVisible();
    await dialog(app).getByRole("button", { name: "Next" }).click();
    await expect(dialog(app).getByRole("heading", { name: "What is playing?" })).toBeVisible();
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`has no WCAG violations in ${colorScheme} mode`, async ({ app }) => {
      test.slow();
      await app.emulateMedia({ colorScheme });
      await openFromClip(app);
      const form = dialog(app);
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
      // Running.
      await app.evaluate(() => {
        window.__laneTranscription.hold = true;
      });
      await form.getByRole("button", { name: /Find the notes/ }).click();
      await expect(form.getByTestId("lane-to-tab-progress")).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
      await form.getByRole("button", { name: "Stop" }).click();
      // Failed.
      await app.evaluate(() => {
        window.__laneTranscription.hold = false;
        window.__laneTranscription.fail = "The note finder could not start.";
      });
      await form.getByRole("button", { name: /Find the notes/ }).click();
      await expect(form.getByRole("alert")).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
      // Place, with the preview, and the result.
      await app.evaluate(() => {
        window.__laneTranscription.fail = null;
      });
      await form.getByRole("button", { name: /Find the notes/ }).click();
      await expect(form.getByTestId("score-preview")).toHaveAttribute("data-drawn", "true", {
        timeout: 30_000,
      });
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
      await form.getByRole("button", { name: "Add to score" }).click();
      await expect(form.getByTestId("lane-to-tab-result")).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
    });
  }
});
