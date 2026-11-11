import type { Page } from "@playwright/test";

import {
  editorStatus,
  emitMenuAction,
  expect,
  newSong,
  openSong,
  scoreRegion,
  test,
  waitForAnimations,
} from "./fixtures";

/**
 * A click on any line of a tab staff in edit mode puts the edit cursor on that line (#228), also
 * where nothing is written yet: the string line of a guitar tab and the line of a drum tab. The
 * app runs in WKWebView on a retina screen, so every test draws at a device pixel ratio of 2.
 * The positions of the lines are measured from the drawn staff, not taken from the app, and the
 * clicks land on those pixels. Covered: a guitar and a drum track, on a beat that has a note and
 * on an empty one, shown alone or stacked with the other track in the continuous view (clicking
 * the edited track or the other one), as "Score + tab" and as "Tab", in both layouts, zoomed, and
 * with or without a multi-bar selection made with the keyboard.
 */
test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });
// Every case clicks and types on several lines, and each edit draws the score again.
test.describe.configure({ timeout: 120_000 });

const mixer = (app: Page) => app.getByRole("region", { name: "Tracks and mixer" });

type Notation = "Score + tab" | "Tab";
type Layout = "Page" | "Continuous";
type Instrument = "guitar" | "drums";

const TRACK = { guitar: "Guitar", drums: "Drums" } as const;
const OTHER = { guitar: "drums", drums: "guitar" } as const;
/** What is typed on a line, per instrument: the keys and the number the tab then draws. */
const TYPED = { guitar: { keys: "7", drawn: "7" }, drums: { keys: "49", drawn: "49" } } as const;
/** The lines clicked (1 = top): in the middle, at the bottom, at the top, near the bottom. */
const LINES = [3, 6, 1, 5];

/** The tab staves drawn (six lines each), top staff first: the centre of each line. */
async function tabStaves(app: Page): Promise<number[][]> {
  return scoreRegion(app)
    .locator(".at-surface svg")
    .evaluateAll((svgs) => {
      // A staff line is drawn as pieces between the numbers; a ledger line is shorter.
      const ys = svgs
        .flatMap((svg) => [...svg.querySelectorAll("rect")])
        .map((rect) => rect.getBoundingClientRect())
        .filter((box) => box.width > 40 && box.height < 3)
        .map((box) => Math.round((box.y + box.height / 2) * 10) / 10);
      const lines = [...new Set(ys)].sort((a, b) => a - b);
      // The lines of a staff are evenly spaced: a different gap starts the next staff.
      const staves: number[][] = [];
      lines.forEach((y, i) => {
        const staff = staves[staves.length - 1];
        const spacing = staff && staff.length > 1 ? staff[1]! - staff[0]! : null;
        const gap = i > 0 ? y - lines[i - 1]! : 0;
        if (staff && (spacing === null ? gap < 20 : Math.abs(gap - spacing) < 2)) staff.push(y);
        else staves.push([y]);
      });
      return staves.filter((staff) => staff.length === 6);
    });
}

/** The tab numbers `text` drawn in the score: the middle of each. */
async function numberCentres(app: Page, text: string): Promise<{ x: number; y: number }[]> {
  return scoreRegion(app)
    .locator(".at-surface svg text")
    .evaluateAll((texts, wanted) => {
      const BAR_NUMBER_FILLS = ["#C80000", "#FF8A80"]; // light and dark mode
      return texts
        .filter((t) => t.textContent?.trim() === wanted)
        .filter((t) => !BAR_NUMBER_FILLS.includes(t.getAttribute("fill") ?? ""))
        .map((t) => {
          const box = t.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        });
    }, text);
}

/** The middle of the edit cursor's outline. */
async function cursorOutline(app: Page): Promise<{ x: number; y: number }> {
  const box = (await app.getByTestId("edit-cursor-note").first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * The tab staves and the x position of the cursor's beat once the drawing has stopped moving (a
 * redraw after an edit changes the staff's height).
 */
async function settledLayout(app: Page): Promise<{ staves: number[][]; x: number }> {
  let previous = "";
  let layout = { staves: [] as number[][], x: 0 };
  await expect
    .poll(
      async () => {
        layout = { staves: await tabStaves(app), x: (await cursorOutline(app)).x };
        const now = JSON.stringify(layout);
        const settled = now === previous && layout.staves.length > 0;
        previous = now;
        return settled;
      },
      { timeout: 10_000, intervals: [200] },
    )
    .toBe(true);
  return layout;
}

/** The line of the tab (1 = top) the status line puts the cursor on, or 0 when it names none. */
async function cursorLine(app: Page, instrument: Instrument): Promise<number> {
  const pattern = instrument === "guitar" ? /string (\d)/ : /line (\d) of the drum tab/;
  return Number(pattern.exec(await editorStatus(app))?.[1] ?? 0);
}

/** The line (1 = top) of the staff, among `staves`, that is nearest to a height. */
function nearestLine(staves: readonly (readonly number[])[], y: number): number {
  const distance = (staff: readonly number[]) => Math.min(...staff.map((l) => Math.abs(l - y)));
  const staff = [...staves].sort((a, b) => distance(a) - distance(b))[0]!;
  return (
    staff.indexOf(staff.reduce((best, l) => (Math.abs(l - y) < Math.abs(best - y) ? l : best))) + 1
  );
}

interface Case {
  instrument: Instrument;
  notation: Notation;
  layout: Layout;
  /** The song has music on the beat (the practice song) or is new and empty. */
  song: "written" | "empty";
  /** The other track is stacked with it in the continuous view. */
  stacked?: boolean;
  /** Click the stacked track instead of the edited one. */
  other?: boolean;
  /** A selection over several bars is active when the click lands. */
  selected?: boolean;
  /** Zoom steps in. */
  zoom?: number;
}

/** Opens the song as the case asks, in edit mode, with the cursor on the first beat. */
async function startEditing(app: Page, c: Case) {
  if (c.song === "written") {
    await openSong(app);
  } else {
    await newSong(app); // starts in edit mode
    await emitMenuAction(app, "add-track");
    const dialog = app.getByRole("dialog", { name: "Add track" });
    await dialog.getByRole("combobox", { name: "Instrument" }).click();
    await app.getByRole("option", { name: "Drums", exact: true }).click();
    await dialog.getByRole("button", { name: "Add track" }).click();
    await expect(dialog).toBeHidden();
  }
  await mixer(app)
    .getByRole("button", { name: new RegExp(`^Show ${TRACK[c.instrument]}`) })
    .click();
  await expect(scoreRegion(app)).toHaveAccessibleName(`Score: ${TRACK[c.instrument]}`);
  await app
    .getByRole("radiogroup", { name: "Notation" })
    .getByRole("radio", { name: c.notation, exact: true })
    .click();
  await app
    .getByRole("radiogroup", { name: "Layout" })
    .getByRole("radio", { name: c.layout, exact: true })
    .click();
  for (let i = 0; i < (c.zoom ?? 0); i++) {
    await app.getByRole("button", { name: "Zoom in" }).click();
  }
  const otherVisible = mixer(app).getByRole("button", {
    name: `Visible: ${TRACK[OTHER[c.instrument]]}`,
  });
  if (c.stacked) {
    await otherVisible.click();
  } else if (c.song === "empty" && c.layout === "Continuous") {
    // The tracks of a new song start stacked in the continuous view: show only the clicked one.
    if ((await otherVisible.getAttribute("aria-pressed")) === "true") await otherVisible.click();
  }
  if (c.song === "written") await app.getByRole("button", { name: "Edit" }).click();
  await expect(app.getByRole("toolbar", { name: "Edit" })).toBeVisible();
  await waitForAnimations(app);
  await scoreRegion(app).focus();
  await expect.poll(() => editorStatus(app)).toMatch(/^Bar 1, beat 1 of \d/);
}

/**
 * Clicks every line of a tab at a beat and checks that the cursor lands on it, that the outline
 * is drawn there and that a number typed is written on that line.
 */
async function expectLineClicks(app: Page, c: Case) {
  const beat = c.song === "written" ? 2 : 1;
  await startEditing(app, c);
  for (let i = 1; i < beat; i++) await app.keyboard.press("ArrowRight");
  await expect.poll(() => editorStatus(app)).toMatch(new RegExp(`^Bar 1, beat ${beat} of \\d`));

  // The instrument whose lines are clicked: with `other`, the stacked one, which then becomes the
  // edited one and keeps its place in the stack (the second staff).
  const clicked = c.other ? OTHER[c.instrument] : c.instrument;
  for (const line of LINES) {
    // Where the lines and the beat are drawn now: an edit can make the staff taller.
    const { staves, x } = await settledLayout(app);
    const staff = staves[c.other ? 1 : 0];
    expect(staff, "the tab staff of the clicked track").toBeDefined();
    const y = staff![line - 1]!;
    const spacing = staff![1]! - staff![0]!;
    if (c.selected) {
      // Shift+Right from the beat reaches into bar 2: the selection spans two bars.
      for (let i = 0; i < 5; i++) await app.keyboard.press("Shift+ArrowRight");
      await expect(app.getByTestId("edit-selection")).not.toHaveCount(0);
    }

    await app.mouse.click(x, y);
    await expect
      .poll(() => cursorLine(app, clicked), { message: `a click on line ${line}` })
      .toBe(line);
    await expect(scoreRegion(app)).toHaveAccessibleName(`Score: ${TRACK[clicked]}`);
    await expect.poll(() => editorStatus(app)).toMatch(new RegExp(`^Bar 1, beat ${beat} of \\d`));
    expect(Math.abs((await cursorOutline(app)).y - y), `outline of line ${line}`).toBeLessThan(
      spacing / 2,
    );
    await expect(app.getByTestId("edit-selection")).toHaveCount(0); // a click clears it

    // Typing writes on that line.
    const { keys, drawn } = TYPED[clicked];
    await app.keyboard.type(keys);
    await expect
      .poll(async () => (await numberCentres(app, drawn)).length, { message: `typed ${keys}` })
      .toBeGreaterThan(0);
    const written = (await settledLayout(app)).staves;
    const [number] = await numberCentres(app, drawn);
    expect(nearestLine(written, number!.y), `${keys} typed on line ${line}`).toBe(line);
    await emitMenuAction(app, "undo");
    await expect.poll(async () => (await numberCentres(app, drawn)).length).toBe(0);
  }
}

const NOTATIONS: Notation[] = ["Score + tab", "Tab"];
const LAYOUTS: Layout[] = ["Page", "Continuous"];
const INSTRUMENTS: Instrument[] = ["guitar", "drums"];

for (const instrument of INSTRUMENTS) {
  test.describe(`a click on a line of the ${instrument} tab puts the cursor there`, () => {
    for (const notation of NOTATIONS) {
      for (const layout of LAYOUTS) {
        for (const selected of [false, true]) {
          const suffix = selected ? ", with a selection" : "";
          test(`on a written beat (${notation}, ${layout}${suffix})`, async ({ app }) => {
            await expectLineClicks(app, {
              instrument,
              notation,
              layout,
              song: "written",
              selected,
            });
          });
        }
        test(`on an empty beat (${notation}, ${layout})`, async ({ app }) => {
          await expectLineClicks(app, { instrument, notation, layout, song: "empty" });
        });
      }

      for (const other of [false, true]) {
        for (const selected of [false, true]) {
          const which = other ? "the other track" : "the edited track";
          const suffix = selected ? ", with a selection" : "";
          test(`stacked with another track: ${which} (${notation}${suffix})`, async ({ app }) => {
            await expectLineClicks(app, {
              instrument,
              notation,
              layout: "Continuous",
              song: "written",
              stacked: true,
              other,
              selected,
            });
          });
        }
      }

      test(`zoomed in (${notation})`, async ({ app }) => {
        await expectLineClicks(app, {
          instrument,
          notation,
          layout: "Page",
          song: "written",
          zoom: 2,
        });
      });
    }
  });
}
