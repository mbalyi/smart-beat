import type { Page } from "@playwright/test";

import {
  editorStatus,
  emitMenuAction,
  expect,
  openSong,
  scoreRegion,
  test,
  waitForAnimations,
} from "./fixtures";

/**
 * Typing on a written drum replaces it (#228, story 12): with the cursor on a line of the drum
 * tab that holds a drum, a typed drum number takes that drum's place on the same line of the same
 * beat, instead of being added on another line next to it. Typing it again removes it, and each
 * edit is one undo step. Covered: a drum track without its own drum list (Guitar Pro 5) and a .gp
 * drum track that has its own.
 */

const DRUM_LINES = "/Users/me/Music/drum-lines.gp5";

/** The lowest General MIDI drum number: smaller numbers on the tab are not drums. */
const FIRST_DRUM = 27;

interface Hit {
  value: number;
  y: number;
}

/**
 * The drums of a beat of bar 1 as the drum tab draws them (`beat` counts from 1), top line
 * first. A beat's numbers share their x position.
 */
async function beatHits(page: Page, beat: number): Promise<Hit[]> {
  const beats = await scoreRegion(page)
    .locator(".at-surface svg text")
    .evaluateAll((texts, first) => {
      const BAR_NUMBER_FILLS = ["#C80000", "#FF8A80"]; // light and dark mode
      const hits = texts
        .filter((t) => /^\d+$/.test(t.textContent?.trim() ?? ""))
        .filter((t) => !BAR_NUMBER_FILLS.includes(t.getAttribute("fill") ?? ""))
        .map((t) => {
          const box = t.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y, value: Number(t.textContent!.trim()) };
        })
        .filter((hit) => hit.value >= first);
      // Bar 1 is the first row of the tab: the hits on the top staff, left to right.
      const top = Math.min(...hits.map((h) => h.y));
      const row = hits.filter((h) => h.y - top < 80);
      const columns: { x: number; hits: { value: number; y: number }[] }[] = [];
      for (const hit of row) {
        const column = columns.find((c) => Math.abs(c.x - hit.x) < 6);
        if (column) column.hits.push({ value: hit.value, y: hit.y });
        else columns.push({ x: hit.x, hits: [{ value: hit.value, y: hit.y }] });
      }
      return columns.sort((a, b) => a.x - b.x).map((c) => c.hits.sort((a, b) => a.y - b.y));
    }, FIRST_DRUM);
  return beats[beat - 1] ?? [];
}

/** The drum numbers of a beat of bar 1, lowest first. */
async function beatDrums(page: Page, beat: number): Promise<number[]> {
  return (await beatHits(page, beat)).map((h) => h.value).sort((a, b) => a - b);
}

/** The y position of a drum number on a beat of bar 1. */
async function drumY(page: Page, beat: number, drum: number): Promise<number> {
  const hit = (await beatHits(page, beat)).find((h) => h.value === drum);
  expect(hit, `drum ${drum} on beat ${beat}`).toBeDefined();
  return hit!.y;
}

/** Shows a track as a drum tab (numbers on lines), laid out as pages, in edit mode. */
async function editDrumTab(app: Page, track?: string) {
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
  await app.getByRole("button", { name: "Edit" }).click();
  await expect(app.getByRole("toolbar", { name: "Edit" })).toBeVisible();
  await waitForAnimations(app);
  await scoreRegion(app).focus();
  await expect.poll(() => editorStatus(app)).toMatch(/^Bar 1, beat 1 of 4/);
}

const LINE = /line (\d) of the drum tab/;

/**
 * Puts the cursor on the line of the drum tab that holds `name` (Up and Down move over the
 * lines, 1 = top), and returns that line. Never steps past the top or bottom line, which would
 * go to the other voice.
 */
async function cursorOnDrum(app: Page, name: string): Promise<number> {
  const lineNow = async () => Number(LINE.exec(await editorStatus(app))?.[1] ?? 0);
  if ((await lineNow()) === 0) await app.keyboard.press("ArrowUp");
  for (let line = await lineNow(); line > 1; line--) {
    await app.keyboard.press("ArrowUp");
    await expect.poll(lineNow).toBe(line - 1);
  }
  for (let line = 1; line <= 6; line++) {
    const status = await editorStatus(app);
    if (status.includes(`line ${line} of the drum tab, ${name},`)) return line;
    if (line === 6) break;
    await app.keyboard.press("ArrowDown");
    await expect.poll(lineNow).toBe(line + 1);
  }
  throw new Error(`No ${name} on this beat: ${await editorStatus(app)}`);
}

/** Waits for the beat to draw the same drums twice in a row, and returns them. */
async function settledBeat(app: Page, beat: number): Promise<number[]> {
  let previous = "";
  let drums: number[] = [];
  await expect
    .poll(
      async () => {
        drums = await beatDrums(app, beat);
        const now = JSON.stringify(drums);
        const settled = now === previous && drums.length > 0;
        previous = now;
        return settled ? "settled" : now;
      },
      { timeout: 15_000, intervals: [250] },
    )
    .toBe("settled");
  return drums;
}

const sorted = (drums: number[]) => [...drums].sort((a, b) => a - b);
const escape = (text: string) => text.replace(/[()]/g, "\\$&");

interface Overwrite {
  /** The beat of bar 1 (from 1). */
  beat: number;
  /** The written drum and the name the status line reads for it. */
  old: readonly [number, string];
  /** The drum typed over it. */
  typed: readonly [number, string];
}

/**
 * On a written drum: typing another number replaces it on the same line, typing that number
 * again removes it, and each step is undone by one Undo.
 */
async function overwriteDrum(app: Page, { beat, old, typed }: Overwrite) {
  const [oldDrum, oldName] = old;
  const [typedDrum, typedName] = typed;
  for (let i = 1; i < beat; i++) await app.keyboard.press("ArrowRight");
  await expect.poll(() => editorStatus(app)).toMatch(new RegExp(`^Bar 1, beat ${beat} of 4`));
  const line = await cursorOnDrum(app, oldName);
  const before = await settledBeat(app, beat);
  expect(before).toContain(oldDrum);
  expect(before).not.toContain(typedDrum);
  const oldY = await drumY(app, beat, oldDrum);
  const replaced = sorted([...before.filter((d) => d !== oldDrum), typedDrum]);
  const onLine = (name: string) => new RegExp(`line ${line} of the drum tab, ${escape(name)},`);

  // Typing the new number on the written drum: it takes the old one's place, on the same line.
  await app.keyboard.type(String(typedDrum));
  await expect.poll(() => editorStatus(app)).toMatch(new RegExp(escape(typedName)));
  await expect
    .poll(() => beatDrums(app, beat), { message: `${typedDrum} replaces ${oldDrum}` })
    .toEqual(replaced);
  expect(Math.abs((await drumY(app, beat, typedDrum)) - oldY)).toBeLessThan(2);
  await expect.poll(() => editorStatus(app)).toMatch(onLine(typedName));

  // The same number again removes it; the line stays.
  await app.keyboard.type(String(typedDrum));
  await expect.poll(() => beatDrums(app, beat)).toEqual(before.filter((d) => d !== oldDrum));
  await expect.poll(() => editorStatus(app)).toMatch(onLine("empty"));

  // One Undo per step: first the new drum comes back, then the old one, each on that line.
  await emitMenuAction(app, "undo");
  await expect.poll(() => beatDrums(app, beat)).toEqual(replaced);
  expect(Math.abs((await drumY(app, beat, typedDrum)) - oldY)).toBeLessThan(2);
  await emitMenuAction(app, "undo");
  await expect.poll(() => beatDrums(app, beat)).toEqual(before);
  expect(Math.abs((await drumY(app, beat, oldDrum)) - oldY)).toBeLessThan(2);
}

test.describe("typing on a written drum replaces it (#228)", () => {
  test("a drum track without its own kit: the crash replaces the snare", async ({ app }) => {
    await openSong(app, DRUM_LINES);
    await editDrumTab(app);
    // Beat 3 of bar 1 holds the snare and the closed hi-hat.
    await overwriteDrum(app, {
      beat: 3,
      old: [38, "Snare (hit)"],
      typed: [49, "Crash high (hit)"],
    });
  });

  test("a .gp drum track with its own kit: the open hi-hat replaces the closed one", async ({
    app,
  }) => {
    await openSong(app);
    await editDrumTab(app, "Drums");
    // Beat 1 of bar 1 holds the closed hi-hat and the kick.
    await overwriteDrum(app, {
      beat: 1,
      old: [42, "Hi-Hat (closed)"],
      typed: [46, "Hi-Hat (open)"],
    });
  });
});
