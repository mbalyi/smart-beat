import type { Page } from "@playwright/test";

import { expect, openSong, scoreRegion, test, waitForAnimations } from "./fixtures";

/** Centres of the tab numbers drawn for the shown track, in score order. */
async function tabNoteCenters(app: Page) {
  return scoreRegion(app)
    .locator(".at-surface svg text")
    .evaluateAll((texts) =>
      texts
        .filter(
          (t) => t.getAttribute("fill") !== "#C80000" && /^\d+$/.test(t.textContent?.trim() ?? ""),
        )
        .map((el) => {
          const text = el as SVGTextElement;
          const svg = text.ownerSVGElement!.getBoundingClientRect();
          const box = text.getBBox();
          return { x: svg.x + box.x + box.width / 2, y: svg.y + box.y + box.height / 2 };
        }),
    );
}

async function drag(app: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await app.mouse.move(from.x, from.y);
  await app.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await app.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
  }
  await app.mouse.up();
}

/** alphaTab's highlight of a range dragged outside edit mode. */
const highlight = (app: Page) => app.locator(".at-selection div");

/** A mouse selection stays after the button is released (#53). */
test.describe("drag selection (#53)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("keeps a multi-bar selection after the mouse is released", async ({ app }) => {
    await openSong(app);
    const notes = await tabNoteCenters(app);
    await drag(app, notes[1]!, notes[9]!); // bar 1 to bar 3

    // Give alphaTab and the practice state time to settle: it must still be there.
    await app.waitForTimeout(600);
    await expect(highlight(app)).not.toHaveCount(0);

    // The same beats are selected for editing.
    await app.getByRole("button", { name: "Edit" }).click();
    await expect(app.getByTestId("edit-selection")).not.toHaveCount(0);
    expect(await app.getByTestId("edit-selection").count()).toBeGreaterThanOrEqual(3);
  });

  test("keeps a partial selection of a few notes, and Escape clears it", async ({ app }) => {
    await openSong(app);
    const notes = await tabNoteCenters(app);
    await drag(app, notes[0]!, notes[2]!); // three notes of bar 1
    await app.waitForTimeout(600);
    await expect(highlight(app)).not.toHaveCount(0);

    await app.keyboard.press("Escape");
    await expect(highlight(app)).toHaveCount(0);
  });

  test("keeps the selection in edit mode, and a click elsewhere clears it", async ({ app }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Edit" }).click();
    await waitForAnimations(app); // the palette slides in and moves the score
    const notes = await tabNoteCenters(app);
    await drag(app, notes[1]!, notes[6]!);
    await app.waitForTimeout(600);
    await expect(app.getByTestId("edit-selection")).not.toHaveCount(0);

    await app.mouse.click(notes[10]!.x, notes[10]!.y);
    await expect(app.getByTestId("edit-selection")).toHaveCount(0);
  });
});
