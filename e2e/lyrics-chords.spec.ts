import {
  emitMenuAction,
  expect,
  newSong,
  openSong,
  scoreRegion,
  scoreText,
  test,
} from "./fixtures";

/**
 * Lyrics, text, chords and the scale tool (#13) with the real alphaTab
 * renderer and player.
 */

const STRUCTURE_SONG = "/Users/me/Music/structure-song.gp";

test.describe("lyrics, text, chords and scales (#13)", () => {
  test("writes lyrics that are drawn under the notes and shown in the lyrics strip", async ({
    app,
  }) => {
    await newSong(app);
    for (const fret of ["3", "5", "7"]) {
      await app.keyboard.type(fret);
      await app.keyboard.press("ArrowRight");
    }
    await emitMenuAction(app, "lyrics");
    const dialog = app.getByRole("dialog", { name: "Lyrics: Guitar" });
    await dialog.getByRole("textbox", { name: "Line 1 text" }).fill("Sun-ny day");
    await expect(dialog.getByText("3 syllables")).toBeVisible();
    await dialog.getByRole("button", { name: "Apply" }).click();

    await expect.poll(() => scoreText(app)).toContain("Sun-");
    await expect.poll(() => scoreText(app)).toContain("day");
    const strip = app.getByRole("region", { name: "Lyrics" });
    await expect(strip).toContainText("Sun-ny day");
    await app.keyboard.press("ArrowLeft"); // the third note: "day"
    await expect(strip.locator("[aria-current='true']")).toHaveText("day");
  });

  test("highlights the syllable being sung during playback", async ({ app }) => {
    await openSong(app, STRUCTURE_SONG);
    const strip = app.getByRole("region", { name: "Lyrics" });
    await expect(strip).toContainText("Ev-ery bar we sing");
    await app.getByRole("button", { name: "Play" }).click();
    await expect(strip.locator("[aria-current='true']")).toHaveText(/ery|bar|we|sing/, {
      timeout: 10_000,
    });
    await app.getByRole("button", { name: "Pause" }).click();
  });

  test("writes text and a chord with its diagram", async ({ app }) => {
    await newSong(app);
    // An E minor chord: open, 2, 2, open, open, open.
    for (const [key, fret] of [
      ["", "0"],
      ["ArrowDown", "0"],
      ["ArrowDown", "0"],
      ["ArrowDown", "2"],
      ["ArrowDown", "2"],
      ["ArrowDown", "0"],
    ] as const) {
      if (key) await app.keyboard.press(key);
      await app.keyboard.type(fret);
    }
    await emitMenuAction(app, "chord");
    const chord = app.getByRole("dialog", { name: "Chord" });
    await expect(chord.getByRole("textbox", { name: "Name" })).toHaveValue("Em");
    await chord.getByRole("button", { name: "Apply" }).click();
    await expect.poll(() => scoreText(app)).toContain("Em");

    await emitMenuAction(app, "text");
    const text = app.getByRole("dialog", { name: "Text" });
    await text.getByRole("textbox", { name: "Text" }).fill("let it ring");
    await text.getByRole("button", { name: "Apply" }).click();
    await expect.poll(() => scoreText(app)).toContain("let it ring");
    await expect(scoreRegion(app)).toBeFocused();
  });

  test("shows a scale on the fretboard", async ({ app }) => {
    await newSong(app);
    await emitMenuAction(app, "scale-tool");
    const picker = app.getByRole("combobox", { name: "Scale" });
    await expect(picker).toBeFocused();
    await picker.click();
    await app.getByRole("option", { name: "Minor pentatonic" }).click();
    await app.getByRole("combobox", { name: "Root" }).click();
    await app.getByRole("option", { name: "A", exact: true }).click();
    const fretboard = app.getByRole("region", { name: "Fretboard" });
    await expect(fretboard).toContainText("A minor pentatonic: A C D E G");
    await expect(fretboard.getByRole("button", { name: "Fret 5, A2, scale root" })).toBeVisible();
  });
});
