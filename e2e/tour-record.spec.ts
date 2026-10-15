import type { Page } from "@playwright/test";

import features from "../src/lib/features.json" with { type: "json" };
import { emitMenuAction, expect, test, waitForScore } from "./fixtures";

/** The Record to Tab tour (#84): it opens the Record dialog and walks through it from inside. */

test.skip(!features["record-2-tab"], "record-2-tab is off in src/lib/features.json");

const TOUR_KEY = "smart-beat:tour";

const coachMark = (page: Page) => page.getByTestId("coach-mark");
/** The Record to Tab dialog (its title reads "Record to Tab" and the Beta badge). */
const recordDialog = (page: Page) =>
  page.getByRole("dialog", { name: /Record/ }).filter({ has: page.locator("[data-tour-slot]") });
const savedProgress = (page: Page) =>
  expect.poll(
    () =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? "null")?.tours["record-to-tab"],
        TOUR_KEY,
      ),
    { timeout: 15_000 },
  );

/** A microphone that plays a tone, so the dialog's input level never asks for permission. */
async function installMicrophone(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => [
          { kind: "audioinput", deviceId: "scarlett", label: "Scarlett 2i2 USB", groupId: "" },
        ],
        getUserMedia: async () => {
          const context = new AudioContext();
          const tone = context.createOscillator();
          const destination = context.createMediaStreamDestination();
          tone.connect(destination);
          tone.start();
          return destination.stream;
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
  });
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

/** The in-dialog step titles, in order, and the control each one outlines. */
const IN_DIALOG_STEPS = [
  { title: "Choose your instrument", target: "record-instrument" },
  { title: "Recording mode", target: "record-mode" },
  { title: "Guitar and bass: match the tuning", target: "record-track" },
  { title: "Piano: better notes", target: "record-piano-model" },
  { title: "Drums", target: "record-instrument" },
  { title: "It's a beta", target: "record-limits" },
  { title: "Start recording", target: "record-start" },
] as const;

/** Checks that the current step is drawn inside the dialog and outlines `target` there. */
async function expectInDialogStep(page: Page, title: string, target: string) {
  const dialog = recordDialog(page);
  await expect(dialog).toBeVisible();
  const card = dialog.getByTestId("coach-mark");
  await expect(card).toContainText(title);
  await expect(coachMark(page)).toHaveCount(1);
  await expect(dialog.locator(`[data-tour="${target}"]`)).toHaveAttribute("data-tour-active", "");
}

test.describe("Record to Tab tour", () => {
  // Uncaught errors in the page while the tour runs fail the test.
  let errors: string[] = [];
  test.beforeEach(async ({ app }) => {
    errors = [];
    app.on("pageerror", (error) => errors.push(error.message));
    await installMicrophone(app);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test("Next opens the Record dialog, every later step is drawn inside it, and Done closes it", async ({
    app,
  }) => {
    test.slow();
    await emitMenuAction(app, "tour-record-to-tab");
    // Step 1 points at the red header button (the demo song opens first).
    await expect(coachMark(app)).toContainText("Record to Tab", { timeout: 60_000 });
    await expect(coachMark(app)).toContainText("Step 1 of 8");
    await waitForScore(app);
    await expect(app.locator('[data-tour="record"]')).toHaveAttribute("data-tour-active", "");
    await expect(recordDialog(app)).toHaveCount(0);

    await coachMark(app).getByRole("button", { name: "Next" }).click();
    await expect(recordDialog(app)).toBeVisible();

    for (const [i, step] of IN_DIALOG_STEPS.entries()) {
      // The piano model choice is shown once Piano is picked, as the step says.
      if (step.target === "record-piano-model") {
        await recordDialog(app).getByRole("radio", { name: "Piano" }).click();
      }
      await expectInDialogStep(app, step.title, step.target);
      await expect(coachMark(app)).toContainText(`Step ${i + 2} of 8`);
      const last = i === IN_DIALOG_STEPS.length - 1;
      await coachMark(app)
        .getByRole("button", { name: last ? "Done" : "Next" })
        .click();
    }

    await expect(coachMark(app)).toHaveCount(0);
    await expect(recordDialog(app)).toHaveCount(0);
    await savedProgress(app).toBe("done");
  });

  test("Back from the first step in the dialog closes it and points at the header button", async ({
    app,
  }) => {
    await emitMenuAction(app, "tour-record-to-tab");
    await expect(coachMark(app)).toContainText("Step 1 of 8", { timeout: 60_000 });
    await waitForScore(app);
    await coachMark(app).getByRole("button", { name: "Next" }).click();
    await expectInDialogStep(app, "Choose your instrument", "record-instrument");

    await coachMark(app).getByRole("button", { name: "Back" }).click();
    await expect(recordDialog(app)).toHaveCount(0);
    await expect(coachMark(app)).toContainText("Step 1 of 8");
  });

  test("started with the dialog open, the tour begins inside it", async ({ app }) => {
    await emitMenuAction(app, "demo-song");
    await waitForScore(app);
    await app.locator('[data-tour="record"]').click();
    await expect(recordDialog(app)).toBeVisible();

    await emitMenuAction(app, "tour-record-to-tab");
    await expectInDialogStep(app, "Choose your instrument", "record-instrument");
    await expect(coachMark(app)).toContainText("Step 2 of 8");
  });

  test("Escape on a step in the dialog ends the tour as interrupted", async ({ app }) => {
    await emitMenuAction(app, "tour-record-to-tab");
    await expect(coachMark(app)).toContainText("Step 1 of 8", { timeout: 60_000 });
    await waitForScore(app);
    await coachMark(app).getByRole("button", { name: "Next" }).click();
    await expectInDialogStep(app, "Choose your instrument", "record-instrument");
    await coachMark(app).getByRole("button", { name: "Next" }).click();
    await expectInDialogStep(app, "Recording mode", "record-mode");

    await app.keyboard.press("Escape");
    await expect(recordDialog(app)).toHaveCount(0);
    await expect(coachMark(app)).toHaveCount(0);
    // Interrupted after the first step: the step it stopped at is kept, to go on later.
    await savedProgress(app).toEqual({ step: 2 });
  });
});
