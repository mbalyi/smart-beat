import {
  editorStatus,
  emitMenuAction,
  expect,
  expectTab,
  newSong,
  scoreRegion,
  scoreText,
  test,
} from "./fixtures";

/**
 * Guitar techniques (#12) with the real alphaTab renderer: effects set with
 * keys, the toolbar, menus and the bend editor are drawn in the score.
 */

test.describe("guitar techniques (#12)", () => {
  test("draws effects set with keys and the toolbar, and undoes them", async ({ app }) => {
    await newSong(app);
    await app.keyboard.type("5");
    await app.keyboard.press("ArrowRight");
    await app.keyboard.type("7");
    await app.keyboard.press("ArrowLeft");
    await expectTab(app, ["5", "7"]);

    await app.keyboard.press("h"); // hammer-on to the 7
    await app.keyboard.press("p"); // palm mute
    await expect.poll(() => scoreText(app)).toContain("P.M.");
    await expect.poll(() => scoreText(app)).toContain("H");
    expect(await editorStatus(app)).toContain("hammer-on / pull-off, palm mute");

    await app.keyboard.press("ArrowRight");
    const effects = app.getByRole("toolbar", { name: "Effects" });
    await effects.getByRole("button", { name: "Harmonic" }).click();
    await app.getByRole("menuitemradio", { name: "Natural harmonic" }).click();
    await expect.poll(() => scoreText(app)).toContain("N.H.");
    await expect(scoreRegion(app)).toBeFocused();

    await effects.getByRole("button", { name: "Let ring" }).click();
    await expect.poll(() => scoreText(app)).toContain("LetRing");
    await expect(effects.getByRole("button", { name: "Let ring" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await emitMenuAction(app, "undo");
    await expect.poll(() => scoreText(app)).not.toContain("LetRing");
    await emitMenuAction(app, "undo");
    await expect.poll(() => scoreText(app)).not.toContain("N.H.");
  });

  test("bends a note with the bend editor", async ({ app }) => {
    await newSong(app);
    await app.keyboard.press("ArrowDown"); // the B string
    await app.keyboard.type("8");
    await app.keyboard.press("Shift+B");
    const dialog = app.getByRole("dialog", { name: "Bend" });
    await expect(dialog.getByRole("img", { name: "Curve: full step up" })).toBeVisible();
    await dialog.getByRole("radio", { name: "Bend and release", exact: true }).click();
    await dialog.getByRole("button", { name: "Apply" }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => scoreText(app)).toContain("full");
    await expect(app.getByRole("button", { name: "Undo Add bend" })).toBeEnabled();
    await expect(scoreRegion(app)).toBeFocused();
  });

  test("switches effects from the Note menu, which follows the note at the cursor", async ({
    app,
  }) => {
    await newSong(app);
    await app.keyboard.type("3");
    await expect.poll(() => app.evaluate(() => window.__menuState?.hasNote)).toBe(true);
    await emitMenuAction(app, "toggle-vibrato");
    await emitMenuAction(app, "toggle-dead-note");
    await expect
      .poll(() => app.evaluate(() => window.__menuState?.noteEffects))
      .toMatchObject({ vibrato: true, deadNote: true, palmMute: false });
    expect(await editorStatus(app)).toContain("vibrato, dead note");
    // A dead note is drawn as an x in the tab.
    await expect.poll(async () => (await scoreText(app)).split(/\s+/)).toContain("x");
  });

  test("adds a grace note before the beat", async ({ app }) => {
    await newSong(app);
    await app.keyboard.type("7");
    await app
      .getByRole("toolbar", { name: "Effects" })
      .getByRole("button", { name: "More" })
      .click();
    await app.getByRole("menuitemradio", { name: "Grace note before the beat" }).click();
    await expect(scoreRegion(app)).toBeFocused();
    await app.keyboard.type("5"); // the grace note's fret
    await expectTab(app, ["5", "7"]);
    expect(await editorStatus(app)).toContain("grace note");
  });
});
