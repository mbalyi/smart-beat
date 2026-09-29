import { emitMenuAction, expect, LICENSE_TEXT, test } from "./fixtures";

test.describe("native menu integration", () => {
  test("Help → About shows version details", async ({ app }) => {
    await emitMenuAction(app, "about");

    const dialog = app.getByRole("dialog", { name: "Smart Beat" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("0.1.0")).toBeVisible();
    await expect(dialog.getByText("macOS (Apple Silicon)")).toBeVisible();
  });

  test("Help → Keyboard Shortcuts lists menu shortcuts", async ({ app }) => {
    await emitMenuAction(app, "shortcuts");

    const dialog = app.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog.getByRole("region", { name: "View" })).toContainText("Toggle Dark Mode");
  });

  test("Help → Open-Source Licenses shows a scrollable notice list", async ({ app }) => {
    await emitMenuAction(app, "licenses");

    const region = app.getByRole("region", { name: "License notices" });
    await expect(region).toContainText(LICENSE_TEXT.split("\n")[0]!);
    await region.focus();
    await expect(region).toBeFocused();
  });

  test("View → Toggle Dark Mode switches theme and remembers it", async ({ app }) => {
    await app.emulateMedia({ colorScheme: "light" });
    await emitMenuAction(app, "toggle-theme");
    await expect(app.locator("html")).toHaveClass(/dark/);

    await app.reload();

    await expect(app.locator("html")).toHaveClass(/dark/);
  });

  test("File → Open… shows the native Open dialog", async ({ app }) => {
    await emitMenuAction(app, "open");

    await expect
      .poll(() => app.evaluate(() => window.__ipcCalls.some((c) => c.cmd === "plugin:dialog|open")))
      .toBe(true);
    // Cancelled (the mock's default): the welcome screen stays.
    await expect(app.getByRole("heading", { level: 1 })).toHaveText(/Write, play/);
  });
});
