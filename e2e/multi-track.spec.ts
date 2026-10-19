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
/** Height of the drawn score: it grows with every stacked staff (and a drum tab). */
const drawnHeight = (page: Page) =>
  page
    .locator(".at-surface svg:visible")
    .evaluateAll((svgs) =>
      Math.round(Math.max(...svgs.map((svg) => svg.getBoundingClientRect().height))),
    );

/** The track names drawn at the left of the staves, top to bottom. */
const drawnOrder = (page: Page) =>
  page.locator(".at-surface svg:visible text").evaluateAll((texts) =>
    texts
      .filter((t) => ["Guitar", "Bass", "Drums", "Piano"].includes(t.textContent?.trim() ?? ""))
      .map((t) => ({ name: t.textContent!.trim(), top: t.getBoundingClientRect().top }))
      .sort((a, b) => a.top - b.top)
      .map((t) => t.name),
  );

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
    const single = await drawnHeight(app);

    await stack(app, "Drums");

    await expect(scoreRegion(app)).toHaveAccessibleName("Score: Guitar");
    await expect.poll(() => drawnHeight(app)).toBeGreaterThan(single);
    // Nothing is dimmed or covered: the other track is drawn as it is.
    await expect(app.locator(".at-surface").first()).toBeVisible();

    // Back to the page layout: only the edited track.
    await app.getByRole("radio", { name: "Page" }).click();
    await expect.poll(() => drawnHeight(app)).toBe(single);
  });

  test("reorders the stacked tracks without touching the order in the file", async ({ app }) => {
    await openSong(app);
    await stack(app, "Drums");
    await expect.poll(() => drawnOrder(app)).toEqual(["Guitar", "Drums"]);

    await mixer(app).getByRole("button", { name: "Actions for Drums" }).click();
    await app.getByRole("menuitem", { name: "Move up in the view" }).click();

    await expect.poll(() => drawnOrder(app)).toEqual(["Drums", "Guitar"]);
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
    // Both tracks are still in the view.
    await expect(mixer(app).getByRole("button", { name: "Visible: Guitar" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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

  test("keeps the drum tab of a stacked drum track while the guitar is edited and after reopening", async ({
    app,
  }) => {
    await openSong(app);
    await stack(app, "Drums");
    // The drums are shown as score and tab: the tab staff makes the stack taller.
    const height = await drawnHeight(app);

    await app.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(scoreRegion(app)).toBeFocused();
    await app.keyboard.press("3");
    await waitForScore(app);
    await expect.poll(() => drawnHeight(app)).toBeGreaterThan(height - 40);

    const tabs = app.getByRole("navigation", { name: "Open songs" });
    await expect.poll(() => app.evaluate(() => window.__mixes.size)).toBeGreaterThan(0);
    await tabs.getByRole("button", { name: "Close Practice Song" }).click();
    // An edited song asks before it closes.
    const discard = app.getByRole("button", { name: /Don.t save|Discard/ });
    if (await discard.isVisible().catch(() => false)) await discard.click();
    await openSong(app);
    await expect.poll(() => drawnHeight(app)).toBeGreaterThan(height - 40);
  });

  test("reopens on the edited track with the stack it was saved with, even without the first track", async ({
    app,
  }) => {
    await openSong(app);
    await app.getByRole("radio", { name: "Continuous" }).click();
    await mixer(app)
      .getByRole("button", { name: /^Show Bass/ })
      .click();
    await mixer(app).getByRole("button", { name: "Visible: Drums" }).click();
    const saved = () =>
      app.evaluate(() =>
        [...window.__mixes.values()].map((m) => {
          const { visibleTracks, activeTrack } = m as unknown as {
            visibleTracks?: number[];
            activeTrack?: number;
          };
          return { visibleTracks, activeTrack };
        }),
      );
    await expect.poll(saved).toEqual([{ visibleTracks: [1, 2], activeTrack: 1 }]);

    const tabs = app.getByRole("navigation", { name: "Open songs" });
    await tabs.getByRole("button", { name: "Close Practice Song" }).click();
    await openSong(app);

    await expect(scoreRegion(app)).toHaveAccessibleName("Score: Bass");
    await expect(mixer(app).getByRole("button", { name: "Visible: Guitar" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // Reopening did not change what was saved (the first track was not added back).
    await app.waitForTimeout(1200);
    expect(await saved()).toEqual([{ visibleTracks: [1, 2], activeTrack: 1 }]);
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
