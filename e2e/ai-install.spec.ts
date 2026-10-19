import type { Page } from "@playwright/test";

import features from "../src/lib/features.json" with { type: "json" };
import { expect, expectNoA11yViolations, newSong, openSong, test } from "./fixtures";

/**
 * The guided install of MuScriptor (#150): Import from Audio and the AI tab of Record to tab
 * hand over to one installer and get the user back. The native commands are mocked in
 * e2e/tauri-mock.js (`window.__muscriptor`).
 */

test.skip(
  !features["audio-2-tab"] || !features["muscriptor-record"],
  "the AI flags are off in src/lib/features.json",
);

/**
 * Waits until the dialog finished fading in, so that axe does not read half-transparent text, and
 * moves the pointer away, so that no button is scanned in its hover colour.
 */
async function settled(app: Page) {
  await app.mouse.move(0, 0);
  await expect
    .poll(() =>
      app.evaluate(() => {
        const el = document.querySelector('[role="dialog"]');
        return el ? getComputedStyle(el).opacity : "0";
      }),
    )
    .toBe("1");
}

const installer = (app: Page) =>
  app.getByRole("dialog", { name: /Powered by MuScriptor|Models|Register|Downloading|set up/ });

async function openAudio(app: Page) {
  const welcome = app.getByRole("button", { name: "Import from Audio…" });
  if (await welcome.isVisible()) await welcome.click();
  else {
    await app.getByRole("button", { name: "File" }).click();
    await app.getByRole("menuitem", { name: "Import from Audio…" }).click();
  }
  const dialog = app.getByRole("dialog", { name: "Import from Audio" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function walkInstaller(app: Page, size: "Small" | "Medium" | "Large" = "Medium") {
  const dialog = installer(app);
  await dialog.getByRole("button", { name: "Choose a model" }).click();
  await dialog.getByRole("radio", { name: new RegExp(size) }).check();
  await dialog.getByRole("button", { name: "Continue" }).click();
  const download = dialog.getByRole("button", { name: new RegExp(`^Download ${size}`) });
  await expect(download).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /accepted the MuScriptor weight terms/ }).check();
  await expect(download).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /only use MuScriptor with my own music/ }).check();
  await download.click();
  await expect(dialog.getByRole("heading", { name: "Everything is set up" })).toBeVisible();
  return dialog;
}

test.describe("AI installer (#150)", () => {
  test("Import from Audio: download first, install, and come back to the dialog", async ({
    app,
  }) => {
    const audio = await openAudio(app);
    await expect(audio.getByTestId("audio-needs-model")).toBeVisible();
    await audio.getByRole("button", { name: "Download MuScriptor" }).click();
    await expect(audio).toBeHidden();

    const dialog = await walkInstaller(app, "Small");
    expect(await app.evaluate(() => window.__muscriptor.downloads)).toEqual(["small"]);
    expect(await app.evaluate(() => window.__muscriptor.rightsConfirmed)).toEqual([true]);
    await dialog.getByRole("button", { name: "Back to Import from Audio" }).click();

    // Seamlessly back in the dialog that asked, now ready to take a recording.
    await expect(app.getByRole("dialog", { name: "Import from Audio" })).toBeVisible();
    await expect(app.getByLabel("Choose an audio recording")).toBeAttached();
    await expect(app.getByTestId("audio-needs-model")).toHaveCount(0);
  });

  test("Record to tab: the AI tab hands over to the installer and comes back", async ({ app }) => {
    await newSong(app);
    await app.getByRole("button", { name: "File" }).click();
    await app.getByRole("menuitem", { name: /^Record to Tab…/ }).click();
    const record = app.getByRole("dialog", { name: /^Record to Tab/ });
    await expect(record.getByRole("tab", { name: "Default" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await record.getByRole("tab", { name: "AI" }).click();
    await expect(record.getByRole("button", { name: "Record" })).toBeDisabled();
    await record.getByRole("button", { name: "Download MuScriptor" }).click();
    await expect(record).toBeHidden();

    const dialog = await walkInstaller(app);
    await dialog.getByRole("button", { name: "Back to recording" }).click();
    await expect(record).toBeVisible();
    await expect(record.getByRole("tab", { name: "AI" })).toHaveAttribute("aria-selected", "true");
    await expect(record.getByRole("button", { name: "Download MuScriptor" })).toHaveCount(0);
    await expect(record.getByRole("radio", { name: "Medium" })).toBeChecked();
  });

  test("Record to tab: a file goes through the AI engine with the chosen size", async ({ app }) => {
    await app.evaluate(() => {
      window.__muscriptor.termsAccepted = true;
      window.__muscriptor.installed.small = true;
    });
    await newSong(app);
    await app.getByRole("button", { name: "File" }).click();
    await app.getByRole("menuitem", { name: /^Record to Tab…/ }).click();
    const record = app.getByRole("dialog", { name: /^Record to Tab/ });
    await record.getByRole("tab", { name: "AI" }).click();
    await expect(record.getByRole("radio", { name: "Small" })).toBeVisible();
    await record.getByRole("radio", { name: "File" }).click();
    await expect(record.getByRole("button", { name: "Make tab" })).toBeDisabled();
  });

  test("the installer keeps its size and its buttons on every step", async ({ app }) => {
    const audio = await openAudio(app);
    await audio.getByRole("button", { name: "Download MuScriptor" }).click();
    const dialog = installer(app);
    const boxes: { x: number; y: number; width: number; height: number }[] = [];
    const footer: (typeof boxes)[] = [];
    const measure = async () => {
      // The layout size: the dialog zooms in while it opens, which moves its bounding box.
      boxes.push(
        await dialog.evaluate((el) => ({
          x: 0,
          y: 0,
          width: (el as HTMLElement).offsetWidth,
          height: (el as HTMLElement).offsetHeight,
        })),
      );
      const buttons = dialog.locator('[data-slot="dialog-footer"] button');
      footer.push(
        await buttons.evaluateAll((els) =>
          els.map((e) => {
            const r = e.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          }),
        ),
      );
    };
    await settled(app);
    await measure();
    await dialog.getByRole("button", { name: "Choose a model" }).click();
    await measure();
    await dialog.getByRole("button", { name: "Continue" }).click();
    await measure();
    for (const box of boxes) {
      expect(box.width).toBeCloseTo(boxes[0].width, 0);
      expect(box.height).toBeCloseTo(boxes[0].height, 0);
    }
    // Back, the primary action and Close stay put (the primary's width follows its label).
    for (const row of footer) {
      expect(row).toHaveLength(3);
      expect(row[0].x).toBeCloseTo(footer[0][0].x, 0);
      expect(row[2].x + row[2].width).toBeCloseTo(footer[0][2].x + footer[0][2].width, 0);
      expect(row[0].y).toBeCloseTo(footer[0][0].y, 0);
    }
  });

  test("a failed download is reported and can be tried again", async ({ app }) => {
    await app.evaluate(() => {
      window.__muscriptor.fail = "The network dropped.";
    });
    const audio = await openAudio(app);
    await audio.getByRole("button", { name: "Download MuScriptor" }).click();
    const dialog = installer(app);
    await dialog.getByRole("button", { name: "Choose a model" }).click();
    await dialog.getByRole("button", { name: "Continue" }).click();
    await dialog.getByRole("checkbox", { name: /accepted the MuScriptor weight terms/ }).check();
    await dialog.getByRole("checkbox", { name: /only use MuScriptor with my own music/ }).check();
    await dialog.getByRole("button", { name: /^Download Medium/ }).click();
    await expect(dialog.getByText("The network dropped.")).toBeVisible();
    await app.evaluate(() => {
      window.__muscriptor.fail = null;
    });
    await dialog.getByRole("button", { name: "Try again" }).click();
    await expect(dialog.getByRole("heading", { name: "Everything is set up" })).toBeVisible();
  });

  test("closing during a download stops it and returns to the dialog", async ({ app }) => {
    await app.evaluate(() => {
      window.__muscriptor.hold = true;
    });
    const audio = await openAudio(app);
    await audio.getByRole("button", { name: "Download MuScriptor" }).click();
    const dialog = installer(app);
    await dialog.getByRole("button", { name: "Choose a model" }).click();
    await dialog.getByRole("button", { name: "Continue" }).click();
    await dialog.getByRole("checkbox", { name: /accepted the MuScriptor weight terms/ }).check();
    await dialog.getByRole("checkbox", { name: /only use MuScriptor with my own music/ }).check();
    await dialog.getByRole("button", { name: /^Download Medium/ }).click();
    await expect(dialog.getByRole("progressbar", { name: "Download" })).toBeVisible();
    await dialog
      .locator('[data-slot="dialog-footer"]')
      .getByRole("button", { name: "Close" })
      .click();
    await expect.poll(() => app.evaluate(() => window.__muscriptor.cancelled)).toBeGreaterThan(0);
    await expect(app.getByRole("dialog", { name: "Import from Audio" })).toBeVisible();
    await expect(app.getByTestId("audio-needs-model")).toBeVisible();
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`has no WCAG violations in ${colorScheme} mode`, async ({ app }) => {
      await app.emulateMedia({ colorScheme });
      await newSong(app);
      await app.getByRole("button", { name: "File" }).click();
      await app.getByRole("menuitem", { name: /^Record to Tab…/ }).click();
      const record = app.getByRole("dialog", { name: /^Record to Tab/ });
      await record.getByRole("tab", { name: "AI" }).click();
      await settled(app);
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
      await record.getByRole("button", { name: "Download MuScriptor" }).click();
      const dialog = installer(app);
      await settled(app);
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
      await dialog.getByRole("button", { name: "Choose a model" }).click();
      await settled(app);
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
      await dialog.getByRole("button", { name: "Continue" }).click();
      await settled(app);
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
    });
  }

  test("credits MuScriptor in an add-ons section of its own on the start page", async ({ app }) => {
    const section = app.getByRole("region", { name: "Add-ons you download yourself." });
    await expect(section).toBeVisible();
    await section.getByRole("button", { name: "Powered by MuScriptor" }).click();
    await section.getByRole("link", { name: "Paper" }).click();
    await expect
      .poll(() =>
        app.evaluate(() => window.__ipcCalls.find((c) => c.cmd === "plugin:opener|open_url")?.args),
      )
      .toMatchObject({ url: "https://arxiv.org/abs/2607.08168" });
    await expectNoA11yViolations(app);
  });
});

void openSong;
