import type { Page } from "@playwright/test";

import {
  expect,
  expectNoA11yViolations,
  openSong,
  scoreRegion,
  tabKey,
  test,
  waitForScore,
  waitForAnimations,
} from "./fixtures";

/** Continuous view with several tracks stacked and bar-aligned (#157). */
const mixer = (page: Page) => page.getByRole("region", { name: "Tracks and mixer" });
const context = (page: Page) => page.getByTestId("bar-context");

/** Where the dimmed bars (the tracks that are not edited) are drawn: left edges and tops. */
async function contextBars(page: Page) {
  await expect.poll(() => context(page).count()).toBeGreaterThan(0);
  return context(page).evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), right: Math.round(r.right) };
    }),
  );
}

async function stack(page: Page, ...tracks: string[]) {
  await page.getByRole("radio", { name: "Continuous" }).click();
  for (const track of tracks) {
    await mixer(page)
      .getByRole("button", { name: `Visible: ${track}` })
      .click();
  }
  await waitForScore(page);
}

test.describe("several tracks in the continuous view (#157)", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("shows one track by default and stacks more under it, with the edited one in front", async ({
    app,
  }) => {
    await openSong(app);
    await expect(context(app)).toHaveCount(0);
    const single = (await app.locator(".at-surface").first().boundingBox())!.height;

    await stack(app, "Drums");

    await expect(scoreRegion(app)).toHaveAccessibleName("Score: Guitar");
    expect((await app.locator(".at-surface").first().boundingBox())!.height).toBeGreaterThan(
      single,
    );
    // The drums are drawn dimmed, below the guitar, in the same columns.
    const drumsBelow = await contextBars(app);
    expect(drumsBelow.length).toBeGreaterThan(1);

    // Back to the page layout: only the edited track, no dimming.
    await app.getByRole("radio", { name: "Page" }).click();
    await expect(context(app)).toHaveCount(0);
  });

  test("lines the bars up whatever the order of the tracks", async ({ app }) => {
    await openSong(app);
    await stack(app, "Drums");
    const below = await contextBars(app);

    await mixer(app).getByRole("button", { name: "Actions for Drums" }).click();
    await app.getByRole("menuitem", { name: "Move up in the view" }).click();
    await waitForScore(app);
    await expect.poll(async () => (await contextBars(app))[0]!.y).toBeLessThan(below[0]!.y);
    const above = await contextBars(app);

    // The guitar is now the dimmed one, but its bars end where the drums' bars ended: the same
    // distances between the bar ends (the whole view may have moved a little).
    const gaps = (bars: { right: number }[]) => {
      const ends = [...new Set(bars.map((b) => b.right))].sort((a, b) => a - b);
      return ends.slice(1).map((end, i) => end - ends[i]!);
    };
    const drumGaps = gaps(below);
    expect(drumGaps.length).toBeGreaterThan(1);
    gaps(above).forEach((gap, i) => expect(Math.abs(gap - drumGaps[i]!)).toBeLessThanOrEqual(1));
    // The file order of the tracks is untouched.
    await expect(mixer(app).getByRole("listitem").nth(2)).toContainText("Drums");
  });

  test("edits only the active track, and a click on another track makes it the active one", async ({
    app,
  }) => {
    await openSong(app);
    await stack(app, "Bass");
    await expect(scoreRegion(app)).toHaveAccessibleName("Score: Guitar");

    await mixer(app)
      .getByRole("button", { name: /^Show Bass/ })
      .click();

    await expect(scoreRegion(app)).toHaveAccessibleName("Score: Bass");
    // Both tracks are still in the view; the guitar is the dimmed one now.
    await expect(mixer(app).getByRole("button", { name: "Visible: Guitar" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await contextBars(app);
    // The track being edited cannot be taken out of the view.
    await expect(mixer(app).getByRole("button", { name: "Visible: Bass" })).toBeDisabled();
  });

  test("remembers the stacked tracks and their order when the song is opened again", async ({
    app,
  }) => {
    await openSong(app);
    await stack(app, "Drums", "Bass");
    await mixer(app).getByRole("button", { name: "Actions for Bass" }).click();
    await app.getByRole("menuitem", { name: "Move up in the view" }).click();
    await expect
      .poll(() =>
        app.evaluate(() =>
          [...window.__mixes.values()].map(
            (m) => (m as { visibleTracks?: number[] }).visibleTracks ?? [],
          ),
        ),
      )
      .toEqual([[0, 1, 2]]);

    const tabs = app.getByRole("navigation", { name: "Open songs" });
    await tabs.getByRole("button", { name: "Close Practice Song" }).click();
    await openSong(app);

    await expect(app.getByRole("radio", { name: "Continuous" })).toBeChecked();
    await expect(mixer(app).getByRole("button", { name: "Visible: Drums" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(
      mixer(app).getByRole("button", { name: /^Show Bass .*position 2 of 3/ }),
    ).toBeVisible();
  });

  test("counts the continuous layout and the first stack of tracks, once each", async ({ app }) => {
    await openSong(app);
    await stack(app, "Drums", "Bass");
    const events = await app.evaluate(() =>
      window.__ipcCalls
        .filter((c) => c.cmd === "track_event")
        .map((c) => (c.args as { event: string }).event),
    );
    expect(events.filter((e) => e === "continuous_view")).toHaveLength(1);
    expect(events.filter((e) => e === "multi_track_view")).toHaveLength(1);
  });

  test("can be used by keyboard alone", async ({ app, browserName }) => {
    const tab = tabKey(browserName);
    await openSong(app);
    await app.getByRole("radio", { name: "Continuous" }).click();

    const eye = mixer(app).getByRole("button", { name: "Visible: Drums" });
    await eye.focus();
    await app.keyboard.press("Space");
    await expect(eye).toHaveAttribute("aria-pressed", "true");

    // Alt+Up on the name moves the track up in the view; the grip also takes the arrows.
    const name = mixer(app).getByRole("button", { name: /^Show Drums/ });
    await name.focus();
    await expect(name).toHaveAccessibleName(/position 2 of 2/);
    await app.keyboard.press("Alt+ArrowUp");
    await expect(mixer(app).getByRole("button", { name: /^Show Drums/ })).toHaveAccessibleName(
      /position 1 of 2/,
    );
    const grip = mixer(app).getByRole("button", { name: "Reorder Drums in the view" });
    await grip.focus();
    await app.keyboard.press("ArrowDown");
    await expect(mixer(app).getByRole("button", { name: /^Show Drums/ })).toHaveAccessibleName(
      /position 2 of 2/,
    );
    // Tab leaves the grip for the next control.
    await app.keyboard.press(tab);
    await expect(grip).not.toBeFocused();
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`has no WCAG violations with tracks stacked in ${colorScheme} mode`, async ({ app }) => {
      await app.emulateMedia({ colorScheme });
      await openSong(app);
      await stack(app, "Drums");
      await waitForAnimations(app);
      await expectNoA11yViolations(app);

      await mixer(app).getByRole("button", { name: "Actions for Drums" }).click();
      await expect(app.getByRole("menuitem", { name: "Move up in the view" })).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role=menu]" });
    });
  }
});

test.describe("picking a bar in the track list shows it in the score", () => {
  test.use({ viewport: { width: 700, height: 900 } });

  for (const playing of [false, true]) {
    test(`scrolls the continuous row to the bar${playing ? " while playing" : ""}`, async ({
      app,
    }) => {
      await openSong(app);
      await app.getByRole("radio", { name: "Continuous" }).click();
      await waitForScore(app);
      const score = scoreRegion(app);
      await expect
        .poll(() => score.evaluate((el) => el.scrollWidth - el.clientWidth))
        .toBeGreaterThan(100);
      await app.waitForTimeout(500);
      const before = await score.evaluate((el) => el.scrollLeft);
      if (playing) {
        await app.getByRole("button", { name: "Play" }).click();
        await expect(app.getByRole("button", { name: "Pause" })).toBeVisible();
      }

      await mixer(app).locator("ol > li").first().locator("button[tabindex='-1']").nth(3).click();

      // The fourth bar is now at the left edge of the score, without waiting for the cursor.
      await expect.poll(() => score.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before + 50);
      await expect(app.getByRole("spinbutton", { name: "Bar" })).toHaveValue("4");
    });
  }
});
