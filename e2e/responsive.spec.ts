import { emitMenuAction, expect, openSong, test } from "./fixtures";

const VIEWPORTS = [
  { name: "narrow window", width: 375, height: 700, columns: 1 },
  { name: "medium window", width: 768, height: 800, columns: 2 },
  { name: "wide window", width: 1280, height: 800, columns: 3 },
] as const;

/** Song screen at every size, down to the app's minimum window (480×360). */
for (const { width, height } of [...VIEWPORTS, { width: 480, height: 360 }]) {
  test.describe(`song screen at ${width}×${height}`, () => {
    test.use({ viewport: { width, height } });

    test("keeps the controls and the score on screen without page scrolling", async ({ app }) => {
      await openSong(app);

      const overflow = await app.evaluate(() => ({
        x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      }));
      expect(overflow.x).toBeLessThanOrEqual(0);
      expect(overflow.y).toBeLessThanOrEqual(0); // the score scrolls inside its region
      for (const name of ["Mixer", "Play", "Stop"]) {
        await expect(app.getByRole("button", { name })).toBeInViewport();
      }
      const region = await app.getByRole("region", { name: /^Score:/ }).boundingBox();
      expect(region!.height).toBeGreaterThan(40);
    });

    test("fits the mixer inside the window", async ({ app }) => {
      await openSong(app);
      await app.getByRole("button", { name: "Mixer" }).click();

      const mixer = app.getByRole("dialog", { name: "Mixer" });
      // Measure once it has finished sliding in.
      await expect
        .poll(async () => {
          const box = (await mixer.boundingBox())!;
          return Math.round(box.x + box.width);
        })
        .toBeLessThanOrEqual(width);
      const box = (await mixer.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
    });
  });
}

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
