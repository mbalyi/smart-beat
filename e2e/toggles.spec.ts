import type { Locator } from "@playwright/test";

import { expect, expectNoA11yViolations, openSong, test } from "./fixtures";

/** Customer feedback (#83 §9): a toggle that is on must not look like one that is off. */
test.describe("active toggle states (#83)", () => {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`Loop, Fretboard and Mixer stand out when on, in ${colorScheme} mode`, async ({ app }) => {
      await app.emulateMedia({ colorScheme });
      await openSong(app);
      const look = (button: Locator) =>
        button.evaluate((el) => {
          const style = getComputedStyle(el);
          return { background: style.backgroundColor, shadow: style.boxShadow };
        });
      const toggles = [
        app.getByRole("button", { name: "Loop" }),
        app.getByRole("button", { name: /^Mixer/ }).first(),
        app.getByRole("button", { name: /Fretboard/ }).first(),
      ];
      // Some panels start open: switch every toggle off first, to see the idle look.
      for (const toggle of toggles) {
        if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click();
        await expect(toggle).toHaveAttribute("aria-pressed", "false");
      }
      await app.mouse.move(0, 0);
      await app.waitForTimeout(400); // the colours fade out
      const idle = await Promise.all(toggles.map(look));
      for (const toggle of toggles) await toggle.click();
      await app.mouse.move(0, 0);
      for (const [i, toggle] of toggles.entries()) {
        await expect(toggle).toHaveAttribute("aria-pressed", "true");
        // The colours fade in: wait for the end (green-700).
        await expect
          .poll(async () => (await look(toggle)).background)
          .toContain("oklch(0.527 0.154 150");
        const on = await look(toggle);
        expect(on.background).not.toBe(idle[i]!.background);
        // Not only a different colour: the pressed button also gets an inset ring.
        expect(on.shadow).not.toBe(idle[i]!.shadow);
        expect(on.shadow).toContain("inset");
      }
    });

    test(`has no accessibility violations with the toggles on, in ${colorScheme} mode`, async ({
      app,
    }) => {
      await app.emulateMedia({ colorScheme });
      await openSong(app);
      for (const name of ["Loop", "Metronome", "Count-in"]) {
        await app.getByRole("button", { name }).click();
      }
      await app.mouse.move(0, 0);
      await expectNoA11yViolations(app);
    });
  }
});
