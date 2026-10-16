import { emitMenuAction, expect, newSong, openSong, test } from "./fixtures";

const VIEWPORTS = [
  { name: "narrow window", width: 375, height: 700, columns: 1 },
  { name: "medium window", width: 768, height: 800, columns: 2 },
  { name: "wide window", width: 1280, height: 800, columns: 4 },
] as const;

/** Song screen at every size, down to the app's minimum window (480×360). */
for (const { width, height } of [...VIEWPORTS, { width: 480, height: 360 }]) {
  test.describe(`song screen at ${width}×${height}`, () => {
    test.use({ viewport: { width, height } });

    test("keeps the controls and the score on screen without page scrolling", async ({ app }) => {
      await openSong(app);

      const overflow = await app.evaluate(() => ({
        x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      }));
      expect(overflow.x).toBeLessThanOrEqual(0);
      expect(overflow.y).toBeLessThanOrEqual(0); // the score scrolls inside its region
      for (const name of ["Play", "Stop"]) {
        await expect(app.getByRole("button", { name })).toBeInViewport();
      }
      const region = await app.getByRole("region", { name: /^Score:/ }).boundingBox();
      expect(region!.height).toBeGreaterThan(40);
    });

    test("fits edit mode, the fretboard and the practice tools without page scrolling", async ({
      app,
    }) => {
      await newSong(app);
      await emitMenuAction(app, "toggle-fretboard");
      await emitMenuAction(app, "toggle-loop");
      await expect(app.getByRole("region", { name: "Fretboard" })).toBeVisible();

      const overflow = await app.evaluate(() => ({
        x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      }));
      expect(overflow.x).toBeLessThanOrEqual(0); // the fretboard scrolls inside its panel
      expect(overflow.y).toBeLessThanOrEqual(0);
      for (const name of ["Play", "Edit"]) {
        await expect(app.getByRole("button", { name, exact: true })).toBeInViewport();
      }
    });

    test("fits the tracks panel and track dialog inside the window", async ({ app }) => {
      await openSong(app);
      await emitMenuAction(app, "track-settings");
      const dialog = app.getByRole("dialog", { name: "Track settings" });
      await expect(dialog).toBeVisible();
      await expect
        .poll(async () => {
          const box = (await dialog.boundingBox())!;
          return box.x >= 0 && box.x + box.width <= width && box.y + box.height <= height;
        })
        .toBe(true);
    });

    test("fits the recent songs, the bar length warning and the File and Tools menus", async ({
      app,
    }) => {
      const overflowX = () =>
        app.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
      await app.evaluate(() =>
        window.__emitTauriEvent("recent-changed", [
          "/Users/me/Music/a-rather-long-song-name-that-keeps-going-and-going.gp5",
          "/Users/me/Music/another-song.gp",
        ]),
      );
      await expect(app.getByRole("heading", { name: "Recent songs" })).toBeVisible();
      expect(await overflowX()).toBeLessThanOrEqual(0);

      await newSong(app);
      await app.getByRole("button", { name: "Insert beat" }).click();
      const banner = app.getByRole("status", { name: "Bar lengths" });
      await expect(banner).toBeVisible();
      expect(await overflowX()).toBeLessThanOrEqual(0);
      await banner.scrollIntoViewIfNeeded(); // a short window scrolls as a whole
      await expect(banner.getByRole("button", { name: "Fix bar" })).toBeInViewport();

      for (const [button, item] of [
        ["File", "Save As…"],
        ["Tools", "Transpose…"],
      ] as const) {
        await app.getByRole("button", { name: button, exact: true }).click();
        await expect(app.getByRole("menuitem", { name: item })).toBeInViewport();
        await app.keyboard.press("Escape");
      }
    });

    test("fits the effects toolbar, lyrics strip and new dialogs inside the window", async ({
      app,
    }) => {
      await newSong(app);
      await app.keyboard.press("5");
      await emitMenuAction(app, "lyrics");
      const lyrics = app.getByRole("dialog", { name: "Lyrics: Guitar" });
      await lyrics.getByRole("textbox", { name: "Line 1 text" }).fill("la");
      await lyrics.getByRole("button", { name: "Apply" }).click();
      await expect(app.getByRole("toolbar", { name: "Effects" })).toBeVisible();
      await expect(app.getByRole("region", { name: "Lyrics" })).toBeVisible();

      const overflow = await app.evaluate(() => ({
        x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      }));
      expect(overflow.x).toBeLessThanOrEqual(0); // the toolbar scrolls sideways inside itself
      expect(overflow.y).toBeLessThanOrEqual(0);
      await expect(app.getByRole("button", { name: "Play" })).toBeInViewport();

      for (const [action, name] of [
        ["bar-settings", "Bar 1"],
        ["bend", "Bend"],
        ["chord", "Chord"],
        ["transpose", "Transpose"],
      ] as const) {
        await emitMenuAction(app, action);
        const dialog = app.getByRole("dialog", { name });
        await expect(dialog).toBeVisible();
        await expect
          .poll(async () => {
            const box = (await dialog.boundingBox())!;
            return box.x >= 0 && box.x + box.width <= width && box.y + box.height <= height;
          })
          .toBe(true);
        await app.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
      }
    });

    test("fits the track list and the inspector inside the window", async ({ app }) => {
      await openSong(app);

      const tracks = app.getByRole("region", { name: "Tracks and mixer" });
      await expect(tracks).toBeVisible();
      const box = (await tracks.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(Math.round(box.x + box.width)).toBeLessThanOrEqual(width);

      // Narrow windows start without the inspector; it then covers the score.
      const inspector = app.getByRole("complementary", { name: "Inspector" });
      if (!(await inspector.isVisible()))
        await app.getByRole("button", { name: "Inspector" }).click();
      await expect(inspector).toBeVisible();
      const inspectorBox = (await inspector.boundingBox())!;
      expect(inspectorBox.x).toBeGreaterThanOrEqual(0);
      expect(Math.round(inspectorBox.x + inspectorBox.width)).toBeLessThanOrEqual(width);
    });
  });
}

for (const { name, width, height, columns } of VIEWPORTS) {
  test.describe(`${name} (${width}px)`, () => {
    test.use({ viewport: { width, height } });

    test("has no horizontal scrolling", async ({ app }) => {
      const overflow = await app.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });

    test(`lays out feature cards in ${columns} column(s)`, async ({ app }) => {
      // The features list (not the lists inside a card).
      const cards = app
        .getByRole("region", { name: "Features" })
        .getByRole("list")
        .first()
        .locator("> li");
      await expect(cards).toHaveCount(7); // every feature of the start page

      const tops = await cards.evaluateAll((items) =>
        items.map((item) => Math.round(item.getBoundingClientRect().top)),
      );
      const firstRow = tops.filter((top) => top === tops[0]).length;
      expect(firstRow).toBe(columns);
    });

    test("keeps header controls reachable", async ({ app }) => {
      await expect(app.getByRole("button", { name: "Theme" })).toBeInViewport();
      await expect(app.getByRole("button", { name: "Help" })).toBeInViewport();
    });

    test("fits dialogs inside the window", async ({ app }) => {
      await emitMenuAction(app, "shortcuts");
      const dialog = app.getByRole("dialog");
      await expect(dialog).toBeVisible();

      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(height);
    });
  });
}

/** Below 1024 px the palette and the inspector must not cover the score (#49). */
test.describe("narrow window (800px)", () => {
  test("puts the palette above the score while editing", async ({ app }) => {
    await app.setViewportSize({ width: 800, height: 900 });
    await openSong(app);
    await app.getByRole("button", { name: "Edit" }).click();
    const palette = (await app.getByRole("complementary", { name: "Note palette" }).boundingBox())!;
    const score = (await app.getByRole("region", { name: /^Score:/ }).boundingBox())!;
    expect(palette.y + palette.height).toBeLessThanOrEqual(score.y + 1);
    expect(score.height).toBeGreaterThan(100);
    // No sideways scrolling inside the palette.
    const overflow = await app
      .getByRole("complementary", { name: "Note palette" })
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("closes the inspector when the window gets narrow, and it can be closed there", async ({
    app,
  }) => {
    await app.setViewportSize({ width: 1280, height: 800 });
    await openSong(app);
    const inspector = app.getByRole("complementary", { name: "Inspector" });
    await expect(inspector).toBeVisible();
    await app.setViewportSize({ width: 800, height: 800 });
    await expect(inspector).toHaveCount(0);
    await app.getByRole("button", { name: "Inspector", exact: true }).click();
    await expect(inspector).toBeVisible();
    await inspector.getByRole("button", { name: "Close inspector" }).click();
    await expect(inspector).toHaveCount(0);
  });
});

/** The update dialog (#82) fits the smallest window the app allows, with long release notes. */
test.describe("update dialog at the minimum window (480×360)", () => {
  test.use({ viewport: { width: 480, height: 360 } });

  test("keeps its buttons on screen and scrolls the notes inside", async ({ app }) => {
    await app.evaluate(() => {
      window.__update = { version: "0.2.0", body: "- A change in the new version.\n".repeat(60) };
    });
    await emitMenuAction(app, "check-for-updates");

    const dialog = app.getByRole("dialog", { name: "Update available" });
    await expect(dialog).toBeVisible();
    for (const name of ["Later", "Download & Install"]) {
      await expect(dialog.getByRole("button", { name })).toBeInViewport();
    }
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(480);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(360);
    const overflow = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test("practice monitor controls stay reachable in a short and narrow popup", async ({ app }) => {
  await app.setViewportSize({ width: 1280, height: 800 });
  await openSong(app);
  await app.getByRole("button", { name: /^Practice mix/ }).click();
  const popup = app.getByRole("dialog", { name: "Practice mix" });
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 480, height: 360 },
    { width: 768, height: 800 },
  ]) {
    await app.setViewportSize(viewport);
    const monitor = popup.getByRole("switch", { name: "Monitor my input" });
    await monitor.scrollIntoViewIfNeeded();
    await expect(monitor).toBeInViewport();
    const settings = popup.getByRole("button", { name: "Input settings…" });
    await settings.scrollIntoViewIfNeeded();
    await expect(settings).toBeInViewport();
    const box = await popup.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  }
});
