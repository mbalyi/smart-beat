import { emitMenuAction, expect, expectNoA11yViolations, tabKey, test } from "./fixtures";

test.describe("accessibility", () => {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`welcome screen has no WCAG violations in ${colorScheme} mode`, async ({ app }) => {
      await app.emulateMedia({ colorScheme });
      const html = app.locator("html");
      if (colorScheme === "dark") await expect(html).toHaveClass(/dark/);
      else await expect(html).not.toHaveClass(/dark/);

      await expectNoA11yViolations(app);
    });
  }

  for (const action of ["about", "shortcuts", "licenses"] as const) {
    test(`${action} dialog has no WCAG violations`, async ({ app }) => {
      await emitMenuAction(app, action);
      const dialog = app.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("status")).toHaveCount(0); // finished loading

      await expectNoA11yViolations(app);
    });
  }

  test("keyboard users can skip to the main content", async ({ app, browserName }) => {
    const tab = tabKey(browserName);
    await app.keyboard.press(tab);
    const skip = app.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();

    await app.keyboard.press("Enter");

    await expect(app.getByRole("main")).toBeFocused();
    await app.keyboard.press(tab);
    await expect(app.getByRole("button", { name: "Open a file…" })).toBeFocused();
  });

  test("tab order follows the visual order", async ({ app, browserName }) => {
    const expected = [
      "Skip to main content",
      "Theme",
      "Help",
      "Open a file…",
      "Keyboard shortcuts",
    ];
    const focused: string[] = [];
    for (let i = 0; i < expected.length; i++) {
      await app.keyboard.press(tabKey(browserName));
      focused.push(
        await app.evaluate(
          () =>
            document.activeElement?.getAttribute("aria-label") ??
            document.activeElement?.textContent?.trim() ??
            "",
        ),
      );
    }
    expect(focused).toEqual(expected);
  });

  test("dialogs trap focus and return it on close", async ({ app }) => {
    const help = app.getByRole("button", { name: "Help" });
    await help.click();
    await app.getByRole("menuitem", { name: "About Smart Beat" }).click();
    const dialog = app.getByRole("dialog", { name: "Smart Beat" });
    await expect(dialog).toBeVisible();

    for (let i = 0; i < 4; i++) {
      await app.keyboard.press("Tab");
      await expect(dialog.locator(":focus")).toHaveCount(1);
    }

    await app.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(help).toBeFocused();
  });

  test("respects reduced motion", async ({ app }) => {
    await app.emulateMedia({ reducedMotion: "reduce" });
    await emitMenuAction(app, "about");

    const duration = await app
      .getByRole("dialog")
      .evaluate((el) => getComputedStyle(el).animationDuration);
    expect(parseFloat(duration)).toBeLessThan(0.01);
  });
});
