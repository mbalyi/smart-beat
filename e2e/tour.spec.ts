import { emitMenuAction, expect, expectNoA11yViolations, test, waitForScore } from "./fixtures";

import type { Page } from "@playwright/test";

const TOUR_KEY = "smart-beat:tour";

const coachMark = (page: Page) => page.getByTestId("coach-mark");
/** The usage counters the page asked the core to record (#153), as `event:tour`. */
const counted = (page: Page) =>
  page.evaluate(() =>
    window.__ipcCalls
      .filter((call) => call.cmd === "track_event")
      .map((call) => call.args as { event: string; format: string | null })
      .filter((args) => args.event.startsWith("tour_"))
      .map((args) => `${args.event}:${args.format}`),
  );
const tourState = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), TOUR_KEY);
/** What the tour saved for `id`, once it has been saved. */
const savedProgress = (page: Page, id: string) =>
  expect.poll(async () => (await tourState(page))?.tours[id], { timeout: 15_000 });

/** Presses the coach mark's Next button until the tour is over (at most 14 steps). */
async function clickThrough(page: Page) {
  for (let i = 0; i < 14; i++) {
    const mark = coachMark(page);
    await expect(mark).toBeVisible({ timeout: 60_000 });
    const last = (await mark.getByRole("button", { name: "Done" }).count()) > 0;
    await mark.getByRole("button", { name: last ? "Done" : "Next" }).click();
    if (last) break;
  }
  await expect(coachMark(page)).toHaveCount(0);
}

test.describe("first launch", () => {
  test.use({ firstLaunch: true });

  test("offers the tour once, and Skip for now is remembered", async ({ app }) => {
    const offer = app.getByRole("region", { name: "New here? Take a quick tour" });
    await expect(offer).toBeVisible();
    await offer.getByRole("button", { name: "Skip for now" }).click();
    await expect(offer).toHaveCount(0);
    expect((await tourState(app)).tours.main).toBe("skipped");
    expect(await counted(app)).toEqual(["tour_skip:main"]);

    await app.reload();
    await expect(app.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(app.getByRole("region", { name: "New here? Take a quick tour" })).toHaveCount(0);
  });

  test("the quick tour opens the demo song, restores the panels and is remembered", async ({
    app,
  }) => {
    await app.getByRole("button", { name: "Take a quick tour" }).click();
    await expect(coachMark(app)).toContainText("Open a song");
    await expect(coachMark(app)).toContainText("Step 1 of 13");
    await coachMark(app).getByRole("button", { name: "Next" }).click();

    // Step 2 needs a song: the demo song (4 tracks, 24 bars) opens by itself.
    await expect(coachMark(app)).toContainText("Your score", { timeout: 60_000 });
    await waitForScore(app);
    await expect(app.getByRole("timer")).toContainText("/ 0:57");

    // The mixer step shows the panel the user had closed...
    for (const title of [
      "Play it",
      "Slow it down",
      "Metronome",
      "Practice View",
      "Page or continuous",
    ]) {
      await coachMark(app).getByRole("button", { name: "Next" }).click();
      await expect(coachMark(app)).toContainText(title);
    }
    await coachMark(app).getByRole("button", { name: "Next" }).click();
    await expect(coachMark(app)).toContainText("Tracks and mixer");
    await expect(app.getByRole("region", { name: "Tracks and mixer" })).toBeVisible();

    // Stacking tracks (#157) points at the same panel.
    await coachMark(app).getByRole("button", { name: "Next" }).click();
    await expect(coachMark(app)).toContainText("Show several tracks at once");

    // The SoundFonts dialog is part of the tour (#81): the step shows the track panel and points
    // at its SoundFonts… button.
    await coachMark(app).getByRole("button", { name: "Next" }).click();
    await expect(coachMark(app)).toContainText("More instrument sounds");
    await expect(coachMark(app)).toContainText("SoundFonts…");
    await expect(app.getByRole("button", { name: "SoundFonts…" })).toBeVisible();

    await clickThrough(app);
    // ...and puts it back when the tour ends.
    await expect(app.getByRole("region", { name: "Tracks and mixer" })).toHaveCount(0);
    await savedProgress(app, "main").toBe("done");
    expect(await counted(app)).toEqual(["tour_start:main", "tour_finish:main"]);

    await app.reload();
    await expect(app.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(app.getByRole("region", { name: "New here? Take a quick tour" })).toHaveCount(0);
  });

  test("Back goes to the previous step and Skip ends the tour for good", async ({ app }) => {
    await app.getByRole("button", { name: "Take a quick tour" }).click();
    await coachMark(app).getByRole("button", { name: "Next" }).click();
    await expect(coachMark(app)).toContainText("Your score", { timeout: 60_000 });
    // The start page is gone, so its step cannot be shown again: there is no Back.
    await expect(coachMark(app).getByRole("button", { name: "Back" })).toHaveCount(0);
    await coachMark(app).getByRole("button", { name: "Next" }).click();
    await expect(coachMark(app)).toContainText("Play it");
    await coachMark(app).getByRole("button", { name: "Back" }).click();
    await expect(coachMark(app)).toContainText("Your score");
    await coachMark(app).getByRole("button", { name: "Skip" }).click();
    await expect(coachMark(app)).toHaveCount(0);
    await savedProgress(app, "main").toBe("skipped");
    expect(await counted(app)).toEqual(["tour_start:main", "tour_skip:main"]);
  });

  test("works with the keyboard alone: Enter goes on, Escape closes", async ({ app }) => {
    await app.getByRole("button", { name: "Take a quick tour" }).click();
    await expect(coachMark(app)).toContainText("Open a song");
    // Focus moves to Next when a step opens.
    await expect(coachMark(app).getByRole("button", { name: "Next" })).toBeFocused();
    await app.keyboard.press("Enter");
    await expect(coachMark(app)).toContainText("Your score", { timeout: 60_000 });
    await app.keyboard.press("Escape");
    await expect(coachMark(app)).toHaveCount(0);
    // Closing midway remembers the step and never leaves the demo's panels changed.
    await savedProgress(app, "main").toEqual({ step: 1 });
    expect(await counted(app)).toEqual(["tour_start:main", "tour_close:main"]);
  });
});

test.describe("an existing user", () => {
  test("is not offered the tour or shown the layout of a new install", async ({ app }) => {
    await expect(app.getByRole("region", { name: "New here? Take a quick tour" })).toHaveCount(0);
    expect((await tourState(app)).tours.main).toBe("skipped");
  });

  test("Help › Take the Tour replays it with a song open, and Continue resumes", async ({
    app,
  }) => {
    await emitMenuAction(app, "demo-song");
    await waitForScore(app);
    await emitMenuAction(app, "tour");
    // The start page's Open button is not there with a song open: the tour begins at the score.
    await expect(coachMark(app)).toContainText("Your score");
    await coachMark(app).getByRole("button", { name: "Next" }).click();
    await expect(coachMark(app)).toContainText("Play it");
    await app.keyboard.press("Escape");

    await app.getByRole("button", { name: "Help" }).click();
    await expect(app.getByRole("menuitem", { name: "Continue the Tour" })).toBeVisible();
  });

  test("a step whose control is missing is skipped without getting stuck", async ({ app }) => {
    await emitMenuAction(app, "demo-song");
    await waitForScore(app);
    // Step 2 points at the Speed select: without it, the tour passes over it, not hangs.
    await emitMenuAction(app, "tour-speed-trainer");
    await expect(coachMark(app)).toContainText("Choose a passage");
    await app.evaluate(() => document.querySelector("[data-tour=speed]")?.remove());
    await coachMark(app).getByRole("button", { name: "Next" }).click();
    await expect(coachMark(app)).toContainText("Count in instead", { timeout: 15_000 });
    await expect(coachMark(app)).toContainText("Step 3 of");
    await app.keyboard.press("Escape");
    await expect(coachMark(app)).toHaveCount(0);
  });

  test("the editing tour turns Edit mode on for the palette and puts it back", async ({ app }) => {
    await emitMenuAction(app, "demo-song");
    await waitForScore(app);
    await emitMenuAction(app, "tour-editing");
    await expect(coachMark(app)).toContainText("Edit mode");
    await coachMark(app).getByRole("button", { name: "Next" }).click();
    await expect(coachMark(app)).toContainText("Note palette");
    await expect(app.getByRole("complementary", { name: "Note palette" })).toBeVisible();
    await app.keyboard.press("Escape");
    await expect(app.getByRole("complementary", { name: "Note palette" })).toHaveCount(0);
  });

  test("Help › Open Demo Song opens the original demo with four tracks", async ({ app }) => {
    await emitMenuAction(app, "demo-song");
    await waitForScore(app);
    await expect(app.getByRole("navigation", { name: "Open songs" })).toContainText(
      "Smart Beat Demo",
    );
    await expect(app.getByRole("timer")).toContainText("/ 0:57");
  });
});

test.describe("What's new", () => {
  test("lists what came after the last seen version once, with Show me", async ({ app }) => {
    await app.evaluate(() =>
      localStorage.setItem(
        "smart-beat:tour",
        JSON.stringify({ tours: { main: "done" }, hints: {}, lastSeenVersion: "0.9.0" }),
      ),
    );
    await app.reload();
    const dialog = app.getByRole("dialog", { name: /What’s new in/ });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Speed Trainer");
    await dialog.getByRole("button", { name: "Show me: Speed Trainer" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(coachMark(app)).toContainText("Choose a passage", { timeout: 60_000 });
    await app.keyboard.press("Escape");
    expect((await tourState(app)).lastSeenVersion).not.toBe("0.9.0");

    await app.reload();
    await expect(app.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(app.getByRole("dialog", { name: /What’s new in/ })).toHaveCount(0);
  });
});

test.describe("responsive and accessible", () => {
  test.use({ firstLaunch: true });

  for (const width of [640, 1024, 1440]) {
    test(`the coach mark stays inside the window at ${width}px`, async ({ app }) => {
      await app.setViewportSize({ width, height: 800 });
      await app.getByRole("button", { name: "Take a quick tour" }).click();
      await coachMark(app).getByRole("button", { name: "Next" }).click();
      await expect(coachMark(app)).toContainText("Your score", { timeout: 60_000 });
      const box = (await coachMark(app).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y).toBeGreaterThanOrEqual(0);
    });
  }

  for (const scheme of ["light", "dark"] as const) {
    test(`has no accessibility violations in ${scheme} mode`, async ({ app }) => {
      await app.emulateMedia({ colorScheme: scheme });
      await expectNoA11yViolations(app); // the welcome page with the tour offer
      await app.getByRole("button", { name: "Take a quick tour" }).click();
      await expect(coachMark(app)).toBeVisible();
      await expectNoA11yViolations(app);
    });
  }
});

test.describe("the Limits popup of Record to tab", () => {
  test("opens below its link and is wide enough for its list", async ({ app }) => {
    await app.setViewportSize({ width: 1280, height: 900 });
    const limits = app.getByRole("button", { name: "Limits" });
    await limits.scrollIntoViewIfNeeded();
    await limits.hover();
    const popup = app.locator("[data-slot=hover-card-content]");
    await expect(popup).toBeVisible();
    const [link, box] = [(await limits.boundingBox())!, (await popup.boundingBox())!];
    expect(box.y).toBeGreaterThanOrEqual(link.y + link.height - 1);
    expect(box.width).toBeGreaterThanOrEqual(480);
  });
});

test.describe("the start page and the header", () => {
  test("Take a tour is the last button; it starts the tour and Next opens the demo tab", async ({
    app,
  }) => {
    const buttons = app.locator("main section").first().getByRole("button");
    await expect(buttons.last()).toHaveText("Take a tour");
    await buttons.last().click();
    await expect(coachMark(app)).toContainText("Open a song");
    await expect(coachMark(app)).toContainText("opens a demo song in a new tab");
    await coachMark(app).getByRole("button", { name: "Next" }).click();
    await expect(app.getByRole("navigation", { name: "Open songs" })).toContainText(
      "Smart Beat Demo",
      { timeout: 60_000 },
    );
  });

  test("the Record to Tab button sits after the Edited badge and before the transport", async ({
    app,
  }) => {
    await emitMenuAction(app, "demo-song");
    await waitForScore(app);
    const record = app.getByRole("button", { name: "Record to Tab" });
    const first = app.getByRole("button", { name: "Play" });
    const redo = app.getByRole("button", { name: /^Redo|Nothing to redo/ }).first();
    const [r, f, u] = [
      await record.boundingBox(),
      await first.boundingBox(),
      await redo.boundingBox(),
    ];
    expect(u!.x).toBeLessThan(r!.x);
    expect(r!.x).toBeLessThan(f!.x);
  });

  test("the last step of the main tour offers the other tours and starts the one picked", async ({
    app,
  }) => {
    await emitMenuAction(app, "demo-song");
    await waitForScore(app);
    await emitMenuAction(app, "tour");
    for (let i = 0; i < 14; i++) {
      await expect(coachMark(app)).toBeVisible();
      if (await coachMark(app).getByRole("button", { name: "Editing tour" }).count()) break;
      await coachMark(app).getByRole("button", { name: "Next" }).click();
    }
    const choice = coachMark(app).getByRole("button", { name: /Speed Trainer tour/ });
    await expect(choice).toBeVisible();
    await choice.click();
    await expect(coachMark(app)).toContainText("Step 1 of", { timeout: 15_000 });
    await expect(coachMark(app).getByRole("heading")).not.toHaveText("You are set");
    await savedProgress(app, "main").toBe("done");
  });
});
