import type { Page } from "@playwright/test";

import { expect, newSong, test, waitForAnimations } from "./fixtures";

/**
 * The icons of the edit palette sit on one vertical line: the middle of what a cell draws (the
 * ink of a glyph, a mark or a time signature, not its text box) is on the middle of the cell. The
 * glyphs are of very different heights, so each one is shifted by its measured size
 * (`SMUFL_INK` in `src/lib/score/smufl-ink.ts`); this checks the result in a real browser.
 */

/** How far each icon's ink is from the middle of its cell (px), measured in the page. */
async function offsets(page: Page, rootSelector: string) {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) return [];
    const ctx = document.createElement("canvas").getContext("2d")!;
    const result: { label: string; dy: number }[] = [];
    for (const button of root.querySelectorAll<HTMLElement>('[data-slot="palette-button"]')) {
      const cell = button.getBoundingClientRect();
      if (!cell.width) continue;
      let top = Infinity;
      let bottom = -Infinity;
      // The ink of the text nodes: the baseline from a zero-size probe, the extent from canvas.
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        const text = node.nodeValue?.trim();
        if (!parent || !text) continue;
        const style = getComputedStyle(parent);
        ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const metrics = ctx.measureText(text);
        const probe = document.createElement("span");
        probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
        parent.appendChild(probe);
        const baseline = probe.getBoundingClientRect().bottom;
        parent.removeChild(probe);
        top = Math.min(top, baseline - metrics.actualBoundingBoxAscent);
        bottom = Math.max(bottom, baseline + metrics.actualBoundingBoxDescent);
      }
      for (const svg of button.querySelectorAll("svg")) {
        const box = svg.getBoundingClientRect();
        if (!box.width) continue;
        top = Math.min(top, box.top + box.height * 0.1);
        bottom = Math.max(bottom, box.bottom - box.height * 0.1);
      }
      if (!Number.isFinite(top)) continue;
      result.push({
        label: button.getAttribute("aria-label") ?? "?",
        dy: (top + bottom) / 2 - (cell.top + cell.bottom) / 2,
      });
    }
    return result;
  }, rootSelector);
}

/** Within a pixel and a half: the fonts of two browsers measure a little differently. */
const TOLERANCE = 1.5;

const offCentre = (list: { label: string; dy: number }[]) =>
  list.filter((item) => Math.abs(item.dy) > TOLERANCE).map((i) => `${i.label}: ${i.dy.toFixed(1)}`);

test.describe("edit palette icons", () => {
  test("every cell and every box variant is centred on its cell", async ({ app }) => {
    test.slow();
    await newSong(app);
    const palette = app.getByRole("complementary", { name: "Note palette" });
    await expect(palette).toBeVisible();
    await waitForAnimations(app);
    await app.evaluate(() => document.fonts.ready);

    const cells = await offsets(app, "aside[aria-label='Note palette']");
    expect(cells.length).toBeGreaterThan(50);
    expect(offCentre(cells)).toEqual([]);

    const triggers = palette.locator("[aria-haspopup='true']");
    const count = await triggers.count();
    expect(count).toBeGreaterThan(15);
    const box = app.locator(".palette-box");
    for (let i = 0; i < count; i++) {
      const name = (await triggers.nth(i).getAttribute("aria-label")) ?? `box ${i}`;
      await triggers.nth(i).click();
      await expect(box).toBeVisible();
      await box.evaluate((el) =>
        Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))),
      );
      const variants = await offsets(app, ".palette-box");
      expect(variants.length, name).toBeGreaterThan(0);
      expect.soft(offCentre(variants), name).toEqual([]);
      await app.keyboard.press("Escape");
      await expect(box).toHaveCount(0);
    }
  });

  test("a box scrolls only when it is taller than the window", async ({ app }) => {
    await newSong(app);
    const palette = app.getByRole("complementary", { name: "Note palette" });
    await expect(palette).toBeVisible();
    await palette.getByRole("button", { name: /^Articulation/ }).click();
    const box = app.locator(".palette-box");
    await expect(box).toBeVisible();
    await box.evaluate((el) =>
      Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))),
    );
    expect(await box.evaluate((el) => getComputedStyle(el).overflowY)).toBe("visible");
  });

  test("the categories have small headers", async ({ app }) => {
    await newSong(app);
    const palette = app.getByRole("complementary", { name: "Note palette" });
    await expect(palette).toBeVisible();
    const headings = await palette.locator("[data-palette-heading]").allTextContents();
    expect(headings).toEqual([
      "Bar",
      "Notes",
      "Rhythm",
      "Beats",
      "Accidentals",
      "Dynamics",
      "Marks",
      "Techniques",
      "Picking",
      "Text and help",
    ]);
  });
});
