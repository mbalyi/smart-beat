import type { Page } from "@playwright/test";

import {
  editorStatus,
  emitMenuAction,
  expect,
  newSong,
  scoreRegion,
  test,
  waitForAnimations,
} from "./fixtures";

/**
 * Deleting keeps the view still (#228, story 13): on a drum tab full of 64th notes, deleting
 * notes and beats with Delete / Backspace must not scroll the score while the edit cursor stays
 * in view. When the cursor is out of view, an edit scrolls only as far as needed to show it.
 *
 * The drummer clicks the spot to edit, which in edit mode also moves the playback cursor there.
 * Every redraw after an edit then made alphaTab scroll to the start of the playback cursor's bar:
 * with 64th notes a bar is wider than the view, so the view jumped to the left. With reduced
 * motion alphaTab scrolls in steps of its own, which nothing interrupts (as in the desktop app);
 * a smooth browser scroll would be cut short by the editor's own "keep the cursor in view".
 * The drums are shown as "Score + tab": the drum tab alone in the continuous layout hits an
 * alphaTab error in its lazy redraw (seen in 1.8.4).
 */

/** A new song's bars (4/4): 64 beats each once filled with 64th rests. */
const BEATS_PER_BAR = 64;
/** Where the cursor sits: well inside the song and inside a bar wider than the view. */
const CURSOR_BAR = 3;
const CURSOR_BEAT = 24;
/** Scroll drift that still counts as "did not move" (sub-pixel rounding of a redraw). */
const STILL_PX = 2;
/** How far from the near edge the cursor may land when an edit has to bring it back. */
const NEAR_EDGE_PX = 120;
/** How long the scroll position must stay the same to count as settled (redraw and scroll included). */
const SETTLED_MS = 600;

type Layout = "Continuous" | "Page";

const viewport = (app: Page) => app.getByTestId("score-viewport");
const cursorNote = (app: Page) => app.getByTestId("edit-cursor-note").first();

interface ScrollPosition {
  left: number;
  top: number;
}

/** The scroll position once it has not changed for `SETTLED_MS`. */
async function settledScroll(app: Page): Promise<ScrollPosition> {
  return viewport(app).evaluate(async (el, settledMs) => {
    const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
    let last = `${el.scrollLeft},${el.scrollTop}`;
    let since = await frame();
    for (;;) {
      const now = await frame();
      const position = `${el.scrollLeft},${el.scrollTop}`;
      if (position !== last) {
        last = position;
        since = now;
      } else if (now - since >= settledMs) {
        return { left: el.scrollLeft, top: el.scrollTop };
      }
    }
  }, SETTLED_MS);
}

/** The visible part of the score viewport and the cursor's outline, in page coordinates. */
async function boxes(app: Page) {
  const view = await viewport(app).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: el.clientWidth, height: el.clientHeight };
  });
  const cursor = (await cursorNote(app).boundingBox())!;
  return { view, cursor };
}

type Boxes = Awaited<ReturnType<typeof boxes>>;

function expectCursorInView({ view, cursor }: Boxes, when: string) {
  expect(cursor.x, `${when}: cursor left of the view`).toBeGreaterThanOrEqual(view.x - 1);
  expect(cursor.x + cursor.width, `${when}: cursor right of the view`).toBeLessThanOrEqual(
    view.x + view.width + 1,
  );
  expect(cursor.y, `${when}: cursor above the view`).toBeGreaterThanOrEqual(view.y - 1);
  expect(cursor.y + cursor.height, `${when}: cursor below the view`).toBeLessThanOrEqual(
    view.y + view.height + 1,
  );
}

/** Presses `key` and waits for the edit to be made (the status line changes). */
async function pressAndWait(app: Page, key: string) {
  const status = await editorStatus(app);
  await app.keyboard.press(key);
  await expect
    .poll(() => editorStatus(app), { message: `${key} edits the score` })
    .not.toBe(status);
  await expect(cursorNote(app)).toBeVisible();
}

/**
 * A new song with a drum track shown as score and drum tab in `layout`, every bar filled with 64th
 * rests and a snare typed on every fourth beat of bars 2 and 3.
 */
async function drumTabOf64ths(app: Page, layout: Layout) {
  await newSong(app);
  await emitMenuAction(app, "add-track");
  const dialog = app.getByRole("dialog", { name: "Add track" });
  await dialog.getByRole("combobox", { name: "Instrument" }).click();
  await app.getByRole("option", { name: "Drums" }).click();
  await dialog.getByRole("button", { name: "Add track" }).click();
  await expect(dialog).toBeHidden();
  await expect(scoreRegion(app)).toHaveAccessibleName("Score: Drums");
  await app
    .getByRole("radiogroup", { name: "Notation" })
    .getByRole("radio", { name: "Score + tab", exact: true })
    .click();
  await app
    .getByRole("radiogroup", { name: "Layout" })
    .getByRole("radio", { name: layout, exact: true })
    .click();
  await expect(viewport(app)).toHaveAttribute(
    "data-layout",
    layout === "Page" ? "page" : "horizontal",
  );
  await waitForAnimations(app);
  await scoreRegion(app).focus();
  await expect.poll(() => editorStatus(app)).toMatch(/^Bar 1, beat 1/);

  await app.keyboard.press("Shift+Digit7"); // the 64th note value
  await app.keyboard.press("ControlOrMeta+A");
  await app.keyboard.press("Shift+R"); // every bar filled with 64th rests
  await expect
    .poll(() => editorStatus(app))
    .toMatch(new RegExp(`^Bar 1, beat 1 of ${BEATS_PER_BAR}, 64th rest`));

  for (const bar of [2, 3]) {
    await app.keyboard.press("ControlOrMeta+ArrowRight");
    await expect.poll(() => editorStatus(app)).toMatch(new RegExp(`^Bar ${bar}, beat 1 `));
    for (let beat = 1; beat <= BEATS_PER_BAR; beat++) {
      if (beat % 4 === 1) {
        await app.keyboard.type("38");
        await expect.poll(() => editorStatus(app)).toMatch(/Snare/);
      }
      if (beat < BEATS_PER_BAR) await app.keyboard.press("ArrowRight");
    }
  }
}

/**
 * Puts the cursor on bar 3, beat 24 (a rest between two snares), scrolls it to the middle of
 * the view as when reading along, and clicks it there.
 */
async function clickInTheMiddle(app: Page) {
  for (let i = 0; i < 4; i++) await app.keyboard.press("ControlOrMeta+ArrowLeft");
  for (let i = 1; i < CURSOR_BAR; i++) await app.keyboard.press("ControlOrMeta+ArrowRight");
  await expect.poll(() => editorStatus(app)).toMatch(new RegExp(`^Bar ${CURSOR_BAR}, beat 1 `));
  for (let i = 1; i < CURSOR_BEAT; i++) await app.keyboard.press("ArrowRight");
  const atCursor = new RegExp(`^Bar ${CURSOR_BAR}, beat ${CURSOR_BEAT} of`);
  await expect.poll(() => editorStatus(app)).toMatch(atCursor);
  await expect(cursorNote(app)).toBeVisible();
  await settledScroll(app);

  const { view, cursor } = await boxes(app);
  const dx = cursor.x + cursor.width / 2 - (view.x + view.width / 2);
  const dy = cursor.y + cursor.height / 2 - (view.y + view.height / 2);
  await viewport(app).evaluate(
    (el, [left, top]) => el.scrollBy({ left, top, behavior: "instant" }),
    [dx, dy] as const,
  );
  await settledScroll(app);

  // The outline lets clicks through to the score below it.
  const box = (await cursorNote(app).boundingBox())!;
  await app.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => editorStatus(app)).toMatch(atCursor);
  await expect(scoreRegion(app)).toBeFocused();
}

test.describe("deleting keeps the view still (#228, story 13)", () => {
  test.use({ reducedMotion: "reduce" });

  for (const layout of ["Continuous", "Page"] as const) {
    test(`Delete and Backspace on a drum tab of 64th notes do not scroll the score (${layout.toLowerCase()} layout)`, async ({
      app,
    }) => {
      test.setTimeout(120_000);
      await drumTabOf64ths(app, layout);
      await clickInTheMiddle(app);

      const before = await settledScroll(app);
      // The setup really scrolled: the cursor is far from the start of the song.
      if (layout === "Continuous") expect(before.left).toBeGreaterThan(1000);
      else expect(before.top).toBeGreaterThan(0);
      expectCursorInView(await boxes(app), "before deleting");

      // A rest, then the snare that moved into its place, then the beats that are left empty.
      for (const key of ["Delete", "Backspace", "Delete", "Backspace"]) {
        await pressAndWait(app, key);
        const after = await settledScroll(app);
        const status = await editorStatus(app);
        expect(
          Math.abs(after.left - before.left),
          `${key} (${status}) scrolled sideways from ${before.left} to ${after.left}`,
        ).toBeLessThanOrEqual(STILL_PX);
        expect(
          Math.abs(after.top - before.top),
          `${key} (${status}) scrolled up or down from ${before.top} to ${after.top}`,
        ).toBeLessThanOrEqual(STILL_PX);
        expectCursorInView(await boxes(app), `after ${key}`);
      }
    });
  }

  test("an edit with the cursor out of view scrolls only as far as needed to show it", async ({
    app,
  }) => {
    test.setTimeout(120_000);
    await drumTabOf64ths(app, "Continuous");
    await clickInTheMiddle(app);

    // Scroll the cursor out of view to the left, as when reading on to the next beats.
    const { view } = await boxes(app);
    await viewport(app).evaluate(
      (el, width) => el.scrollBy({ left: width, behavior: "instant" }),
      view.width,
    );
    const away = await settledScroll(app);
    const hidden = await boxes(app);
    expect(hidden.cursor.x + hidden.cursor.width, "the cursor is out of view").toBeLessThan(view.x);

    await pressAndWait(app, "Delete");
    const after = await settledScroll(app);
    const shown = await boxes(app);
    expectCursorInView(shown, "after Delete");
    // Brought back just inside the left edge, not scrolled to the start of its bar.
    expect(after.left, "the view scrolls left, towards the cursor").toBeLessThan(away.left);
    expect(
      shown.cursor.x - shown.view.x,
      `the cursor lands near the left edge (view scrolled from ${away.left} to ${after.left})`,
    ).toBeLessThanOrEqual(NEAR_EDGE_PX);
  });
});
