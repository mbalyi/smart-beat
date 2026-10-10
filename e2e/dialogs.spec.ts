import type { Locator, Page } from "@playwright/test";

import { emitMenuAction, expect, openSong, test, waitForAnimations } from "./fixtures";

type Opener = (app: Page) => Promise<void>;

async function trackAction(app: Page, track: string, item: string) {
  await app.getByRole("button", { name: `Actions for ${track}` }).click();
  await app.getByRole("menuitem", { name: item }).click();
}

const DIALOGS: [name: string | RegExp, open: Opener][] = [
  ["Drum mixer: Drums", (app) => trackAction(app, "Drums", "Drum mixer…")],
  ["Pedalboard: Guitar", (app) => trackAction(app, "Guitar", "Effects (pedalboard)…")],
  ["Track settings", (app) => trackAction(app, "Bass", "Settings…")],
  [/^Lyrics/, (app) => trackAction(app, "Guitar", "Lyrics…")],
  ["Keyboard shortcuts", (app) => emitMenuAction(app, "shortcuts")],
  ["Open-source licenses", (app) => emitMenuAction(app, "licenses")],
  [
    "Update available",
    async (app) => {
      // Long notes, so the body has to scroll.
      await app.evaluate(() => {
        window.__update = { version: "0.2.0", body: "- A change in the new version.\n".repeat(60) };
      });
      await emitMenuAction(app, "check-for-updates");
    },
  ],
  ["Import from Audio", (app) => emitMenuAction(app, "import-audio")],
];

/** The dialog's own box must stay inside the viewport, and so must `part`. */
async function inView(app: Page, part: Locator) {
  const box = (await part.boundingBox())!;
  const { height, width } = app.viewportSize()!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
}

/** Every dialog: fixed header and footer, only the body scrolls, never sideways (#53). */
for (const viewport of [
  { width: 1280, height: 600 },
  { width: 390, height: 700 },
]) {
  test.describe(`dialogs at ${viewport.width}×${viewport.height} (#53)`, () => {
    test.use({ viewport });

    for (const [name, open] of DIALOGS) {
      test(`${String(name)}: header and footer stay, the body scrolls`, async ({ app }) => {
        await openSong(app);
        await open(app);
        const dialog = app.getByRole("dialog", { name });
        await expect(dialog).toBeVisible();
        await waitForAnimations(app);

        await inView(app, dialog);
        const body = dialog.locator("[data-slot=dialog-body]");
        await body.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
        await inView(app, dialog.getByRole("heading").first());
        await inView(app, dialog.getByRole("button", { name: "Close", exact: true }).last());
        const footer = dialog.locator("[data-slot=dialog-footer]");
        if (await footer.count()) await inView(app, footer);

        // No horizontal scrolling, in the body or the dialog.
        for (const el of [dialog, body]) {
          expect(await el.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
        }
      });
    }
  });
}
