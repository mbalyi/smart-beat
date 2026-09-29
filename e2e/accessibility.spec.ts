import {
  emitMenuAction,
  expect,
  expectNoA11yViolations,
  newSong,
  openSong,
  scoreRegion,
  tabKey,
  test,
} from "./fixtures";

test.describe("accessibility", () => {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`welcome screen has no WCAG violations in ${colorScheme} mode`, async ({ app }) => {
      await app.emulateMedia({ colorScheme });
      const html = app.locator("html");
      if (colorScheme === "dark") await expect(html).toHaveClass(/dark/);
      else await expect(html).not.toHaveClass(/dark/);

      await expectNoA11yViolations(app);
    });

    test(`song screen and mixer have no WCAG violations in ${colorScheme} mode`, async ({
      app,
    }) => {
      await app.emulateMedia({ colorScheme });
      await openSong(app);
      await expectNoA11yViolations(app);

      await app.getByRole("button", { name: "Mixer" }).click();
      const mixer = app.getByRole("dialog", { name: "Mixer" });
      await expect(mixer).toBeVisible();
      // Contrast is only meaningful once the panel has finished fading in.
      // Pressed Mute (the piano, from the file) and Solo must stay readable too.
      await mixer.getByRole("button", { name: "Solo Guitar" }).click();
      await mixer.evaluate((el) =>
        Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
      );
      await expectNoA11yViolations(app);
    });

    test(`editing, practice and track screens have no WCAG violations in ${colorScheme} mode`, async ({
      app,
    }) => {
      await app.emulateMedia({ colorScheme });
      await newSong(app);
      await app.keyboard.press("3");
      await emitMenuAction(app, "toggle-fretboard");
      await app.getByRole("button", { name: "Loop" }).click();
      await expect(app.getByRole("region", { name: "Fretboard" })).toBeVisible();
      await expectNoA11yViolations(app);

      await app.getByRole("button", { name: "Tracks" }).click();
      await expect(app.getByRole("dialog", { name: "Tracks" })).toBeVisible();
      await expectNoA11yViolations(app);
      await app.keyboard.press("Escape");

      await emitMenuAction(app, "add-track");
      const dialog = app.getByRole("dialog", { name: "Add track" });
      await dialog.getByRole("combobox", { name: "Instrument" }).click();
      await app.getByRole("option", { name: "Drums" }).click();
      await expect(dialog.getByRole("table")).toBeVisible();
      await expectNoA11yViolations(app);
      await dialog.getByRole("button", { name: "Add track" }).click();

      await expect(app.getByRole("region", { name: "Drum pads" })).toBeVisible();
      await expectNoA11yViolations(app);

      await emitMenuAction(app, "speed-trainer");
      await expect(app.getByRole("dialog", { name: "Speed Trainer" })).toBeVisible();
      await expectNoA11yViolations(app);
    });
  }

  test("the song screen can be used with the keyboard", async ({ app, browserName }) => {
    await openSong(app);
    const tab = tabKey(browserName);
    const mixerButton = app.getByRole("button", { name: "Mixer" });

    await mixerButton.focus();
    await app.keyboard.press("Enter");
    const mixer = app.getByRole("dialog", { name: "Mixer" });
    await expect(mixer).toBeVisible();
    await expect(mixer.locator(":focus")).toHaveCount(1); // focus moved into the panel

    // Sliders respond to the arrow keys.
    const master = mixer.getByRole("slider", { name: "Master volume" });
    await master.focus();
    await app.keyboard.press("ArrowLeft");
    await expect(master).toHaveAttribute("aria-valuetext", "99%");

    await app.keyboard.press("Escape");
    await expect(mixer).toBeHidden();
    await expect(mixerButton).toBeFocused();

    // The score region is focusable so it can be scrolled with the keyboard.
    await app.getByRole("button", { name: "Fretboard" }).focus(); // last toolbar control
    await app.keyboard.press(tab);
    await expect(app.getByRole("region", { name: /^Score:/ })).toBeFocused();
  });

  for (const action of ["about", "shortcuts", "licenses"] as const) {
    test(`${action} dialog has no WCAG violations`, async ({ app }) => {
      await emitMenuAction(app, action);
      const dialog = app.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("status")).toHaveCount(0); // finished loading

      await expectNoA11yViolations(app);
    });
  }

  test("keyboard users can skip to the main content", async ({ app, browserName }) => {
    const tab = tabKey(browserName);
    await app.keyboard.press(tab);
    const skip = app.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();

    await app.keyboard.press("Enter");

    await expect(app.getByRole("main")).toBeFocused();
    await app.keyboard.press(tab);
    await expect(app.getByRole("button", { name: "Open a file…" })).toBeFocused();
  });

  test("tab order follows the visual order", async ({ app, browserName }) => {
    const expected = [
      "Skip to main content",
      "Theme",
      "Help",
      "Open a file…",
      "New song",
      "Keyboard shortcuts",
    ];
    const focused: string[] = [];
    for (let i = 0; i < expected.length; i++) {
      await app.keyboard.press(tabKey(browserName));
      focused.push(
        await app.evaluate(
          () =>
            document.activeElement?.getAttribute("aria-label") ??
            document.activeElement?.textContent?.trim() ??
            "",
        ),
      );
    }
    expect(focused).toEqual(expected);
  });

  test("the editor and the fretboard can be used with the keyboard alone", async ({
    app,
    browserName,
  }) => {
    await openSong(app);
    const edit = app.getByRole("button", { name: "Edit" });
    await edit.focus();
    await app.keyboard.press("Enter");
    await expect(scoreRegion(app)).toBeFocused();
    await expect(scoreRegion(app)).toHaveAttribute("aria-roledescription", "score editor");
    await app.keyboard.press("9");
    await expect(app.getByRole("status").filter({ hasText: "Fret 9" })).toHaveCount(1);

    // Toolbar buttons are reachable with Tab, and the fretboard is one tab stop.
    await emitMenuAction(app, "toggle-fretboard");
    const fretboard = app.getByRole("group", { name: /^Fretboard/ });
    await fretboard.getByRole("button").and(app.locator("[tabindex='0']")).focus();
    await app.keyboard.press("ArrowRight");
    await expect(fretboard.locator(":focus")).toHaveCount(1);
    await app.keyboard.press(tabKey(browserName));
    await expect(fretboard.locator(":focus")).toHaveCount(0);
  });

  test("dialogs trap focus and return it on close", async ({ app }) => {
    const help = app.getByRole("button", { name: "Help" });
    await help.click();
    await app.getByRole("menuitem", { name: "About Smart Beat" }).click();
    const dialog = app.getByRole("dialog", { name: "Smart Beat" });
    await expect(dialog).toBeVisible();

    for (let i = 0; i < 4; i++) {
      await app.keyboard.press("Tab");
      await expect(dialog.locator(":focus")).toHaveCount(1);
    }

    await app.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(help).toBeFocused();
  });

  test("respects reduced motion", async ({ app }) => {
    await app.emulateMedia({ reducedMotion: "reduce" });
    await emitMenuAction(app, "about");

    const duration = await app
      .getByRole("dialog")
      .evaluate((el) => getComputedStyle(el).animationDuration);
    expect(parseFloat(duration)).toBeLessThan(0.01);
  });
});
