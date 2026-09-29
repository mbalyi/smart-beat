import { emitMenuAction, expect, test } from "./fixtures";

const VIEWPORTS = [
  { name: "narrow window", width: 375, height: 700, columns: 1 },
  { name: "medium window", width: 768, height: 800, columns: 2 },
  { name: "wide window", width: 1280, height: 800, columns: 3 },
] as const;

for (const { name, width, height, columns } of VIEWPORTS) {
  test.describe(`${name} (${width}px)`, () => {
    test.use({ viewport: { width, height } });

    test("has no horizontal scrolling", async ({ app }) => {
      const overflow = await app.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });

    test(`lays out feature cards in ${columns} column(s)`, async ({ app }) => {
      const cards = app.getByRole("list").getByRole("listitem");
      await expect(cards).toHaveCount(3);

      const tops = await cards.evaluateAll((items) =>
        items.map((item) => Math.round(item.getBoundingClientRect().top)),
      );
      const firstRow = tops.filter((top) => top === tops[0]).length;
      expect(firstRow).toBe(columns);
    });

    test("keeps header controls reachable", async ({ app }) => {
      await expect(app.getByRole("button", { name: "Theme" })).toBeInViewport();
      await expect(app.getByRole("button", { name: "Help" })).toBeInViewport();
    });

    test("fits dialogs inside the window", async ({ app }) => {
      await emitMenuAction(app, "shortcuts");
      const dialog = app.getByRole("dialog");
      await expect(dialog).toBeVisible();

      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(height);
    });
  });
}
