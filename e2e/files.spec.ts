import type { Page } from "@playwright/test";

import {
  emitMenuAction,
  expect,
  expectNoA11yViolations,
  expectTab,
  newSong,
  openSong,
  PRACTICE_SONG,
  scoreRegion,
  tabNumbers,
  test,
  waitForScore,
} from "./fixtures";

/** Saving, exporting, recent songs, transposing and fixing bar lengths (#14, #15, #16, #31). */

const STRUCTURE_SONG = "/Users/me/Music/structure-song.gp";

const written = (page: Page, path: string) =>
  page.evaluate((p) => window.__written.get(p)?.length ?? 0, path);

test.describe("recent songs (#31)", () => {
  test("lists the last songs on the welcome screen and opens one", async ({ app }) => {
    await app.evaluate(([a, b]) => window.__emitTauriEvent("recent-changed", [a, b]), [
      PRACTICE_SONG,
      STRUCTURE_SONG,
    ] as const);
    const section = app.getByRole("heading", { name: "Recent songs" });
    await expect(section).toBeVisible();
    await expectNoA11yViolations(app);

    await app.getByRole("button", { name: /structure-song\.gp/ }).click();
    await waitForScore(app);
    await expect(app.getByRole("heading", { level: 1, name: "Structure Song" })).toBeVisible();
    expect(await app.evaluate(() => window.__recent)).toEqual([STRUCTURE_SONG]);
  });

  test("remembers opened songs (at most ten) and opens one from File › Open Recent", async ({
    app,
  }) => {
    await openSong(app);
    await openSong(app, STRUCTURE_SONG);
    await expect
      .poll(() => app.evaluate(() => window.__recent))
      .toEqual([STRUCTURE_SONG, PRACTICE_SONG]);

    await app.evaluate((p) => window.__emitTauriEvent("open-recent", p), PRACTICE_SONG);
    await expect(app.getByRole("heading", { level: 1, name: "Practice Song" })).toBeVisible();
  });

  test("forgets a song that cannot be found any more", async ({ app }) => {
    const gone = "/Users/me/Music/gone.gp";
    await app.evaluate((p) => window.__emitTauriEvent("recent-changed", [p]), gone);
    await app.getByRole("button", { name: /gone\.gp/ }).click();
    await expect(app.getByText(/could not be found/).first()).toBeVisible();
    expect(await app.evaluate(() => window.__recent)).toEqual([]);
    await expect(app.getByRole("heading", { name: "Recent songs" })).toBeHidden();
  });
});

test.describe("saving and exporting (#15, #16)", () => {
  test("Save As writes a Guitar Pro file that opens as the same song", async ({ app }) => {
    await openSong(app);
    const before = await tabNumbers(app);
    await app.evaluate(() => (window.__saveResult = "/Users/me/Music/copy.gp"));

    await emitMenuAction(app, "save-as");

    await expect.poll(() => written(app, "/Users/me/Music/copy.gp")).toBeGreaterThan(500);
    await app.evaluate(() => (window.__dialogResult = "/Users/me/Music/copy.gp"));
    await emitMenuAction(app, "open");
    await waitForScore(app);
    await expect(app.getByRole("heading", { level: 1, name: "Practice Song" })).toBeVisible();
    expect(await tabNumbers(app)).toEqual(before);
  });

  test("an edited song is saved, loses its Edited mark and needs no discard question", async ({
    app,
  }) => {
    await openSong(app);
    await emitMenuAction(app, "toggle-edit-mode");
    await expect(scoreRegion(app)).toBeFocused();
    await app.keyboard.press("Delete");
    await expect(app.getByText("Edited")).toBeVisible();
    await app.evaluate(() => (window.__saveResult = "/Users/me/Music/edited.gp"));

    await emitMenuAction(app, "save");

    await expect(app.getByText("Edited")).toBeHidden();
    await emitMenuAction(app, "new-song");
    await expect(app.getByRole("heading", { level: 1, name: "Untitled" })).toBeVisible();
    await expect(app.getByRole("alertdialog")).toBeHidden();
  });

  test("Save replaces the opened .gp file without asking", async ({ app }) => {
    await openSong(app);
    await emitMenuAction(app, "save");
    await expect.poll(() => written(app, PRACTICE_SONG)).toBeGreaterThan(500);
  });

  test("saves Guitar Pro 5 and lists what the format cannot keep", async ({ app }) => {
    await openSong(app);
    await app.evaluate(() => (window.__saveResult = "/Users/me/Music/old.gp5"));
    await emitMenuAction(app, "save-as");
    await expect.poll(() => written(app, "/Users/me/Music/old.gp5")).toBeGreaterThan(500);
    await expect(app.getByText(/was saved with limits/).first()).toBeVisible();
    await expect(app.getByText(/Guitar Pro 5 has no keyboard staff/).first()).toBeVisible();

    await app.evaluate(() => (window.__dialogResult = "/Users/me/Music/old.gp5"));
    await emitMenuAction(app, "open");
    await waitForScore(app);
    await expect(app.getByRole("heading", { level: 1, name: "Practice Song" })).toBeVisible();
  });

  for (const [extension, product] of [
    ["gp4", "Guitar Pro 4"],
    ["gp3", "Guitar Pro 3"],
  ] as const) {
    test(`saves ${product}, lists what the format cannot keep and opens the file again`, async ({
      app,
    }) => {
      await openSong(app);
      const path = `/Users/me/Music/old.${extension}`;
      await app.evaluate((p) => (window.__saveResult = p), path);
      await emitMenuAction(app, "save-as");
      await expect.poll(() => written(app, path)).toBeGreaterThan(500);
      await expect(app.getByText(/was saved with limits/).first()).toBeVisible();
      await expect(
        app.getByText(new RegExp(`${product} has no keyboard staff`)).first(),
      ).toBeVisible();

      await app.evaluate((p) => (window.__dialogResult = p), path);
      await emitMenuAction(app, "open");
      await waitForScore(app);
      await expect(app.getByRole("heading", { level: 1, name: "Practice Song" })).toBeVisible();
      await app.getByRole("combobox", { name: "Track" }).click();
      await expect(app.getByRole("option")).toHaveCount(4);
      await app.keyboard.press("Escape");
    });
  }

  test("exports MusicXML, MIDI and ASCII tab, and opens the MIDI and MusicXML files again", async ({
    app,
  }) => {
    await openSong(app);
    for (const [action, path] of [
      ["export-musicxml", "/Users/me/Music/out.musicxml"],
      ["export-midi", "/Users/me/Music/out.mid"],
      ["export-ascii-tab", "/Users/me/Music/out.txt"],
    ] as const) {
      await app.evaluate((p) => (window.__saveResult = p), path);
      await emitMenuAction(app, action);
      await expect.poll(() => written(app, path)).toBeGreaterThan(100);
    }
    const text = await app.evaluate(() =>
      new TextDecoder().decode(window.__written.get("/Users/me/Music/out.txt")),
    );
    expect(text).toContain("Guitar (tuning E A D G B E)");

    await app.evaluate(() => (window.__dialogResult = "/Users/me/Music/out.mid"));
    await emitMenuAction(app, "open");
    await waitForScore(app);
    await expect(app.getByText("“out.mid” was converted").first()).toBeVisible();
    await app.getByRole("combobox", { name: "Track" }).click();
    await expect(app.getByRole("option")).toHaveCount(4);
    await app.keyboard.press("Escape");

    await app.evaluate(() => (window.__dialogResult = "/Users/me/Music/out.musicxml"));
    await emitMenuAction(app, "open");
    await waitForScore(app);
    await expect(app.getByRole("heading", { level: 1, name: "Practice Song" })).toBeVisible();
  });

  test("exports alphaTex and compressed MusicXML, and opens both files again", async ({ app }) => {
    await openSong(app);
    for (const [action, path] of [
      ["export-alphatex", "/Users/me/Music/out.atex"],
      ["export-musicxml", "/Users/me/Music/out.mxl"],
    ] as const) {
      await app.evaluate((p) => (window.__saveResult = p), path);
      await emitMenuAction(app, action);
      await expect.poll(() => written(app, path)).toBeGreaterThan(100);
    }
    // The .mxl name is kept, and the file is a ZIP archive.
    expect(await written(app, "/Users/me/Music/out.mxl.musicxml")).toBe(0);
    const zip = await app.evaluate(() =>
      Array.from(window.__written.get("/Users/me/Music/out.mxl")!.slice(0, 2)),
    );
    expect(zip).toEqual([0x50, 0x4b]);

    for (const path of ["/Users/me/Music/out.atex", "/Users/me/Music/out.mxl"]) {
      await app.evaluate((p) => (window.__dialogResult = p), path);
      await emitMenuAction(app, "open");
      await waitForScore(app);
      await expect(app.getByRole("heading", { level: 1, name: "Practice Song" })).toBeVisible();
      await app.getByRole("combobox", { name: "Track" }).click();
      await expect(app.getByRole("option")).toHaveCount(4);
      await app.keyboard.press("Escape");
    }
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the File and Tools menus have no WCAG violations in ${colorScheme} mode`, async ({
      app,
    }) => {
      await app.emulateMedia({ colorScheme });
      await openSong(app);
      await app.getByRole("button", { name: "File" }).click();
      await expect(app.getByRole("menuitem", { name: "Save As…" })).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role=menu]" });
      await app.keyboard.press("Escape");
      await app.getByRole("button", { name: "Tools" }).click();
      await expect(app.getByRole("menuitem", { name: "Transpose…" })).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role=menu]" });
    });
  }
});

test.describe("transpose (#14)", () => {
  test("moves the notes of the track and can be undone", async ({ app }) => {
    await newSong(app);
    await app.keyboard.press("5");
    await expectTab(app, ["5"]);

    await emitMenuAction(app, "transpose");
    const dialog = app.getByRole("dialog", { name: "Transpose" });
    await expect(dialog.getByRole("status")).toHaveText("1 note will move up 2 semitones.");
    await dialog.getByRole("button", { name: "Transpose" }).click();
    await expectTab(app, ["7"]);

    await emitMenuAction(app, "undo");
    await expectTab(app, ["5"]);
  });

  test("refuses moves that would fall off the instrument", async ({ app }) => {
    await newSong(app);
    for (let i = 0; i < 5; i++) await app.keyboard.press("ArrowDown"); // the low E string
    await app.keyboard.press("0");
    await expectTab(app, ["0"]);
    await emitMenuAction(app, "transpose");
    const dialog = app.getByRole("dialog", { name: "Transpose" });
    await dialog.getByRole("spinbutton").fill("-3");
    await expect(dialog.getByRole("status")).toContainText("does not fit on the instrument");
    await expect(dialog.getByRole("button", { name: "Transpose" })).toBeDisabled();
    await dialog.getByRole("spinbutton").fill("3");
    await expect(dialog.getByRole("button", { name: "Transpose" })).toBeEnabled();
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the transpose dialog has no WCAG violations in ${colorScheme} mode`, async ({ app }) => {
      await app.emulateMedia({ colorScheme });
      await newSong(app);
      await app.keyboard.press("5");
      await emitMenuAction(app, "transpose");
      await expect(app.getByRole("dialog", { name: "Transpose" })).toBeVisible();
      await expectNoA11yViolations(app);
    });
  }
});

test.describe("bar durations (#14)", () => {
  test("warns about a bar that is too long, frames it and fixes it", async ({ app }) => {
    await newSong(app);
    await app.getByRole("button", { name: "Insert beat" }).click();
    const banner = app.getByRole("status", { name: "Bar lengths" });
    await expect(banner).toContainText("Bar 1 is 4 beats too long");
    await expect(app.getByTestId("bar-problem")).toHaveCount(1);
    await expectNoA11yViolations(app);

    await banner.getByRole("button", { name: "Fix bar" }).click();
    await expect(banner).toBeHidden();
    await expect(app.getByTestId("bar-problem")).toHaveCount(0);
  });

  test("fills a bar that is too short with rests, from the Tools menu", async ({ app }) => {
    await newSong(app);
    await app.keyboard.press("5");
    await app.getByRole("radio", { name: "Eighth" }).click();
    const banner = app.getByRole("status", { name: "Bar lengths" });
    await expect(banner).toContainText("Bar 1 is 3.5 beats too short");

    await app.getByRole("button", { name: "Tools" }).click();
    await app.getByRole("menuitem", { name: "Fix bar durations…" }).click();
    await expect(banner).toBeHidden();
    await expectTab(app, ["5"]);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the bar length warning has no WCAG violations in ${colorScheme} mode`, async ({
      app,
    }) => {
      await app.emulateMedia({ colorScheme });
      await newSong(app);
      await app.getByRole("button", { name: "Insert beat" }).click();
      await expect(app.getByRole("status", { name: "Bar lengths" })).toBeVisible();
      await expectNoA11yViolations(app);
    });
  }
});
