import { expect, expectNoA11yViolations, openSong, test } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

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
    const low = app.getByRole("slider", { name: "Bass, EQ low" });
    await low.focus();
    await app.keyboard.press("PageUp");
    await expect(low).toHaveAttribute("aria-valuetext", "+3.0 dB");
    await expectNoA11yViolations(app);
    await expect.poll(() => app.evaluate(() => window.__engineConfig.eq[1]?.lowDb)).toBe(3);
    await app.getByRole("switch", { name: "10-band EQ, Bass" }).click();
    await expect(app.getByRole("slider", { name: "Bass, EQ 1 kHz" })).toBeVisible();
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
    await expect(pan).toHaveAttribute("aria-valuetext", "Left 1%");
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

  test("shows the L/C/R value while hovering and recentres on double-click (#129)", async ({
    app,
  }) => {
    await openSong(app);
    const pan = app.getByRole("slider", { name: "Pan, Guitar" });
    await pan.scrollIntoViewIfNeeded();
    await pan.hover();
    const bubble = app.getByTestId("pan-value");
    await expect(bubble).toBeVisible();
    await expect(bubble).toHaveText("C");

    await pan.focus();
    await app.keyboard.press("ArrowRight");
    await expect(pan).toHaveAttribute("aria-valuetext", "Right 1%");
    await expect(bubble).toHaveText("R 1%");

    await pan.dblclick();
    await expect(pan).toHaveAttribute("aria-valuetext", "Centre");
    await expect(bubble).toHaveText("C");
  });

  test("pressed Mute is red and Solo green in the dark theme too (mixer and practice bar)", async ({
    app,
  }) => {
    await app.emulateMedia({ colorScheme: "dark" });
    await openSong(app);
    const background = (button: Locator) =>
      button.evaluate((el) => getComputedStyle(el).backgroundColor);
    const mute = app.getByRole("button", { name: /^Mute / }).first();
    const solo = app.getByRole("button", { name: /^Solo / }).first();
    const countIn = app.getByRole("button", { name: "Count-in" });
    const idle = await background(mute);
    for (const button of [mute, solo, countIn]) await button.click();
    await app.mouse.move(0, 0);
    // The colours fade in: wait for the end.
    await expect.poll(() => background(mute)).toContain("oklch(0.505 0.213 27"); // red-700
    await expect.poll(() => background(solo)).toContain("oklch(0.527 0.154 150"); // green-700
    await expect.poll(() => background(countIn)).toContain("rgb(154, 42, 230)"); // the purple of the logo
    await mute.click();
    await app.mouse.move(0, 0);
    await expect.poll(() => background(mute)).toBe(idle);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`colours a track from the row menu, saves it and resets it, in ${colorScheme} mode (#83)`, async ({
      app,
    }) => {
      await app.emulateMedia({ colorScheme });
      await openSong(app);
      const strip = (name: string) =>
        app
          .getByRole("button", { name: `Show ${name}` })
          .locator("xpath=preceding-sibling::span[contains(@class,'w-1')]");
      const background = (name: string) =>
        strip(name).evaluate((el) => getComputedStyle(el).backgroundColor);
      const guitarBefore = await background("Guitar");
      const bassBefore = await background("Bass");

      await app.getByRole("button", { name: "Actions for Guitar" }).click();
      await app.getByRole("menuitem", { name: "Colour…" }).click();
      const dialog = app.getByRole("dialog", { name: "Track colour: Guitar" });
      await dialog.getByRole("button", { name: "Blue" }).click();
      await expect(dialog.getByRole("button", { name: "Blue" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expectNoA11yViolations(app);
      await dialog.getByRole("button", { name: "Done" }).click();

      await expect.poll(() => background("Guitar")).not.toBe(guitarBefore);
      // The other tracks keep their colours.
      expect(await background("Bass")).toBe(bassBefore);
      await expect
        .poll(() => app.evaluate(() => [...window.__mixes.values()][0]?.trackColors))
        .toEqual(["#3e63dd", null, null, null]);

      await app.getByRole("button", { name: "Actions for Guitar" }).click();
      await app.getByRole("menuitem", { name: "Colour…" }).click();
      await app
        .getByRole("dialog", { name: "Track colour: Guitar" })
        .getByRole("button", { name: "Reset all colours" })
        .click();
      await app
        .getByRole("dialog", { name: "Track colour: Guitar" })
        .getByRole("button", { name: "Done" })
        .click();
      await expect.poll(() => background("Guitar")).toBe(guitarBefore);
      await expect
        .poll(() => app.evaluate(() => [...window.__mixes.values()][0]?.trackColors))
        .toBeUndefined();
    });
  }

  test("the name column hides the bars scrolled under it", async ({ app }) => {
    await app.emulateMedia({ colorScheme: "dark" });
    await openSong(app);
    const cells = app.locator("section[aria-label='Tracks and mixer'] ol li > div > div.sticky");
    for (const cell of await cells.all()) {
      const colour = await cell.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(colour).not.toBe("rgba(0, 0, 0, 0)");
    }
  });

  test("the drum mixer shows the whole kit when the window is wide enough", async ({ app }) => {
    await withEngine(app);
    await app.getByRole("button", { name: "Actions for Drums" }).click();
    await app.getByRole("menuitem", { name: "Drum mixer…" }).click();
    const dialog = app.getByRole("dialog", { name: "Drum mixer: Drums" });
    const strips = dialog.getByRole("list", { name: "Kit pieces" });
    await expect(strips).toBeVisible();
    expect(await strips.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
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
