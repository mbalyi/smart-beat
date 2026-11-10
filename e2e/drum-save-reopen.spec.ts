import type { Page } from "@playwright/test";

import {
  editorStatus,
  emitMenuAction,
  expect,
  newSong,
  openSong,
  PRACTICE_SONG,
  scoreRegion,
  test,
  waitForAnimations,
} from "./fixtures";

/**
 * Drum notes keep their instruments through save and reopen (#229): edit a drum track, save it,
 * restart the app and open the file again. Every hit must still be the same drum, on the same
 * beat. Covered: a Guitar Pro 5 drum song saved in place and saved as each song format that
 * keeps drums, a new song's drum track, and a .gp drum track that has its own drum list.
 */

const DRUM_LINES = "/Users/me/Music/drum-lines.gp5";

/**
 * The drums of every beat as the drum tab draws them, in reading order: "bar 2: 35 38 52" is
 * the kick, snare and China on one beat of bar 2. A beat's numbers share their x position; the
 * bar is the red bar number nearest above and to the left of the hit.
 */
async function drumHits(page: Page): Promise<string[]> {
  return scoreRegion(page)
    .locator(".at-surface svg text")
    .evaluateAll((texts) => {
      const BAR_NUMBER_FILLS = ["#C80000", "#FF8A80"]; // light and dark mode
      const numbers = texts
        .filter((t) => /^\d+$/.test(t.textContent?.trim() ?? ""))
        .map((t) => {
          const box = t.getBoundingClientRect();
          return {
            x: box.x + box.width / 2,
            left: box.x,
            y: box.y,
            value: Number(t.textContent!.trim()),
            isBar: BAR_NUMBER_FILLS.includes(t.getAttribute("fill") ?? ""),
          };
        });
      const bars = numbers.filter((n) => n.isBar);
      const barOf = (hit: { x: number; y: number }) => {
        const above = bars.filter((b) => b.y <= hit.y && b.left <= hit.x);
        const row = Math.max(...above.map((b) => b.y));
        const inRow = above.filter((b) => Math.abs(b.y - row) < 4);
        return inRow.sort((a, b) => b.left - a.left)[0]?.value ?? 0;
      };
      const beats: { bar: number; x: number; drums: number[] }[] = [];
      for (const hit of numbers.filter((n) => !n.isBar)) {
        const bar = barOf(hit);
        const beat = beats.find((b) => b.bar === bar && Math.abs(b.x - hit.x) < 6);
        if (beat) beat.drums.push(hit.value);
        else beats.push({ bar, x: hit.x, drums: [hit.value] });
      }
      return beats
        .sort((a, b) => a.bar - b.bar || a.x - b.x)
        .map((b) => `bar ${b.bar}: ${b.drums.sort((m, n) => m - n).join(" ")}`);
    });
}

/** Waits for the drum tab to draw the same hits twice in a row, and returns them. */
async function settledDrumHits(page: Page): Promise<string[]> {
  let previous = "";
  let hits: string[] = [];
  await expect
    .poll(
      async () => {
        hits = await drumHits(page);
        const now = JSON.stringify(hits);
        const settled = now === previous && hits.length > 0;
        previous = now;
        return settled ? "settled" : now;
      },
      { timeout: 15_000, intervals: [250] },
    )
    .toBe("settled");
  return hits;
}

/** Shows the drum track as a drum tab (numbers on lines), laid out as pages. */
async function showDrumTab(app: Page, track?: string) {
  if (track) {
    await app.getByRole("combobox", { name: "Track" }).click();
    await app.getByRole("option", { name: track }).click();
  }
  await app
    .getByRole("radiogroup", { name: "Notation" })
    .getByRole("radio", { name: "Tab", exact: true })
    .click();
  await app
    .getByRole("radiogroup", { name: "Layout" })
    .getByRole("radio", { name: "Page", exact: true })
    .click();
}

/** Types a drum number at the cursor, as a drummer does on the drum tab ("4", "9" = 49). */
async function typeDrum(app: Page, drum: number, name: RegExp) {
  await app.keyboard.type(String(drum));
  await expect.poll(() => editorStatus(app)).toMatch(name);
}

/** What is typed on the four beats of bar 1: drum number and the name the status line reads. */
const BAR1: readonly (readonly [number, RegExp])[][] = [
  [[49, /Crash high/]],
  [
    [36, /Kick/],
    [38, /Snare \(hit\)/],
  ],
  [
    [57, /Crash medium/],
    [44, /Pedal Hi-Hat/],
  ],
  [
    [46, /Hi-Hat \(open\)/],
    [51, /Ride/],
  ],
];
const TYPED = BAR1.flat().map(([drum]) => drum);

/**
 * Kick, snare, pedal and open hi-hat, ride and both crashes on the four beats of bar 1, typed
 * one number after another and moving on with the Right arrow, as on the drum tab. None of them
 * is on its beat yet in the test songs (typing a drum that is there would remove it).
 */
async function enterDrums(app: Page) {
  for (const [index, beat] of BAR1.entries()) {
    if (index > 0) await app.keyboard.press("ArrowRight");
    for (const [drum, name] of beat) await typeDrum(app, drum, name);
  }
}

/** Opens the GP5 drum song in edit mode with the cursor on bar 1, beat 1. */
async function editDrumSong(app: Page) {
  await openSong(app, DRUM_LINES);
  await showDrumTab(app);
  await app.getByRole("button", { name: "Edit" }).click();
  await expect(app.getByRole("toolbar", { name: "Edit" })).toBeVisible();
  await waitForAnimations(app);
  await scoreRegion(app).focus();
  await expect.poll(() => editorStatus(app)).toMatch(/^Bar 1, beat 1 of 4/);
}

/**
 * Restarts the app with the saved file kept on "disk": the written bytes and the settings stored
 * in the file come back after a reload, as after quitting and starting the app again.
 */
async function restart(app: Page, path: string) {
  const saved = await app.evaluate(
    (p) => ({
      bytes: Array.from(window.__written.get(p) ?? []),
      settings: window.__projectSettings[p] ?? null,
    }),
    path,
  );
  expect(saved.bytes.length).toBeGreaterThan(100);
  await app.addInitScript(
    ({ p, bytes, settings }) => {
      window.__written.set(p, new Uint8Array(bytes));
      if (settings) window.__projectSettings[p] = settings;
    },
    { p: path, ...saved },
  );
  await app.reload();
  await expect(app.getByRole("heading", { level: 1 })).toBeVisible();
}

/** After entering the drums: every typed drum is on the tab (the setup worked). */
function expectTyped(hits: string[]) {
  const all = hits.flatMap((beat) =>
    beat
      .replace(/^bar \d+: /, "")
      .split(" ")
      .map(Number),
  );
  for (const drum of TYPED) expect(all, `drum ${drum} on the tab before saving`).toContain(drum);
}

test.describe("drum notes after save and reopen (#229)", () => {
  test("File › Save of an edited Guitar Pro 5 drum song keeps every drum", async ({ app }) => {
    await editDrumSong(app);
    await enterDrums(app);
    const before = await settledDrumHits(app);
    expectTyped(before);

    await emitMenuAction(app, "save");
    await expect(app.getByText("Edited")).toBeHidden();
    await restart(app, DRUM_LINES);
    await openSong(app, DRUM_LINES);
    await showDrumTab(app);

    expect(await settledDrumHits(app)).toEqual(before);
  });

  // Every song format of Save As that writes a drum track (MuseScore files come back without one).
  for (const extension of ["gp", "gp4", "gp3"] as const) {
    test(`Save As .${extension} of an edited Guitar Pro 5 drum song keeps every drum`, async ({
      app,
    }) => {
      const path = `/Users/me/Music/drums-edited.${extension}`;
      await editDrumSong(app);
      await enterDrums(app);
      const before = await settledDrumHits(app);
      expectTyped(before);

      await app.evaluate((p) => (window.__saveResult = p), path);
      await emitMenuAction(app, "save-as");
      await expect.poll(() => app.evaluate((p) => window.__written.has(p), path)).toBe(true);
      await expect(app.getByText("Edited")).toBeHidden();
      await restart(app, path);
      await openSong(app, path);
      await showDrumTab(app);

      expect(await settledDrumHits(app)).toEqual(before);
    });
  }

  test("a drum track of a new song, saved as a Smart Beat file, keeps every drum", async ({
    app,
  }) => {
    const path = "/Users/me/Music/new-drums.gp";
    await newSong(app);
    await emitMenuAction(app, "add-track");
    const dialog = app.getByRole("dialog", { name: "Add track" });
    await dialog.getByRole("combobox", { name: "Instrument" }).click();
    await app.getByRole("option", { name: "Drums" }).click();
    await dialog.getByRole("button", { name: "Add track" }).click();
    await expect(dialog).toBeHidden();
    await expect(scoreRegion(app)).toHaveAccessibleName("Score: Drums");
    await showDrumTab(app);
    await waitForAnimations(app);
    await scoreRegion(app).focus();
    await expect.poll(() => editorStatus(app)).toMatch(/^Bar 1, beat 1/);
    await enterDrums(app);
    const before = await settledDrumHits(app);
    expectTyped(before);

    // A new song has no file yet: Save asks where, in the native format.
    await app.evaluate((p) => (window.__saveResult = p), path);
    await emitMenuAction(app, "save");
    await expect.poll(() => app.evaluate((p) => window.__written.has(p), path)).toBe(true);
    await restart(app, path);
    await openSong(app, path);
    await showDrumTab(app, "Drums");

    expect(await settledDrumHits(app)).toEqual(before);
  });

  test("File › Save of an edited Smart Beat (.gp) drum track keeps every drum", async ({ app }) => {
    await openSong(app);
    await showDrumTab(app, "Drums");
    await app.getByRole("button", { name: "Edit" }).click();
    await expect(app.getByRole("toolbar", { name: "Edit" })).toBeVisible();
    await waitForAnimations(app);
    await scoreRegion(app).focus();
    await expect.poll(() => editorStatus(app)).toMatch(/^Bar 1, beat 1 of 4/);
    await enterDrums(app);
    const before = await settledDrumHits(app);
    expectTyped(before);

    await emitMenuAction(app, "save");
    await expect(app.getByText("Edited")).toBeHidden();
    await restart(app, PRACTICE_SONG);
    await openSong(app);
    await showDrumTab(app, "Drums");

    expect(await settledDrumHits(app)).toEqual(before);
  });
});
