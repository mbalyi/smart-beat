import type { Page } from "@playwright/test";

import {
  emitMenuAction,
  expect,
  expectNoA11yViolations,
  test,
  waitForAnimations,
} from "./fixtures";

const NOTES = "### Added\n- Check for Updates.\n- An update dialog.";

/** Has the mocked updater plugin find version 0.2.0. */
const offerUpdate = (app: Page) =>
  app.evaluate((body) => {
    window.__update = { version: "0.2.0", body };
  }, NOTES);

const ipcCommands = (app: Page) => app.evaluate(() => window.__ipcCalls.map((call) => call.cmd));

test.describe("updates (#82)", () => {
  test("Help → Check for Updates… says when this is the latest version", async ({ app }) => {
    await emitMenuAction(app, "check-for-updates");

    const dialog = app.getByRole("dialog", { name: "You're up to date" });
    await expect(dialog).toContainText("Smart Beat 0.1.0 is the latest version.");
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
    await expect(dialog).toBeHidden();
  });

  test("shows both versions and the release notes, and installs nothing until asked", async ({
    app,
  }) => {
    await offerUpdate(app);
    await emitMenuAction(app, "check-for-updates");

    const dialog = app.getByRole("dialog", { name: "Update available" });
    await expect(dialog).toContainText("Installed version");
    await expect(dialog).toContainText("0.1.0");
    await expect(dialog).toContainText("Available version");
    await expect(dialog).toContainText("0.2.0");
    await expect(dialog.getByRole("region", { name: "Release notes" })).toContainText(
      "An update dialog.",
    );

    await dialog.getByRole("button", { name: "Later" }).click();
    await expect(dialog).toBeHidden();
    expect(await ipcCommands(app)).not.toContain("plugin:updater|download_and_install");
  });

  test("Download & Install shows progress, cannot be closed, then restarts the app", async ({
    app,
  }) => {
    await offerUpdate(app);
    await app.evaluate(() => (window.__updateHold = true));
    await emitMenuAction(app, "check-for-updates");

    const dialog = app.getByRole("dialog", { name: "Update available" });
    await dialog.getByRole("button", { name: "Download & Install" }).click();

    const downloading = app.getByRole("dialog", { name: "Downloading the update" });
    await expect(downloading.getByRole("progressbar", { name: "Download progress" })).toBeVisible();
    await expect(downloading).toContainText("(33%)");
    // Closing mid-download would leave the update half done.
    await app.keyboard.press("Escape");
    await expect(downloading).toBeVisible();
    expect(await ipcCommands(app)).not.toContain("plugin:process|restart");

    await app.evaluate(() => window.__releaseUpdate?.());
    await expect.poll(() => ipcCommands(app)).toContain("plugin:process|restart");
    await expect(app.getByRole("dialog", { name: "Installing the update" })).toBeVisible();
  });

  test("reports a failed check, and Try again checks once more", async ({ app }) => {
    await app.evaluate(() => {
      window.__updateError = { during: "check", message: "Could not fetch a valid release JSON." };
    });
    await emitMenuAction(app, "check-for-updates");

    const dialog = app.getByRole("dialog", { name: "Couldn't update Smart Beat" });
    await expect(dialog.getByRole("alert")).toContainText("Could not fetch a valid release JSON.");

    await app.evaluate(() => (window.__updateError = null));
    await dialog.getByRole("button", { name: "Try again" }).click();
    await expect(app.getByRole("dialog", { name: "You're up to date" })).toBeVisible();
  });

  test("the in-window Help menu has Check for Updates…", async ({ app }) => {
    await app.getByRole("button", { name: "Help" }).click();
    await app.getByRole("menuitem", { name: "Check for Updates…" }).click();

    await expect(app.getByRole("dialog", { name: "You're up to date" })).toBeVisible();
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the update dialogs have no WCAG violations in ${colorScheme} mode`, async ({ app }) => {
      await app.emulateMedia({ colorScheme });
      await offerUpdate(app);
      await app.evaluate(() => (window.__updateHold = true));
      await emitMenuAction(app, "check-for-updates");

      await expect(app.getByRole("dialog", { name: "Update available" })).toBeVisible();
      await waitForAnimations(app);
      await expectNoA11yViolations(app);

      await app.getByRole("button", { name: "Download & Install" }).click();
      await expect(app.getByRole("progressbar", { name: "Download progress" })).toBeVisible();
      await expectNoA11yViolations(app);
    });
  }
});
