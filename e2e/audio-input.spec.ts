import type { Page } from "@playwright/test";

import { expect, expectNoA11yViolations, openSong, test } from "./fixtures";

/** The audio input, chosen once in Settings for the whole app; the tuner listens to it. */

/** Two inputs instead of the browser's own (headless browsers have none worth listing). */
async function installInputs(page: Page) {
  await page.addInitScript(() => {
    const inputs = [
      { kind: "audioinput", deviceId: "built-in", label: "MacBook Pro Microphone", groupId: "" },
      { kind: "audioinput", deviceId: "scarlett", label: "Scarlett 2i2 USB", groupId: "" },
    ];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => inputs,
        getUserMedia: async () => {
          throw new DOMException("Not in this test", "NotAllowedError");
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
  });
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Help" }).click();
  await page.getByRole("menuitem", { name: "Settings…" }).click();
  return page.getByRole("dialog", { name: "Settings" });
}

test.describe("audio input", () => {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`Settings lists the inputs, in ${colorScheme} mode`, async ({ app }) => {
      await app.emulateMedia({ colorScheme });
      await installInputs(app);
      const settings = await openSettings(app);
      const input = settings.getByRole("combobox", { name: "Input" });
      await expect(input).toHaveText("System default");
      await expectNoA11yViolations(app);

      await input.click();
      await expect(app.getByRole("option")).toHaveText([
        "System default",
        "MacBook Pro Microphone",
        "Scarlett 2i2 USB",
      ]);
      await expectNoA11yViolations(app, { popup: "[role=listbox]" });
    });
  }

  test("the tuner uses the input chosen in Settings, and links back to it", async ({ app }) => {
    await installInputs(app);
    let settings = await openSettings(app);
    await settings.getByRole("combobox", { name: "Input" }).click();
    await app.getByRole("option", { name: "Scarlett 2i2 USB" }).click();
    await app.keyboard.press("Escape");
    await expect(settings).toBeHidden();

    // Remembered for the next start.
    await installInputs(app);
    await openSong(app);
    await app.getByRole("button", { name: "Fretboard" }).click();
    await app
      .getByRole("region", { name: "Fretboard" })
      .getByRole("button", { name: "Tuner…" })
      .click();
    const tuner = app.getByRole("dialog", { name: "Tuner: Guitar" });
    await tuner.getByRole("tab", { name: "Microphone" }).click();
    await expect(tuner.getByText("Input: Scarlett 2i2 USB")).toBeVisible();

    const change = tuner.getByRole("button", { name: "Change input…" });
    await change.click();
    settings = app.getByRole("dialog", { name: "Settings" });
    const input = settings.getByRole("combobox", { name: "Input" });
    await expect(input).toHaveText("Scarlett 2i2 USB");
    await input.click();
    await app.getByRole("option", { name: "System default" }).click();
    await app.keyboard.press("Escape");

    await expect(settings).toBeHidden();
    await expect(tuner).toBeVisible();
    await expect(change).toBeFocused();
    await expect(tuner.getByText("Input: System default")).toBeVisible();
  });
});
