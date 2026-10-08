import {
  editorStatus,
  emitMenuAction,
  expect,
  expectNoA11yViolations,
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
    await expect(fretboard).toContainText("Standard: E B G D A E");
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
    await expect(fretboard).toContainText("Standard: G D A E");

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

    // The click left the focus in the score. The fretboard can be played with the keyboard too:
    // Tab into it, then use the arrows.
    await board
      .getByRole("group", { name: "String 3 (G3)" })
      .getByRole("button", { name: "Fret 2, A3" })
      .focus();
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
    const crash = pads.getByRole("button", { name: "49 Crash high (hit)", exact: true });
    await crash.click();

    await expect.poll(() => editorStatus(app)).toMatch(/Crash high \(hit\)/);
    await expect(crash).toHaveAttribute("aria-pressed", "true");
  });

  for (const notation of ["Score + tab", "Score", "Tab"]) {
    test(`a click on the drum pad or the fretboard keeps the focus and arrows in the score (${notation})`, async ({
      app,
    }) => {
      await newSong(app);
      await app.getByRole("radio", { name: notation, exact: true }).click();
      await app.getByRole("button", { name: "Fretboard" }).click();
      await app.getByRole("button", { name: "Fret 5, A4" }).click();
      await expect(scoreRegion(app)).toBeFocused();
      const before = await editorStatus(app);

      await app.keyboard.press("ArrowRight"); // next beat, in the score
      await expect.poll(() => editorStatus(app)).not.toBe(before);
      await app.keyboard.press("ArrowUp"); // a string up, in the score
      await expect(scoreRegion(app)).toBeFocused();
    });
  }

  test("a click on a drum pad keeps the focus and arrows in the score", async ({ app }) => {
    await newSong(app);
    await emitMenuAction(app, "add-track");
    const dialog = app.getByRole("dialog", { name: "Add track" });
    await dialog.getByRole("combobox", { name: "Instrument" }).click();
    await app.getByRole("option", { name: "Drums" }).click();
    await dialog.getByRole("button", { name: "Add track" }).click();
    await app.getByRole("button", { name: "Drum pads" }).click();

    await app.getByRole("button", { name: "36 Kick (hit)", exact: true }).click();

    await expect(scoreRegion(app)).toBeFocused();
    const before = await editorStatus(app);
    await app.keyboard.press("ArrowRight");
    await expect.poll(() => editorStatus(app)).not.toBe(before);
    await expect(scoreRegion(app)).toBeFocused();
  });

  test("writes a drum groove fast: a skeleton of 1/32 rests, then the drum numbers", async ({
    app,
  }) => {
    await newSong(app);
    await emitMenuAction(app, "add-track");
    const dialog = app.getByRole("dialog", { name: "Add track" });
    await dialog.getByRole("combobox", { name: "Instrument" }).click();
    await app.getByRole("option", { name: "Drums" }).click();
    await dialog.getByRole("button", { name: "Add track" }).click();
    await app.getByRole("button", { name: "Drum pads" }).click();
    // The pads show their MIDI numbers.
    await expect(app.getByRole("button", { name: "46 Hi-Hat (open)", exact: true })).toContainText(
      "46",
    );

    await scoreRegion(app).focus();
    await app.keyboard.press("Shift+Digit6"); // 1/32
    await app.keyboard.press("Shift+R"); // fill the bar with 1/32 rests
    await expect.poll(() => editorStatus(app)).toMatch(/beat 1 of 32/);

    await app.keyboard.type("42"); // closed hi-hat
    await expect.poll(() => editorStatus(app)).toMatch(/Hi-Hat \(closed\)/);
    await app.keyboard.press("ArrowRight");
    await app.keyboard.type("46"); // open hi-hat on the next beat
    await expect.poll(() => editorStatus(app)).toMatch(/beat 2 of 32.*Hi-Hat \(open\)/);
    await app.keyboard.type("36"); // and a kick at the same time
    await expect.poll(() => editorStatus(app)).toMatch(/Kick \(hit\)/);

    await app.keyboard.press("ArrowLeft");
    await expect(
      app.getByRole("button", { name: "42 Hi-Hat (closed)", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(scoreRegion(app)).toBeFocused();
  });
});

test.describe("tuner (#83)", () => {
  test("plays the open strings from the fretboard and the tuner", async ({ app }) => {
    await openSong(app);
    await app.getByRole("switch", { name: "Native engine with effects" }).click();
    await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
    await app.getByRole("button", { name: "Fretboard" }).click();
    const fretboard = app.getByRole("region", { name: "Fretboard" });
    const previews = () =>
      app.evaluate(() =>
        window.__ipcCalls
          .filter((c) => c.cmd === "audio_transport")
          .map(
            (c) =>
              (c.args as { command: { type: string; key?: number; program?: number } }).command,
          )
          .filter((c) => c.type === "preview"),
      );
    // The low E string's name plays its note with the track's instrument.
    await fretboard.getByRole("button", { name: "Hear open string 6 (E2)" }).click();
    await expect.poll(async () => (await previews()).at(-1)).toMatchObject({ key: 40 });
    expect((await previews()).at(-1)?.program).toEqual(expect.any(Number));

    await fretboard.getByRole("button", { name: "Tuner…" }).click();
    const tuner = app.getByRole("dialog", { name: "Tuner: Guitar" });
    await tuner.getByRole("button", { name: /^Hear string 1/ }).click();
    await expect.poll(async () => (await previews()).at(-1)).toMatchObject({ key: 64 });
    await expectNoA11yViolations(app);
    await tuner.getByRole("tab", { name: "Microphone" }).click();
    await expect(tuner.getByRole("status")).toHaveText("The microphone is off.");
  });
});
