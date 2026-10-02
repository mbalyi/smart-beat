import { expect, expectNoA11yViolations, openSong, test } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * Mixing (#37): channel EQ, meters, volume / pan / mute automation, the
 * master strip, focus and the drum element mixer. The engine is mocked.
 */

async function withEngine(app: Page) {
  await openSong(app);
  await app.getByRole("switch", { name: "Native engine with effects" }).click();
  await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
}

test.describe("mixer (#37)", () => {
  test("edits a track's channel EQ and sends it to the engine", async ({ app }) => {
    await withEngine(app);
    await app.getByRole("button", { name: "EQ for Bass" }).click();
    const low = app.getByRole("slider", { name: "EQ low, Bass" });
    await low.focus();
    await app.keyboard.press("PageUp");
    await expect(low).toHaveAttribute("aria-valuetext", "+3.0 dB");
    await expectNoA11yViolations(app);
    await expect.poll(() => app.evaluate(() => window.__engineConfig.eq[1]?.lowDb)).toBe(3);
    await app.getByRole("switch", { name: "10-band EQ, Bass" }).click();
    await expect(app.getByRole("slider", { name: "EQ 1.0 kHz, Bass" })).toBeVisible();
    await expect
      .poll(() => app.evaluate(() => window.__engineConfig.eq[1]?.graphic?.length))
      .toBe(10);
  });

  test("draws volume automation in the lane under a track", async ({ app }) => {
    await withEngine(app);
    await app.getByRole("button", { name: "Automation for Guitar" }).click();
    const lane = app.getByRole("group", { name: "Volume automation, Guitar" });
    await expect(lane).toBeVisible();
    const box = (await lane.boundingBox())!;
    // Full volume at bar 1, silence in the middle of bar 3.
    await app.mouse.click(box.x + 1, box.y + 6);
    await app.mouse.click(box.x + 2.5 * 21, box.y + box.height - 1);
    await expect(lane.getByRole("slider")).toHaveCount(2);
    const last = lane.getByRole("slider", { name: "Volume point at bar 3.5" });
    await expect(last).toHaveAttribute("aria-valuetext", "0%");
    await last.focus();
    await app.keyboard.press("ArrowUp");
    await expect(last).toHaveAttribute("aria-valuetext", "5%");
    await expect
      .poll(() => app.evaluate(() => window.__engineConfig.automation[0]?.volume.length))
      .toBeGreaterThan(2);
    await expectNoA11yViolations(app);
    await app.keyboard.press("Delete");
    await expect(lane.getByRole("slider")).toHaveCount(1);
  });

  test("master pan, focus and meters", async ({ app }) => {
    await withEngine(app);
    const pan = app.getByRole("slider", { name: "Master pan" });
    await pan.focus();
    await app.keyboard.press("ArrowLeft");
    await expect(pan).toHaveAttribute("aria-valuetext", "13% left");
    await app.getByRole("button", { name: "Actions for Drums" }).click();
    await app.getByRole("menuitem", { name: "Focus (turn the others down)" }).click();
    await expect(app.getByRole("button", { name: "Show Drums (in focus)" })).toBeVisible();
    await expect
      .poll(() =>
        app.evaluate(() => {
          const last = window.__ipcCalls.filter((c) => c.cmd === "audio_set_mix").at(-1);
          const args = last?.args as { mixes: { trimDb: number }[] } | undefined;
          return args?.mixes.map((m) => m.trimDb) ?? null;
        }),
      )
      .toEqual([-12, -12, 3, -12]);
    await app.getByRole("button", { name: "Play" }).click();
    await expect
      .poll(() => app.getByRole("meter", { name: "Level, master" }).getAttribute("aria-valuenow"))
      .not.toBe("0");
    await app.getByRole("button", { name: "Stop" }).click();
  });

  test("the drum mixer splits the kit into pieces", async ({ app }) => {
    await withEngine(app);
    await app.getByRole("button", { name: "Actions for Drums" }).click();
    await app.getByRole("menuitem", { name: "Drum mixer…" }).click();
    const dialog = app.getByRole("dialog", { name: "Drum mixer: Drums" });
    await expect(dialog.getByTestId("drum-element")).toHaveCount(17);
    await expectNoA11yViolations(app);
    await dialog.getByRole("button", { name: "Mute Snare" }).click();
    await dialog.getByRole("radio", { name: "Mono" }).click();
    await expect
      .poll(() =>
        app.evaluate(() => {
          const drums = window.__engineConfig.drums[2];
          return drums ? [drums.stereo, drums.elements[0]!.mix.mute] : null;
        }),
      )
      .toEqual([false, true]);
    const volume = dialog.getByRole("slider", { name: "Volume, Kick" });
    await volume.focus();
    await app.keyboard.press("ArrowLeft");
    await expect(volume).toHaveAttribute("aria-valuetext", "-0.1 dB");
  });

  test("the mixer passes the accessibility checks in dark mode", async ({ app }) => {
    await app.emulateMedia({ colorScheme: "dark" });
    await withEngine(app);
    await app.getByRole("button", { name: "Automation for Bass" }).click();
    await expectNoA11yViolations(app);
    await app.getByRole("button", { name: "Actions for Drums" }).click();
    await app.getByRole("menuitem", { name: "Drum mixer…" }).click();
    await expect(app.getByRole("dialog", { name: "Drum mixer: Drums" })).toBeVisible();
    await expectNoA11yViolations(app);
  });
});
