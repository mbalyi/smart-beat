import type { Locator, Page } from "@playwright/test";

import { emitMenuAction, expect, expectNoA11yViolations, openSong, test } from "./fixtures";

/**
 * The audio lanes under the tabs in the continuous layout (#185): one row per lane directly under
 * the last stacked track, each clip placed on the score's bars (measured from the drawn notation),
 * edited in place. Decoding and playback are in the (mocked) engine.
 */

/** The part of a saved mix the tests below reach into. */
interface SavedMix {
  audio?: { lanes: { hiddenInScore?: boolean }[] };
}

/** Opens the practice song with the native engine on (the lanes play there). */
async function openWithEngine(app: Page) {
  await openSong(app);
  await app.getByRole("switch", { name: "Native engine with effects" }).click();
  await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
}

/** Opens `file` as a new lane from the Track menu. */
async function addLane(app: Page, file: string) {
  await app.evaluate((path) => (window.__dialogResult = path), file);
  await emitMenuAction(app, "import-audio-file");
  const name = file
    .split("/")
    .pop()!
    .replace(/\.[^.]+$/, "");
  await expect(app.getByRole("button", { name: `Edit the lane ${name}` })).toBeVisible();
}

/** The start of every clip on lane `index`, in ms. */
const clipStarts = (app: Page, index: number) =>
  app.evaluate((i) => window.__engineLanes?.audio.lanes[i]?.clips.map((c) => c.startMs), index);

test.describe("lanes under the tabs in the continuous layout", () => {
  test.use({ viewport: { width: 1280, height: 1000 } });

  /** Two lanes of one four-second clip each, with the score drawn continuously. */
  async function openWithBand(app: Page) {
    await openWithEngine(app);
    await addLane(app, "/Users/me/Music/take.mp3");
    await addLane(app, "/Users/me/Music/other.mp3");
    await app.getByRole("radio", { name: "Continuous" }).click();
    const band = app.getByTestId("score-lanes-band");
    await expect(band).toBeVisible();
    return band;
  }

  const clipOf = (band: Locator, name: string) =>
    band.getByRole("button", { name: new RegExp(`${name}\\.mp3 on ${name}`) });

  test("shows under the tabs, one row per lane, and not in the page layout", async ({ app }) => {
    const band = await openWithBand(app);
    await expect(
      band.getByRole("group", { name: /Audio lane take under the score/ }),
    ).toBeVisible();
    await expect(
      band.getByRole("group", { name: /Audio lane other under the score/ }),
    ).toBeVisible();
    // Directly under the last drawn track, never over a note.
    const surface = (await app.locator(".at-surface").first().boundingBox())!;
    const box = (await band.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(surface.y + surface.height - 1);
    expect(box.y).toBeLessThan(surface.y + surface.height + 40);
    // The first lane sits above the second.
    const first = (await band
      .getByTestId(/^band-lane-[^n]/)
      .first()
      .boundingBox())!;
    const second = (await band
      .getByTestId(/^band-lane-[^n]/)
      .nth(1)
      .boundingBox())!;
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height - 1);

    await app.getByRole("radio", { name: "Page" }).click();
    await expect(app.getByTestId("score-lanes-band")).toHaveCount(0);
    await app.getByRole("radio", { name: "Continuous" }).click();
    await expect(app.getByTestId("score-lanes-band")).toBeVisible();
  });

  test("a clip lines up with the bars of the score", async ({ app }) => {
    const band = await openWithBand(app);
    // The song is at 60 bpm and the clip is four seconds: exactly the first bar.
    const clip = (await clipOf(band, "take").boundingBox())!;
    const bar0 = (await band.getByTestId("band-bar-0").boundingBox())!;
    const bar1 = (await band.getByTestId("band-bar-1").boundingBox())!;
    expect(Math.abs(clip.x - bar0.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(clip.x + clip.width - bar1.x)).toBeLessThanOrEqual(2);
    // And the notation draws the second bar there: its number sits just inside the bar line.
    const number = await app.locator(".at-surface svg:visible text").evaluateAll(
      (texts, x) =>
        texts
          .filter((t) => t.textContent?.trim() === "2")
          .map((t) => t.getBoundingClientRect().left - x)
          .sort((a, b) => Math.abs(a) - Math.abs(b))[0],
      bar1.x,
    );
    expect(Math.abs(number ?? 999)).toBeLessThanOrEqual(24);
  });

  test("a clip dragged along its lane lands on a beat, and onto another lane moves there", async ({
    app,
  }) => {
    const band = await openWithBand(app);
    const from = (await clipOf(band, "take").boundingBox())!;
    const bar1 = (await band.getByTestId("band-bar-1").boundingBox())!;
    const bar2 = (await band.getByTestId("band-bar-2").boundingBox())!;
    const y = from.y + from.height / 2;
    await app.mouse.move(from.x + from.width / 2, y);
    await app.mouse.down();
    // One bar to the right, whatever width the bars have.
    await app.mouse.move(from.x + from.width / 2 + (bar2.x - bar1.x), y, { steps: 6 });
    await app.mouse.up();
    await expect.poll(async () => (await clipStarts(app, 0))?.[0]).toBeGreaterThanOrEqual(3000);
    const [start] = (await clipStarts(app, 0))!;
    expect(start! % 1000).toBe(0);

    // Down onto the second lane.
    const moved = (await clipOf(band, "take").boundingBox())!;
    const other = (await band
      .getByTestId(/^band-lane-[^n]/)
      .nth(1)
      .boundingBox())!;
    await app.mouse.move(moved.x + moved.width / 2, moved.y + moved.height / 2);
    await app.mouse.down();
    await app.mouse.move(moved.x + moved.width / 2, other.y + other.height / 2, { steps: 6 });
    await app.mouse.up();
    await expect
      .poll(() => app.evaluate(() => window.__engineLanes?.audio.lanes[1]?.clips.length))
      .toBe(2);
  });

  test("splits at the position line with S, and shows handles on the selected clip", async ({
    app,
  }) => {
    const band = await openWithBand(app);
    const clip = clipOf(band, "take");
    await expect(band.getByTestId(/clip-handles-/)).toHaveCount(0);
    const box = (await clip.boundingBox())!;
    // A click puts the edit cursor (and playback) at that point and selects the clip.
    await clip.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await expect(band.getByTestId(/clip-handles-/)).toHaveCount(1);
    await app.keyboard.press("s");
    await expect
      .poll(() => app.evaluate(() => window.__engineLanes?.audio.lanes[0]?.clips.length))
      .toBe(2);
    // The cursor and the position line run through the band.
    await expect(band.getByTestId("band-edit-cursor")).toBeVisible();
    await expect(band.getByTestId("band-position-line")).toBeVisible();
  });

  /** Saves the song's mix with the lanes at `indexes` hidden from the band, and opens it again. */
  async function reopenWithHidden(app: Page, indexes: number[]) {
    await expect
      .poll(() =>
        app.evaluate(
          () => (([...window.__mixes.values()][0] ?? {}) as SavedMix).audio?.lanes.length,
        ),
      )
      .toBe(2);
    await app.evaluate((hidden) => {
      for (const mix of window.__mixes.values()) {
        (mix as SavedMix).audio?.lanes.forEach((lane, i) => {
          if (hidden.includes(i)) lane.hiddenInScore = true;
        });
      }
    }, indexes);
    await openSong(app);
    await app.getByRole("switch", { name: "Native engine with effects" }).click();
  }

  test("a lane saved as hidden has no row under the tabs but stays in the track list", async ({
    app,
  }) => {
    await openWithBand(app);
    await reopenWithHidden(app, [1]);
    const band = app.getByTestId("score-lanes-band");
    await expect(band).toBeVisible();
    await expect(
      band.getByRole("group", { name: /Audio lane take under the score/ }),
    ).toBeVisible();
    await expect(band.getByRole("group", { name: /Audio lane other under the score/ })).toHaveCount(
      0,
    );
    await expect(band.getByRole("button", { name: /other\.mp3 on other/ })).toHaveCount(0);
    // The lane is still part of the song: the track list shows it and the engine plays it.
    await expect(app.getByRole("button", { name: "Edit the lane other" })).toBeVisible();
    await expect.poll(() => app.evaluate(() => window.__engineLanes?.audio.lanes.length)).toBe(2);
  });

  test("with every lane hidden the band is not drawn at all", async ({ app }) => {
    await openWithBand(app);
    await reopenWithHidden(app, [0, 1]);
    await expect(app.getByRole("button", { name: "Edit the lane take" })).toBeVisible();
    await expect(app.getByTestId("score-lanes-band")).toHaveCount(0);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`has no accessibility violations in ${colorScheme} mode`, async ({ app }) => {
      await app.emulateMedia({ colorScheme });
      const band = await openWithBand(app);
      // Select a clip (its handles show) at its start, where the playhead lines of the track
      // list's narrow clips do not cut them in two for the target-size check.
      await clipOf(band, "take").click({ position: { x: 2, y: 30 } });
      await expect(band.getByTestId(/clip-handles-/)).toHaveCount(1);
      await app.mouse.move(2, 2);
      await expectNoA11yViolations(app);
    });
  }
});
