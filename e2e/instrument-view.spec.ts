import {
  editorStatus,
  emitMenuAction,
  expect,
  expectTab,
  newSong,
  openSong,
  scoreRegion,
  test,
} from "./fixtures";

/** The fretboard, piano keyboard and drum pads (#8) with real playback. */

test.describe("fretboard and keyboard (#8)", () => {
  test("shows the notes being played on the fretboard", async ({ app }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Fretboard" }).click();
    const fretboard = app.getByRole("region", { name: "Fretboard" });
    await expect(fretboard).toContainText("Guitar Standard Tuning: E B G D A E");
    const board = fretboard.getByRole("img");
    await expect(board).toHaveAccessibleName("Fretboard. No notes");

    await app.getByRole("button", { name: "Play" }).click();
    // Bar 1 of the guitar: frets 0, 2, 3, 0 on the low E string.
    await expect(board).toHaveAccessibleName(/string 6 fret [023] \((E|F sharp|G)2\)/, {
      timeout: 10_000,
    });
    await app.getByRole("button", { name: "Stop" }).click();
    await expect(board).toHaveAccessibleName("Fretboard. No notes");
  });

  test("follows the tuning and capo of the track", async ({ app }) => {
    await openSong(app);
    await emitMenuAction(app, "toggle-fretboard");
    await app.getByRole("combobox", { name: "Track" }).click();
    await app.getByRole("option", { name: "Bass" }).click();

    const fretboard = app.getByRole("region", { name: "Fretboard" });
    await expect(fretboard).toContainText("Bass Standard Tuning: G D A E");

    await emitMenuAction(app, "track-settings");
    const dialog = app.getByRole("dialog", { name: "Track settings" });
    await dialog.getByRole("spinbutton", { name: "Capo" }).fill("3");
    await dialog.getByRole("button", { name: "Apply" }).click();
    await expect(fretboard).toContainText("Capo 3");
  });

  test("enters notes by clicking frets while editing", async ({ app }) => {
    await newSong(app);
    await emitMenuAction(app, "toggle-fretboard");

    const board = app.getByRole("group", { name: /^Fretboard/ });
    await board
      .getByRole("group", { name: "String 3 (G3)" })
      .getByRole("button", { name: "Fret 2, A3" })
      .click();

    await expectTab(app, ["2"]);
    expect(await editorStatus(app)).toMatch(/string 3 \(G\), fret 2/);
    await expect(
      board
        .getByRole("group", { name: "String 3 (G3)" })
        .getByRole("button", { name: "Fret 2, A3" }),
    ).toHaveAttribute("aria-pressed", "true");

    // The fretboard can be played with the keyboard too.
    await app.keyboard.press("ArrowRight");
    await app.keyboard.press("ArrowRight");
    await app.keyboard.press("Enter");
    await expectTab(app, ["4"]);
  });

  test("uses a piano keyboard for staff-only tracks", async ({ app }) => {
    await openSong(app);
    await app.getByRole("combobox", { name: "Track" }).click();
    await app.getByRole("option", { name: "Piano" }).click();
    await app.getByRole("button", { name: "Keyboard" }).click();

    const keyboard = app.getByRole("region", { name: "Keyboard" }).getByRole("img");
    await app.getByRole("button", { name: "Play" }).click();
    // Bar 1 of the piano: a C major chord.
    await expect(keyboard).toHaveAccessibleName("Piano keyboard. C4, E4, G4", {
      timeout: 10_000,
    });
    await app.getByRole("button", { name: "Pause" }).click();

    await app.getByRole("button", { name: "Edit" }).click();
    await expect(scoreRegion(app)).toBeFocused();
    await app.getByRole("button", { name: "A4", exact: true }).click();
    await expect.poll(() => editorStatus(app)).toMatch(/A4/);
  });

  test("uses drum pads for drum tracks", async ({ app }) => {
    await openSong(app);
    await app.getByRole("combobox", { name: "Track" }).click();
    await app.getByRole("option", { name: "Drums" }).click();
    await app.getByRole("button", { name: "Drum pads" }).click();
    await app.getByRole("button", { name: "Edit" }).click();

    const pads = app.getByRole("group", { name: /^Drum pads/ });
    const crash = pads.getByRole("button", { name: "Crash cymbal", exact: true });
    await crash.click();

    await expect.poll(() => editorStatus(app)).toMatch(/Crash cymbal/);
    await expect(crash).toHaveAttribute("aria-pressed", "true");
  });
});
