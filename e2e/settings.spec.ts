import { expect, expectNoA11yViolations, test } from "./fixtures";

/** The Settings dialog: cards for each group of settings and a footer that stays in view. */

for (const colorScheme of ["light", "dark"] as const) {
  for (const [label, size] of [
    ["desktop", { width: 1280, height: 800 }],
    ["narrow", { width: 400, height: 760 }],
  ] as const) {
    test(`Settings shows its sections in ${colorScheme} mode, ${label}`, async ({ app }) => {
      await app.emulateMedia({ colorScheme });
      await app.setViewportSize(size);
      await app.getByRole("button", { name: "Help" }).click();
      await app.getByRole("menuitem", { name: "Settings…" }).click();

      const settings = app.getByRole("dialog", { name: "Settings" });
      await expect(settings).toHaveAccessibleDescription(/audio input.*cloud storage/i);
      await expect(settings.getByRole("region", { name: "Audio input" })).toBeVisible();
      await expect(
        settings.getByRole("region", { name: "Privacy and usage statistics" }),
      ).toBeVisible();
      // The footer is pinned: Close stays in view whatever the height.
      await expect(settings.getByRole("button", { name: "Close" }).last()).toBeInViewport();
      await expectNoA11yViolations(app);

      await app.keyboard.press("Escape");
      await expect(settings).toBeHidden();
    });
  }
}
