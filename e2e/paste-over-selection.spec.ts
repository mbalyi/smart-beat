import type { Page } from "@playwright/test";

import { editorStatus, emitMenuAction, expect, expectTab, newSong, test } from "./fixtures";

/**
 * Paste replaces the selection (#228, story 11): with beats selected in edit
 * mode, Paste removes them and writes the clipboard at the start of the
 * selection. A shorter clip leaves that bar short; a longer one pushes the
 * following bars back into newly inserted bars instead of writing over them.
 * One Undo brings the song back.
 */

/** Four full bars of quarter notes on the top string, every fret different. */
const SONG = [
  [1, 2, 3, 4],
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
];

/** A beat as the status line reads it: its fret on the top string, or null for a rest. */
type Bars = (number | null)[][];

/** Types `bars` into the new song: one fret per beat, ArrowRight to the next beat (and bar). */
async function writeSong(app: Page, bars: number[][]) {
  const frets = bars.flat();
  for (const [i, fret] of frets.entries()) {
    await app.keyboard.type(String(fret));
    if (i < frets.length - 1) await app.keyboard.press("ArrowRight");
  }
  await expectTab(app, frets.map(String));
}

/** The "/ 4" next to the bar field in the toolbar display. */
async function barCount(app: Page): Promise<number> {
  const text = await app.getByText(/^\/ \d+$/).textContent();
  return Number(text?.replace("/", "").trim());
}

/** Waits until the status line says the cursor is on `bar`, `beat` (1-based). */
async function expectCursor(app: Page, bar: number, beat: number) {
  await expect
    .poll(() => editorStatus(app))
    .toMatch(new RegExp(`^Bar ${bar}, beat ${beat} of \\d+`));
}

/** Puts the cursor on `bar`, `beat` (1-based), without a selection. */
async function goTo(app: Page, bar: number, beat = 1) {
  for (let i = 1; i < (await barCount(app)) + 1; i++) {
    await app.keyboard.press("ControlOrMeta+ArrowLeft");
  }
  await expectCursor(app, 1, 1);
  for (let b = 1; b < bar; b++) await app.keyboard.press("ControlOrMeta+ArrowRight");
  await expectCursor(app, bar, 1);
  for (let b = 1; b < beat; b++) await app.keyboard.press("ArrowRight");
  await expectCursor(app, bar, beat);
}

/** Selects `count` beats from the cursor on with Shift+ArrowRight. */
async function selectBeats(app: Page, count: number) {
  for (let i = 1; i < count; i++) await app.keyboard.press("Shift+ArrowRight");
}

/**
 * The song as the editor reports it, bar by bar: the cursor walks every beat
 * (moving within a bar and with Ctrl/⌘+ArrowRight between bars, which never
 * adds beats) and the status line names each beat's fret.
 */
async function readBars(app: Page): Promise<Bars> {
  const count = await barCount(app);
  await goTo(app, 1);
  const bars: Bars = [];
  for (let bar = 1; bar <= count; bar++) {
    if (bar > 1) await app.keyboard.press("ControlOrMeta+ArrowRight");
    await expectCursor(app, bar, 1);
    const beats = Number(/ of (\d+)/.exec(await editorStatus(app))?.[1]);
    const frets: (number | null)[] = [];
    for (let beat = 1; beat <= beats; beat++) {
      if (beat > 1) await app.keyboard.press("ArrowRight");
      await expectCursor(app, bar, beat);
      const fret = /, fret (\d+)/.exec(await editorStatus(app))?.[1];
      frets.push(fret === undefined ? null : Number(fret));
    }
    bars.push(frets);
  }
  return bars;
}

/** A new song with SONG written in it, checked through the editor. */
async function songWithFourBars(app: Page) {
  test.slow(); // a song typed beat by beat, then read back beat by beat
  await newSong(app);
  await writeSong(app, SONG);
  await expect.poll(() => barCount(app)).toBe(SONG.length);
  expect(await readBars(app)).toEqual(SONG);
}

/** Copies `count` beats from `bar`, `beat` on. */
async function copyBeats(app: Page, bar: number, beat: number, count: number) {
  await goTo(app, bar, beat);
  await selectBeats(app, count);
  await app.keyboard.press("ControlOrMeta+c");
  await expect(app.getByText(`Copied ${count} beats`)).toBeVisible();
}

/** Selects `count` beats from `bar`, `beat` on and pastes over them. */
async function pasteOver(app: Page, bar: number, beat: number, count: number) {
  await goTo(app, bar, beat);
  await selectBeats(app, count);
  await expectCursor(app, bar, beat + count - 1);
  await app.keyboard.press("ControlOrMeta+v");
}

test.describe("paste replaces the selection (#228)", () => {
  test("a shorter clip replaces the selected beats and leaves the bar short", async ({ app }) => {
    await songWithFourBars(app);
    await copyBeats(app, 1, 1, 2); // frets 1 and 2
    await pasteOver(app, 3, 1, 4); // all of bar 3

    // Frets 9 to 12 are gone, 1 and 2 start bar 3, and bar 4 is untouched.
    await expectTab(app, [
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "1",
      "2",
      "13",
      "14",
      "15",
      "16",
    ]);
    expect(await barCount(app)).toBe(4);
    expect(await readBars(app)).toEqual([SONG[0], SONG[1], [1, 2], SONG[3]]);
  });

  test("a longer clip flows into new bars and moves the next bars back", async ({ app }) => {
    await songWithFourBars(app);
    await copyBeats(app, 1, 1, 8); // bars 1 and 2
    await pasteOver(app, 3, 3, 2); // frets 11 and 12, the end of the last-but-one bar

    // Nothing is written over: frets 13 to 16 follow the whole clip.
    await expectTab(app, [
      ...["1", "2", "3", "4", "5", "6", "7", "8"],
      ...["9", "10", "1", "2", "3", "4", "5", "6", "7", "8"],
      ...["13", "14", "15", "16"],
    ]);
    // The music flows over the bar lines: every bar is filled to its four beats, the rest of
    // the clip goes into two new bars (the last one filled with a rest), and the old bar 4
    // comes last, unchanged.
    await expect.poll(() => barCount(app)).toBe(SONG.length + 2);
    const bars = await readBars(app);
    expect(bars).toEqual([SONG[0], SONG[1], [9, 10, 1, 2], [3, 4, 5, 6], [7, 8, null], SONG[3]]);
  });

  test("one Undo brings back the bars and beats from before the paste", async ({ app }) => {
    await songWithFourBars(app);
    await copyBeats(app, 1, 1, 8);
    await pasteOver(app, 3, 3, 2);
    await expect.poll(() => barCount(app)).toBe(SONG.length + 2);

    // ⌘Z / Ctrl+Z: the desktop app undoes through the Edit menu (Rust forwards the shortcut).
    await emitMenuAction(app, "undo");
    await expectTab(app, SONG.flat().map(String));
    await expect.poll(() => barCount(app)).toBe(SONG.length);
    expect(await readBars(app)).toEqual(SONG);
  });
});
