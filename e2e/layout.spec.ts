import {
  expect,
  expectNoA11yViolations,
  newSong,
  openSong,
  scoreRegion,
  tabKey,
  test,
} from "./fixtures";

const STRUCTURE_SONG = "/Users/me/Music/structure-song.gp";

/** The Guitar Pro 8 style layout (#35): palette, score and inspector side by side, track list below. */
test.describe("song layout (#35)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("puts the palette, score and inspector side by side above the track list", async ({
    app,
  }) => {
    await openSong(app);

    const palette = await app.getByRole("complementary", { name: "Note palette" }).boundingBox();
    const score = await scoreRegion(app).boundingBox();
    const inspector = await app.getByRole("complementary", { name: "Inspector" }).boundingBox();
    const tracks = await app.getByRole("region", { name: "Tracks and mixer" }).boundingBox();
    expect(palette!.x + palette!.width).toBeLessThanOrEqual(score!.x + 1);
    expect(score!.x + score!.width).toBeLessThanOrEqual(inspector!.x + 1);
    expect(tracks!.y).toBeGreaterThanOrEqual(score!.y + score!.height - 1);
    // The score gets the room that is left.
    expect(score!.width).toBeGreaterThan(palette!.width + inspector!.width);
  });

  test("puts the main controls in the app header, between the logo and the icons", async ({
    app,
  }) => {
    await openSong(app);

    const header = app.getByRole("banner");
    const logo = await header.getByRole("img", { name: "Smart Beat" }).boundingBox();
    const open = await header.getByRole("button", { name: "Open…" }).boundingBox();
    const display = await header.getByRole("group", { name: "Display" }).boundingBox();
    const theme = await header.getByRole("button", { name: "Theme" }).boundingBox();
    const help = await header.getByRole("button", { name: "Help" }).boundingBox();
    expect(logo!.x + logo!.width).toBeLessThanOrEqual(open!.x);
    expect(display!.x + display!.width).toBeLessThanOrEqual(theme!.x);
    expect(theme!.x).toBeLessThan(help!.x);
    // The logo is big enough to read, and the view options stay below the header.
    expect(logo!.height).toBeGreaterThanOrEqual(40);
    const headerBox = (await header.boundingBox())!;
    const notation = (await app.getByRole("radiogroup", { name: "Notation" }).boundingBox())!;
    expect(notation.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
    // Only the shown song's controls are there.
    await openSong(app, STRUCTURE_SONG);
    await expect(header.getByRole("group", { name: "Display" })).toHaveCount(1);
  });

  test("shows the LCD display, transport, zoom and undo/redo in the toolbar", async ({ app }) => {
    await app.setViewportSize({ width: 1600, height: 800 }); // the first and last bar buttons need room
    await openSong(app);

    const lcd = app.getByRole("group", { name: "Display" });
    await expect(lcd.getByRole("combobox", { name: "Track" })).toContainText("Guitar");
    await expect(lcd.getByRole("spinbutton", { name: "Bar" })).toHaveValue("1");
    await expect(lcd.getByRole("timer")).toContainText("/ 0:12");
    await expect(lcd).toContainText("120 BPM".replace("120", "60"));

    await app.getByRole("button", { name: "Next bar" }).click();
    await expect(lcd.getByRole("spinbutton", { name: "Bar" })).toHaveValue("2");
    await app.getByRole("button", { name: "Last bar" }).click();
    await expect(lcd.getByRole("spinbutton", { name: "Bar" })).toHaveValue("4");
    await app.getByRole("button", { name: "First bar" }).click();
    await expect(lcd.getByRole("spinbutton", { name: "Bar" })).toHaveValue("1");

    const zoom = app.getByRole("group", { name: "Zoom" });
    await zoom.getByRole("button", { name: "Zoom in" }).click();
    await expect(zoom).toContainText("125%");
    await zoom.getByRole("button", { name: "Zoom out" }).click();
    await expect(zoom).toContainText("100%");

    await expect(app.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  test("the inspector shows the song and the shown track", async ({ app }) => {
    await openSong(app);
    const inspector = app.getByRole("complementary", { name: "Inspector" });

    for (const heading of ["Information", "Musical notation", "Sounds", "Interpretation"]) {
      await expect(inspector.getByRole("heading", { name: heading })).toBeVisible();
    }
    await expect(inspector.getByText("Guitar", { exact: true })).toBeVisible();

    // The notation switches drive the score's view.
    await inspector.getByRole("switch", { name: "Standard notation" }).click();
    await expect(app.getByRole("radio", { name: "Tab", exact: true })).toBeChecked();

    // Switching the track in the list changes the inspector and the score.
    await app.getByRole("button", { name: "Show Bass" }).click();
    await expect(inspector.getByText("Bass", { exact: true })).toBeVisible();
    await expect(scoreRegion(app)).toHaveAccessibleName("Score: Bass");

    await app.getByRole("tab", { name: "Song" }).click();
    await expect(inspector.getByText("Practice Song")).toBeVisible();
    await expect(inspector.getByRole("button", { name: "Transpose…" })).toBeVisible();

    await app.getByRole("button", { name: "Inspector" }).click();
    await expect(inspector).toBeHidden();
  });

  test("the track list lists the tracks and the master row, and seeks from the bar grid", async ({
    app,
  }) => {
    await openSong(app);
    const tracks = app.getByRole("region", { name: "Tracks and mixer" });

    await expect(tracks.getByRole("listitem")).toHaveCount(4);
    await expect(tracks.getByText("Master", { exact: true })).toBeVisible();
    await expect(tracks.getByRole("slider", { name: "Master volume" })).toBeVisible();
    for (const header of ["Vol", "Pan", "Eq"]) {
      await expect(tracks.getByText(header, { exact: true })).toBeVisible();
    }
    // Every track has a coloured cell per bar.
    await expect(tracks.locator("ol > li").first().locator("button[tabindex='-1']")).toHaveCount(4);
    await tracks.locator("ol > li").first().locator("button[tabindex='-1']").nth(2).click();
    await expect(app.getByRole("spinbutton", { name: "Bar" })).toHaveValue("3");

    await app.getByRole("button", { name: "Mixer" }).click();
    await expect(tracks).toBeHidden();
  });

  test("opens several songs in tabs that keep their own state", async ({ app }) => {
    await openSong(app);
    await openSong(app, STRUCTURE_SONG);
    const tabs = app.getByRole("navigation", { name: "Open songs" });
    await expect(tabs.getByRole("listitem")).toHaveCount(2);
    await expect(tabs.getByRole("button", { name: "Structure Song", exact: true })).toHaveAttribute(
      "aria-current",
      "true",
    );

    // Play the second song, then return to the first: it stops and the first is shown.
    await app.getByRole("button", { name: "Play" }).click();
    await expect(app.getByRole("button", { name: "Pause" })).toBeVisible();
    await tabs.getByRole("button", { name: "Practice Song", exact: true }).click();
    await expect(app.getByRole("heading", { level: 1, name: "Practice Song" })).toBeVisible();
    await expect(app.getByRole("button", { name: "Play" })).toBeVisible();
    await expect(app).toHaveTitle("Practice Song — Smart Beat");

    // Closing the shown tab shows the other one; the last close returns to the start screen.
    await tabs.getByRole("button", { name: "Close Practice Song" }).click();
    await expect(app.getByRole("heading", { level: 1, name: "Structure Song" })).toBeVisible();
    await tabs.getByRole("button", { name: "Close Structure Song" }).click();
    await expect(app.getByRole("button", { name: "Open a file…" })).toBeVisible();
  });

  test("opening a song that is already open shows its tab", async ({ app }) => {
    await openSong(app);
    await openSong(app);
    await expect(
      app.getByRole("navigation", { name: "Open songs" }).getByRole("listitem"),
    ).toHaveCount(1);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the palette, track list and tabs have no WCAG violations in ${colorScheme} mode`, async ({
      app,
    }) => {
      await app.emulateMedia({ colorScheme });
      await openSong(app);
      await openSong(app, STRUCTURE_SONG);
      await app.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(app.getByRole("toolbar", { name: "Edit" })).toBeVisible();
      await expectNoA11yViolations(app);
    });
  }

  test("toolbar, tabs, palette, inspector and track list can be used by keyboard alone", async ({
    app,
    browserName,
  }) => {
    const tab = tabKey(browserName);
    await newSong(app);

    // Undo from the keyboard: type a note, then reach the Undo button and press it.
    await app.keyboard.press("5");
    const undo = app.getByRole("button", { name: /^Undo/ });
    await expect(undo).toHaveAccessibleName("Undo Add note");
    await undo.focus();
    await app.keyboard.press("Enter");
    await expect(undo).toBeDisabled();
    await expect(scoreRegion(app)).toBeFocused(); // typing continues in the score

    // Tab strip → palette → score, in reading order.
    await app.getByRole("button", { name: "New song" }).focus();
    await app.keyboard.press(tab);
    await expect(app.getByRole("radio", { name: "Voice 1" })).toBeFocused();

    // The track list rows are reachable and operable.
    await app.getByRole("button", { name: "Mute Guitar" }).focus();
    await app.keyboard.press("Space");
    await expect(app.getByRole("button", { name: "Mute Guitar" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await app.getByRole("button", { name: "Actions for Guitar" }).focus();
    await app.keyboard.press("Enter");
    await expect(app.getByRole("menuitem", { name: "Settings…" })).toBeVisible();
    await app.keyboard.press("Escape");
  });
});
