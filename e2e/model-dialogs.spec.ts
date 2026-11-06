import type { Page } from "@playwright/test";

import features from "../src/lib/features.json" with { type: "json" };

import { emitMenuAction, expect, expectNoA11yViolations, test } from "./fixtures";

/**
 * The two model dialogs of the AI menu: Stem Separation Models and Record to Tab Models. The
 * native commands are mocked in e2e/tauri-mock.js; the menu click is simulated with
 * `emitMenuAction`.
 */

test.skip(
  !features["stem-separation-neural"] || !features["muscriptor-record"],
  "the model flags are off in src/lib/features.json",
);

/** The page globals the mock keeps (typed here, so that no other spec's declaration clashes). */
interface MockGlobals {
  __stemModels: {
    downloads: string[];
    removed: string[];
    hold: boolean;
    release: (() => void) | null;
  };
  __pianoModel: { installed: boolean; downloads: number; removed: number };
  __muscriptor: { deleted: string[]; installed: Record<string, boolean> };
}
/** Runs `fn` in the page with its window (the function is sent as text, so it cannot use closures). */
const inPage = <T>(app: Page, fn: (w: MockGlobals) => T): Promise<T> =>
  app.evaluate(`(${fn.toString()})(window)`) as Promise<T>;

async function openStemModels(app: Page) {
  await emitMenuAction(app, "stem-models");
  const dialog = app.getByRole("dialog", { name: "Stem Separation Models" });
  await expect(dialog).toBeVisible();
  // The statuses are read when it opens.
  await expect(dialog.getByTestId("model-row-htdemucs")).toContainText("Download");
  return dialog;
}

async function openRecordModels(app: Page) {
  await emitMenuAction(app, "record-models");
  const dialog = app.getByRole("dialog", { name: "Record to Tab Models" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("model-row-transkun")).toContainText("Download");
  return dialog;
}

test.describe("Stem Separation Models", () => {
  test("opens from the AI menu with every engine, its strength, its cost and its size", async ({
    app,
  }) => {
    const dialog = await openStemModels(app);
    await expect(dialog.getByText("Used by Stem separation")).toBeVisible();
    await expect(dialog.locator("[data-testid^=model-row-]")).toHaveCount(6);
    await expect(dialog.getByTestId("model-row-htdemucs")).toContainText("Recommended");
    await expect(dialog.getByTestId("model-row-htdemucs")).toContainText("Download 168 MB");
    await expect(dialog.getByTestId("model-row-htdemucs-6s")).toContainText("HTDemucs 6-part");
    await expect(dialog.getByTestId("model-row-htdemucs-6s")).toContainText("Download 111 MB");
    await expect(dialog.getByTestId("model-row-scnet-xl")).toContainText("Best for vocals");
    await expect(dialog.getByTestId("model-row-fast")).toContainText("Built in");
    await dialog.getByRole("button", { name: "Close" }).last().click();
    await expect(dialog).toBeHidden();
  });

  test("installs a model with its terms and progress, then deletes it with a second click", async ({
    app,
  }) => {
    await inPage(app, (w) => {
      w.__stemModels.hold = true;
    });
    const dialog = await openStemModels(app);
    await dialog.getByRole("button", { name: "Install the SCNet Small model" }).click();
    await expect(dialog.getByTestId("stem-neural-setup")).toContainText("Terms of SCNet Small");
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Accept and download" }).click();
    await expect(dialog.getByRole("progressbar", { name: "Download progress" })).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    // The window stays while it downloads.
    await app.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await inPage(app, (w) => {
      w.__stemModels.release?.();
    });
    const row = dialog.getByTestId("model-row-scnet");
    await expect(row).toContainText("Installed");

    await row.getByRole("button", { name: "Delete the SCNet Small model" }).click();
    expect(await inPage(app, (w) => w.__stemModels.removed)).toEqual([]);
    await row.getByRole("button", { name: "Keep" }).click();
    await row.getByRole("button", { name: "Delete the SCNet Small model" }).click();
    await row.getByRole("button", { name: "Delete SCNet Small" }).click();
    await expect(row).toContainText("Not installed");
    expect(await inPage(app, (w) => w.__stemModels.removed)).toEqual(["scnet"]);
  });
});

test.describe("Record to Tab Models", () => {
  test("opens from the AI menu with MuScriptor, the piano model and what is built in", async ({
    app,
  }) => {
    const dialog = await openRecordModels(app);
    await expect(dialog.getByText("Used by Record to tab and Import from Audio")).toBeVisible();
    for (const size of ["Small", "Medium", "Large"]) {
      await expect(dialog.getByText(`MuScriptor ${size}`)).toBeVisible();
    }
    await expect(dialog.getByTestId("model-row-transkun")).toContainText("Not installed");
    await expect(dialog.getByTestId("model-row-basic-pitch")).toContainText("nothing to install");
    await expect(dialog.getByTestId("model-row-drum-hits")).toContainText("nothing to install");
  });

  test("installs and deletes the piano model in place", async ({ app }) => {
    const dialog = await openRecordModels(app);
    const row = dialog.getByTestId("model-row-transkun");
    await row.getByRole("button", { name: "Install the Transkun piano model" }).click();
    await expect(row).toContainText("Installed");
    expect(await inPage(app, (w) => w.__pianoModel.downloads)).toBe(1);
    await row.getByRole("button", { name: "Delete the Transkun piano model" }).click();
    await row.getByRole("button", { name: "Delete Transkun piano" }).click();
    await expect(row).toContainText("Not installed");
    expect(await inPage(app, (w) => w.__pianoModel.removed)).toBe(1);
  });

  test("a MuScriptor size installs through the guided installer and comes back here", async ({
    app,
  }) => {
    const dialog = await openRecordModels(app);
    await dialog.getByRole("button", { name: "Install the Small model" }).click();
    await expect(dialog).toBeHidden();

    const installer = app.getByTestId("ai-installer");
    await installer.getByRole("button", { name: "Choose a model" }).click();
    await expect(installer.getByRole("radio", { name: /Small/ })).toBeChecked();
    await installer.getByRole("button", { name: "Continue" }).click();
    await installer.getByRole("link", { name: /Read the model card/ }).click();
    await installer.getByRole("checkbox", { name: /accepted the MuScriptor weight terms/ }).check();
    await installer
      .getByRole("checkbox", { name: /only use MuScriptor with my own music/ })
      .check();
    await installer.getByRole("button", { name: "Continue" }).click();
    await expect(installer.getByRole("heading", { name: "Everything is set up" })).toBeVisible();
    await installer.getByRole("button", { name: "Back to Record to Tab Models" }).click();

    const back = app.getByRole("dialog", { name: "Record to Tab Models" });
    await expect(back).toBeVisible();
    const small = back.getByTestId("model-row-muscriptor-small");
    await expect(small).toContainText("Installed");
    await expect(small).toContainText("In use");

    await small.getByRole("button", { name: "Delete the Small model" }).click();
    await small.getByRole("button", { name: "Delete Small" }).click();
    await expect(small).toContainText("Not installed");
    expect(await inPage(app, (w) => w.__muscriptor.deleted)).toEqual(["small"]);
  });
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [1280, 375]) {
    test(`both model dialogs have no WCAG violations at ${width} px in ${colorScheme} mode`, async ({
      app,
    }) => {
      await app.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await app.emulateMedia({ colorScheme });
      await inPage(app, (w) => {
        w.__pianoModel.installed = true;
        w.__muscriptor.installed.medium = true;
      });

      const stems = await openStemModels(app);
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
      await stems.getByRole("button", { name: "Install the SCNet Small model" }).click();
      await expect(stems.getByTestId("stem-neural-setup")).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
      expect(await stems.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
      await stems.getByRole("button", { name: "Not now" }).click();
      await app.keyboard.press("Escape");
      await expect(stems).toBeHidden();

      const record = await openRecordModels(app);
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
      await record.getByRole("button", { name: "Delete the Transkun piano model" }).click();
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
      expect(await record.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
    });
  }
}
