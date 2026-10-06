import {
  editorStatus,
  emitMenuAction,
  expect,
  newSong,
  openSong,
  scoreRegion,
  scoreText,
  test,
} from "./fixtures";

/**
 * The song's structure (#11) with the real alphaTab renderer and player:
 * what the bar dialog sets is drawn, and playback follows repeats and jumps.
 */

/** Made by scripts/make-fixtures.mjs: repeats, endings and D.S. al Coda, 23.2 s long. */
const STRUCTURE_SONG = "/Users/me/Music/structure-song.gp";

test.describe("song structure (#11)", () => {
  test("opens a song with sections, repeats and jumps, and plays it in order", async ({ app }) => {
    await openSong(app, STRUCTURE_SONG);
    // alphaTab draws a long score in pieces: wait until the last one (the Coda) is there.
    await expect.poll(() => scoreText(app)).toContain("D.S. al Coda");
    const text = await scoreText(app);
    for (const section of ["Intro", "Verse", "Coda"]) expect(text).toContain(section);
    // 1 2 1 3 4 5 6 4 5 7: nine bars of 2.4 s at 100 BPM, and the Coda at 150 BPM.
    await expect(app.getByRole("timer")).toHaveText("0:00 / 0:23");
  });

  test("changes the time signature, tempo, section and repeats with the bar dialog", async ({
    app,
  }) => {
    await newSong(app); // four empty 4/4 bars at 120 BPM: 8 seconds
    await expect(app.getByRole("timer")).toHaveText("0:00 / 0:08");

    await app.getByRole("button", { name: "Bar…" }).click();
    let dialog = app.getByRole("dialog", { name: "Bar 1" });
    await dialog.getByRole("spinbutton", { name: "Beats per bar" }).fill("3");
    await dialog.getByRole("spinbutton", { name: "Beats per minute" }).fill("60");
    await dialog.getByRole("textbox", { name: "Section name" }).fill("Chorus");
    await dialog.getByRole("button", { name: "Apply" }).click();
    await expect(dialog).toBeHidden();
    await expect(scoreRegion(app)).toBeFocused();

    // Four bars of 3/4 at 60 BPM: 12 seconds.
    await expect(app.getByRole("timer")).toHaveText("0:00 / 0:12");
    await expect.poll(() => scoreText(app)).toContain("Chorus");
    expect(await editorStatus(app)).toMatch(/^Bar 1, beat 1 of 1/);

    // Bar 2 is played three times: two more bars of 3 seconds.
    await app.keyboard.press("ControlOrMeta+ArrowRight");
    await emitMenuAction(app, "bar-settings");
    dialog = app.getByRole("dialog", { name: "Bar 2" });
    await dialog.getByRole("checkbox", { name: "Repeat starts here" }).click();
    await dialog.getByRole("checkbox", { name: "Repeat ends here" }).click();
    await dialog.getByRole("spinbutton", { name: "Play" }).fill("3");
    await dialog.getByRole("button", { name: "Apply" }).click();
    await expect(app.getByRole("timer")).toHaveText("0:00 / 0:18");
    await expect.poll(() => scoreText(app)).toContain("x3");

    // Undo, step by step.
    await emitMenuAction(app, "undo");
    await expect(app.getByRole("timer")).toHaveText("0:00 / 0:12");
    await emitMenuAction(app, "undo");
    await expect(app.getByRole("timer")).toHaveText("0:00 / 0:08");
    await expect.poll(() => scoreText(app)).not.toContain("Chorus");
  });

  test("toggles repeat signs from the Bar menu and warns about jumps that can't work", async ({
    app,
  }) => {
    await newSong(app);
    await emitMenuAction(app, "toggle-repeat-end"); // bar 1 played twice
    await expect(app.getByRole("timer")).toHaveText("0:00 / 0:10");
    await expect.poll(() => app.evaluate(() => window.__menuState?.repeatEnd)).toBe(true);

    await app.getByRole("button", { name: "Bar…" }).click();
    const dialog = app.getByRole("dialog", { name: "Bar 1" });
    await dialog.getByRole("checkbox", { name: "D.S. al Fine", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText(
      "A D.S. jump has no Segno to go back to.",
    );
    await expect(dialog.getByRole("status")).toContainText(
      "An “al Fine” jump needs a Fine to stop at.",
    );
    await dialog.getByRole("checkbox", { name: "Segno", exact: true }).click();
    await dialog.getByRole("checkbox", { name: "Fine", exact: true }).click();
    await expect(dialog.getByRole("status")).toBeEmpty();
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });
});
