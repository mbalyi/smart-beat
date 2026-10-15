import {
  emitMenuAction,
  expect,
  expectNoA11yViolations,
  newSong,
  openSong,
  scoreRegion,
  tabKey,
  test,
  waitForAnimations,
} from "./fixtures";

import features from "../src/lib/features.json" with { type: "json" };

test.describe("accessibility", () => {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`welcome screen has no WCAG violations in ${colorScheme} mode`, async ({ app }) => {
      await app.emulateMedia({ colorScheme });
      const html = app.locator("html");
      if (colorScheme === "dark") await expect(html).toHaveClass(/dark/);
      else await expect(html).not.toHaveClass(/dark/);
      // Scan the settled colours, not a fade between the themes.
      await waitForAnimations(app);
      await expect(app.getByRole("contentinfo")).toContainText(/Version \d+\.\d+\.\d+/);
      await expect(app.getByText(/early preview/i)).toHaveCount(0);
      await expect(
        app.getByRole("contentinfo").getByRole("link", { name: "@mbalyi" }),
      ).toHaveAttribute("href", "https://github.com/mbalyi");

      await expectNoA11yViolations(app);
    });

    test(`song screen, inspector and mixer have no WCAG violations in ${colorScheme} mode`, async ({
      app,
    }) => {
      await app.emulateMedia({ colorScheme });
      await openSong(app);
      await expectNoA11yViolations(app);

      const mixer = app.getByRole("region", { name: "Tracks and mixer" });
      await expect(mixer).toBeVisible();
      // Pressed Mute (the piano, from the file) and Solo must stay readable too.
      await mixer.getByRole("button", { name: "Solo Guitar" }).click();
      await expectNoA11yViolations(app);

      // Both tabs of the inspector, and a track's menu.
      await app.getByRole("tab", { name: "Song" }).click();
      await expect(app.getByRole("button", { name: "Transpose…" })).toBeVisible();
      await expectNoA11yViolations(app);
      await app.getByRole("tab", { name: "Track" }).click();
      await mixer.getByRole("button", { name: "Actions for Bass" }).click();
      await expect(app.getByRole("menuitem", { name: "Duplicate" })).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role=menu]" });
    });

    test(`editing, practice and track screens have no WCAG violations in ${colorScheme} mode`, async ({
      app,
    }) => {
      // Many steps with a scan after each: give it more time on a busy machine.
      test.slow();
      await app.emulateMedia({ colorScheme });
      await newSong(app);
      await app.keyboard.press("3");
      await emitMenuAction(app, "toggle-fretboard");
      await app.getByRole("button", { name: "Loop" }).click();
      await expect(app.getByRole("region", { name: "Fretboard" })).toBeVisible();
      await expectNoA11yViolations(app);

      await expect(app.getByRole("toolbar", { name: "Edit" })).toBeVisible();
      await expectNoA11yViolations(app);

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

  for (const colorScheme of ["light", "dark"] as const) {
    test(`structure, effects, lyrics and chord screens have no WCAG violations in ${colorScheme} mode`, async ({
      app,
    }) => {
      // Many steps with a scan after each: give it more time on a busy machine.
      test.slow();
      await app.emulateMedia({ colorScheme });
      await newSong(app);
      await app.keyboard.press("5");
      await app.keyboard.press("p"); // palm mute: a pressed toggle in the effects toolbar
      await expect(app.getByRole("toolbar", { name: "Effects" })).toBeVisible();
      await expectNoA11yViolations(app);

      await app
        .getByRole("toolbar", { name: "Effects" })
        .getByRole("button", { name: "Slide" })
        .click();
      await expect(app.getByRole("menu")).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role='menu']" });
      await app.keyboard.press("Escape");

      for (const [action, name] of [
        ["bar-settings", "Bar 1"],
        ["bend", "Bend"],
        ["chord", "Chord"],
        ["text", "Text"],
        ["lyrics", "Lyrics: Guitar"],
      ] as const) {
        await emitMenuAction(app, action);
        const dialog = app.getByRole("dialog", { name });
        await expect(dialog).toBeVisible();
        await dialog.evaluate((el) =>
          Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
        );
        await expectNoA11yViolations(app);
        await app.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
      }

      // Lyrics strip and scale tool.
      await emitMenuAction(app, "lyrics");
      const lyrics = app.getByRole("dialog", { name: "Lyrics: Guitar" });
      await lyrics.getByRole("textbox", { name: "Line 1 text" }).fill("la la");
      await lyrics.getByRole("button", { name: "Apply" }).click();
      await emitMenuAction(app, "scale-tool");
      await app.getByRole("combobox", { name: "Scale" }).click();
      await app.getByRole("option", { name: "Blues" }).click();
      await expect(app.getByRole("region", { name: "Lyrics" })).toBeVisible();
      await expectNoA11yViolations(app);
    });
  }

  test("the bend editor can be used with the keyboard", async ({ app, browserName }) => {
    await newSong(app);
    await app.keyboard.press("7");
    await app.keyboard.press("Shift+B");
    const dialog = app.getByRole("dialog", { name: "Bend" });
    await expect(dialog).toBeVisible();
    const position = dialog.getByRole("spinbutton", { name: "Point 2 position" });
    await position.focus();
    await app.keyboard.press("Control+a");
    await app.keyboard.type("20");
    await app.keyboard.press(tabKey(browserName));
    await expect(dialog.getByRole("combobox", { name: "Point 2 pitch" })).toBeFocused();
    await app.keyboard.press("Enter");
    await app.getByRole("option", { name: "+1½ steps" }).press("Enter");
    await expect(dialog.getByRole("img", { name: /Curve:/ })).toHaveAccessibleName(
      "Curve: full step up",
    );
    await dialog.getByRole("button", { name: "Apply" }).press("Enter");
    await expect(dialog).toBeHidden();
    // Focus goes back to the score.
    await expect(scoreRegion(app)).toBeFocused();
  });

  test("the song screen can be used with the keyboard", async ({ app, browserName }) => {
    await openSong(app);
    const tab = tabKey(browserName);
    const mixerButton = app.getByRole("button", { name: "Mixer" });
    const mixer = app.getByRole("region", { name: "Tracks and mixer" });

    // The mixer toggle shows and hides the track list.
    await mixerButton.focus();
    await app.keyboard.press("Enter");
    await expect(mixer).toBeHidden();
    await app.keyboard.press("Enter");
    await expect(mixer).toBeVisible();

    // Sliders respond to the arrow keys.
    const master = mixer.getByRole("slider", { name: "Master volume" });
    await master.focus();
    await app.keyboard.press("ArrowLeft");
    await expect(master).toHaveAttribute("aria-valuetext", "99%");

    // The inspector's tabs are reached and switched with the keyboard.
    const songTab = app.getByRole("tab", { name: "Song" });
    await app.getByRole("tab", { name: "Track" }).focus();
    await app.keyboard.press("ArrowLeft");
    await expect(songTab).toBeFocused();
    await expect(songTab).toHaveAttribute("aria-selected", "true");

    // The score region is focusable so it can be scrolled with the keyboard.
    await app.getByRole("button", { name: "New song" }).focus(); // last control before the score
    await app.keyboard.press(tab);
    await expect(app.getByRole("region", { name: /^Score:/ })).toBeFocused();
  });

  test("about dialog with its contact links has no WCAG violations in dark mode", async ({
    app,
  }) => {
    await app.emulateMedia({ colorScheme: "dark" });
    await expect(app.locator("html")).toHaveClass(/dark/);
    await emitMenuAction(app, "about");
    const dialog = app.getByRole("dialog", { name: "Smart Beat" });
    await expect(dialog.getByRole("link", { name: "smart-beat@outlook.com" })).toBeVisible();

    await expectNoA11yViolations(app);
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
      "Smart Beat", // the logo: back to the start screen
      "Theme",
      "Help",
      "Open a file…",
      ...(features["audio-2-tab"] ? ["Import from Audio…"] : []),
      "New song",
      "Open the demo song",
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
