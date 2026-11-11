import type { Page } from "@playwright/test";

import { expect, openSong, scoreRegion, test, waitForAnimations, waitForScore } from "./fixtures";

/**
 * Several bars selected in edit mode while two tracks are stacked in one system (#228): the
 * renderer's own selection and cursor highlight (tall grey/blue bars, one per beat, over the
 * whole system height) stays hidden, and only the editor's purple selection is drawn. Checked at
 * the 2x scale of a Retina Mac, where the tall bars were seen.
 */
test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });

const mixer = (page: Page) => page.getByRole("region", { name: "Tracks and mixer" });

/** Everything alphaTab adds next to the drawn notation (cursors, range highlight, ...) that shows. */
function visibleRendererOverlays(app: Page) {
  return scoreRegion(app)
    .locator(".alphaTab")
    .evaluate((root) =>
      [...root.querySelectorAll("*")]
        .filter((el) => !(el instanceof SVGElement) && !el.closest("svg"))
        // The drawn notation itself: the surface and the chunks it is split into.
        .filter((el) => !el.matches(".at-surface, .at-surface *, .at-cursors"))
        .filter((el) => {
          const box = el.getBoundingClientRect();
          return (
            box.width > 0 &&
            box.height > 0 &&
            el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
          );
        })
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`),
    );
}

async function stackGuitarAndDrums(
  app: Page,
  layout: "Continuous" | "Page",
  edited: "Guitar" | "Drums" = "Guitar",
) {
  await openSong(app);
  await app.getByRole("radio", { name: layout }).click();
  await mixer(app).getByRole("button", { name: "Visible: Drums" }).click();
  if (edited === "Drums") {
    await mixer(app)
      .getByRole("button", { name: /^Show Drums/ })
      .click();
  }
  await waitForScore(app);
  await app.getByRole("button", { name: "Edit", exact: true }).click();
  await waitForAnimations(app);
}

/** Centres of the tab numbers drawn in the score, in score order (the tempo marks come first). */
async function guitarTabNumbers(app: Page) {
  return scoreRegion(app)
    .locator(".at-surface svg text")
    .evaluateAll((texts) =>
      texts
        .filter((t) => /^\d+$/.test(t.textContent?.trim() ?? ""))
        .map((el) => {
          const text = el as SVGTextElement;
          const svg = text.ownerSVGElement!.getBoundingClientRect();
          const box = text.getBBox();
          return { x: svg.x + box.x + box.width / 2, y: svg.y + box.y + box.height / 2 };
        }),
    );
}

async function expectOnlyEditorSelection(app: Page) {
  await expect(app.getByTestId("edit-selection")).not.toHaveCount(0);
  for (const mark of await app.getByTestId("edit-selection").all())
    await expect(mark).toBeVisible();
  expect(await visibleRendererOverlays(app)).toEqual([]);
}

for (const layout of ["Continuous", "Page"] as const) {
  test.describe(`${layout} layout, guitar and drums stacked`, () => {
    test("selecting bars by dragging shows only the editor's selection", async ({ app }, info) => {
      await stackGuitarAndDrums(app, layout);
      const notes = await guitarTabNumbers(app);
      const from = notes[4]!; // the guitar's first tab number (the first four are tempo marks)
      const to = notes[14]!;
      await app.mouse.move(from.x, from.y);
      await app.mouse.down();
      for (let i = 1; i <= 10; i++) {
        await app.mouse.move(
          from.x + ((to.x - from.x) * i) / 10,
          from.y + ((to.y - from.y) * i) / 10,
        );
      }
      await app.mouse.up();
      await app.waitForTimeout(600); // alphaTab and the practice state settle
      await expectOnlyEditorSelection(app);
      await info.attach("selection", { body: await app.screenshot(), contentType: "image/png" });
    });

    for (const edited of ["Guitar", "Drums"] as const) {
      test(`selecting bars of the ${edited} with Shift+Arrow shows only the editor's selection`, async ({
        app,
      }, info) => {
        await stackGuitarAndDrums(app, layout, edited);
        await scoreRegion(app).focus();
        await app.keyboard.press("Home");
        await app.keyboard.down("Shift");
        for (let i = 0; i < 9; i++) await app.keyboard.press("ArrowRight");
        await app.keyboard.up("Shift");
        await app.waitForTimeout(600);
        await expectOnlyEditorSelection(app);
        await info.attach("selection", { body: await app.screenshot(), contentType: "image/png" });
      });
    }
  });
}
