import {
  editorStatus,
  emitMenuAction,
  expect,
  expectTab,
  newSong,
  openSong,
  scoreRegion,
  tabNumbers,
  test,
  waitForAnimations,
} from "./fixtures";

/**
 * Note entry and editing (#9) with the real alphaTab renderer: what is typed
 * must be drawn in the tab, and undo/redo must bring the drawing back.
 */

test.describe("note entry and editing (#9)", () => {
  test("writes a song from scratch with the keyboard", async ({ app }) => {
    await newSong(app);
    await expect(app.getByRole("heading", { level: 1, name: "Untitled" })).toBeVisible();

    // Frets on the top string, a two-digit fret, then a pitch by letter.
    await app.keyboard.press("3");
    await app.keyboard.press("ArrowRight");
    await app.keyboard.press("ArrowDown");
    await app.keyboard.press("5");
    await app.keyboard.press("ArrowRight");
    await app.keyboard.type("12");
    await app.keyboard.press("ArrowRight");
    await app.keyboard.press("a"); // A4: fret 10 on the B string, near the note before

    await expectTab(app, ["3", "5", "12", "10"]);
    expect(await editorStatus(app)).toMatch(/^Bar 1, beat 4 of 4, string 2 \(B\), fret 10/);
    await expect(app.getByText("Edited")).toBeVisible();

    // The bar is full: moving on goes to bar 2, and past the last bar adds one.
    await app.keyboard.press("ArrowRight");
    expect(await editorStatus(app)).toMatch(/^Bar 2, beat 1 of 1/);
    await app.keyboard.press("ControlOrMeta+ArrowRight");
    await app.keyboard.press("ControlOrMeta+ArrowRight");
    await app.keyboard.press("7");
    await app.keyboard.press("-"); // longer: a half note
    await app.keyboard.press("-"); // a whole note fills the bar
    await app.keyboard.press("ArrowRight");
    await expect(app.getByText("/ 5")).toBeVisible();
  });

  test("undoes and redoes any number of edits", async ({ app }) => {
    await newSong(app);
    for (const fret of ["1", "2", "3"]) {
      await app.keyboard.press(fret);
      await app.keyboard.press("ArrowRight");
    }
    await expectTab(app, ["1", "2", "3"]);

    // The desktop app undoes through the Edit menu (Rust forwards ⌘Z).
    await emitMenuAction(app, "undo"); // the beat added by moving right
    await emitMenuAction(app, "undo"); // fret 3
    await expectTab(app, ["1", "2"]);
    await app.getByRole("button", { name: "Undo Add beat" }).click();
    await app.getByRole("button", { name: "Undo Add note" }).click();
    await expectTab(app, ["1"]);

    await expect.poll(() => app.evaluate(() => window.__menuState?.redo)).toBe("Add note");
    await emitMenuAction(app, "redo");
    await expectTab(app, ["1", "2"]);
    await expect(scoreRegion(app)).toBeFocused();
  });

  test("changes durations, dots, rests, ties and tuplets", async ({ app }) => {
    await newSong(app);
    await app.keyboard.press("5");
    await app.keyboard.press("ArrowRight");
    await app.keyboard.press("t"); // tie the next beat to the 5
    await expect.poll(() => editorStatus(app)).toMatch(/fret 5, tied/);

    await app.getByRole("radio", { name: "Eighth" }).click();
    const dot = app.getByRole("button", { name: "Dot", exact: true });
    await dot.click();
    expect(await editorStatus(app)).toMatch(/Eighth$/);
    await expect(dot).toHaveAttribute("aria-pressed", "true");

    await app.getByRole("combobox", { name: "Tuplet" }).click();
    await app.getByRole("option", { name: "Triplet (3:2)" }).click();
    await expect(app.getByRole("combobox", { name: "Tuplet" })).toHaveText("Triplet (3:2)");

    await app.getByRole("button", { name: "Rest", exact: true }).click();
    await expectTab(app, ["5"]);
    await expect(scoreRegion(app)).toBeFocused(); // typing continues in the score
  });

  test("copies, cuts and pastes beats", async ({ app }) => {
    await newSong(app);
    await app.keyboard.press("1");
    await app.keyboard.press("ArrowRight");
    await app.keyboard.press("2");
    await app.keyboard.press("Shift+ArrowLeft"); // select both beats
    await app.keyboard.press("ControlOrMeta+c");
    await app.keyboard.press("ControlOrMeta+ArrowRight"); // bar 2
    await app.keyboard.press("ControlOrMeta+v");
    await expectTab(app, ["1", "2", "1", "2"]);

    await app.keyboard.press("ControlOrMeta+x"); // the pasted beats are selected
    await expectTab(app, ["1", "2"]);
    expect(await editorStatus(app)).toMatch(/^Bar 2/);
  });

  test("writes a second voice on the same staff", async ({ app }) => {
    await newSong(app);
    await app.keyboard.press("0");
    await app.getByRole("radio", { name: "Voice 2" }).click();
    await expect(scoreRegion(app)).toBeFocused();
    await app.keyboard.press("ArrowDown");
    await app.keyboard.press("ArrowDown");
    await app.keyboard.press("2");

    // alphaTab draws voice 2 first.
    await expect.poll(async () => (await tabNumbers(app)).sort()).toEqual(["0", "2"]);
    await expect(app.getByRole("radio", { name: "Voice 2" })).toBeChecked();
  });

  test("places the cursor by clicking a note in the score", async ({ app }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Edit" }).click();
    await waitForAnimations(app); // the palette slides in and moves the score
    await expect(scoreRegion(app)).toBeFocused();
    const before = await tabNumbers(app);

    // Bar 3's second note ("2" on the A string of the guitar).
    const note = scoreRegion(app).locator(".at-surface svg text").filter({ hasText: /^2$/ }).nth(1);
    const box = await note.evaluate((el: SVGTextElement) => {
      const svg = el.ownerSVGElement!.getBoundingClientRect();
      const text = el.getBBox();
      return { x: svg.x + text.x + text.width / 2, y: svg.y + text.y + text.height / 2 };
    });
    await app.mouse.click(box.x, box.y);
    await expect.poll(() => editorStatus(app)).toMatch(/fret 2/);

    await app.keyboard.press("7");
    // The tab is briefly empty while alphaTab redraws: wait for the 7 itself.
    await expect.poll(() => tabNumbers(app)).toContain("7");
    expect(await tabNumbers(app)).not.toEqual(before);
    await expect(app.getByTestId("edit-cursor-note").first()).toBeVisible();
  });

  test("asks before closing a song with changes", async ({ app }) => {
    await newSong(app);
    await app.keyboard.press("4");
    await expect(app.getByText("Edited")).toBeVisible();

    await app.getByRole("button", { name: /^Close Untitled/ }).click();
    const confirm = app.getByRole("alertdialog", { name: /Discard your changes/ });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Keep editing" }).click();
    await expect(confirm).toBeHidden();
    await expect(app.getByText("Edited")).toBeVisible();

    await app.getByRole("button", { name: /^Close Untitled/ }).click();
    await confirm.getByRole("button", { name: "Discard changes" }).click();
    await expect(app.getByRole("button", { name: "Open a file…" })).toBeVisible();
  });

  test("a song with changes stays open in its tab while another song is opened", async ({
    app,
  }) => {
    await newSong(app);
    await app.keyboard.press("4");
    await expectTab(app, ["4"]);

    await openSong(app);
    await expect(app.getByRole("alertdialog")).toHaveCount(0);
    const tabs = app.getByRole("navigation", { name: "Open songs" });
    await expect(tabs.getByRole("listitem")).toHaveCount(2);

    // Back to the edited song: its notes (and undo) are still there.
    await tabs.getByRole("button", { name: /^Untitled/ }).click();
    await expect(app.getByRole("heading", { level: 1, name: "Untitled" })).toBeVisible();
    await expectTab(app, ["4"]);
    await expect(app.getByRole("button", { name: "Undo Add note" })).toBeEnabled();
  });
});
