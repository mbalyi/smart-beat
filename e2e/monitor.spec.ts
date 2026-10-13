import { expect, expectNoA11yViolations, openSong, test } from "./fixtures";

for (const colorScheme of ["light", "dark"] as const) {
  test(`monitors live input with backing playback and an independent plugin in ${colorScheme} mode`, async ({
    app,
  }) => {
    await app.emulateMedia({ colorScheme });
    await openSong(app);
    const trigger = app.getByRole("button", { name: /^Practice mix/ });
    await trigger.focus();
    await app.keyboard.press("Enter");
    const popup = app.getByRole("dialog", { name: "Practice mix" });
    const monitor = popup.getByRole("switch", { name: "Monitor my input" });
    await monitor.focus();
    await app.keyboard.press("Space");
    await expect(monitor).toBeChecked();
    await expect.poll(() => app.evaluate(() => window.__engineMonitor?.params.enabled)).toBe(true);
    await popup.getByRole("radio", { name: /Backing only/ }).click();
    await expect.poll(() => app.evaluate(() => window.__engineMonitor?.params.enabled)).toBe(true);
    await expectNoA11yViolations(app, { popup: '[role="dialog"][aria-label="Practice mix"]' });
    await popup.getByRole("button", { name: "Input settings…" }).click();
    const settings = app.getByRole("dialog", { name: "Settings" });
    await expect(settings.getByRole("combobox", { name: "Channel" })).toBeVisible();
    await app.keyboard.press("Escape");
    if (!(await popup.isVisible())) await trigger.click();
    await popup.getByRole("button", { name: "Input effects…" }).click();
    const board = app.getByRole("dialog", { name: "Pedalboard: Monitor" });
    await board.getByRole("switch", { name: "Use third-party plugins" }).click();
    await board.getByRole("button", { name: "Scan for plugins…" }).click();
    await board.getByRole("button", { name: "Add plugin Test Amp" }).click();
    await board.getByRole("button", { name: "Open editor…" }).click();
    await board.getByRole("button", { name: "Save settings" }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () => window.__ipcCalls.filter((call) => call.cmd === "plugin_save_state").at(-1)?.args,
        ),
      )
      .toEqual({ track: "monitor", sound: 0, index: 0 });
    await expect
      .poll(() => app.evaluate(() => window.__engineChains?.monitor?.[0]))
      .toMatchObject({ type: "plugin", name: "Test Amp", state: "aGk=" });
    await expectNoA11yViolations(app);
    await app.keyboard.press("Escape");
    if (!(await popup.isVisible())) await trigger.click();
    await monitor.click();
    await expect.poll(() => app.evaluate(() => window.__engineMonitor?.params.enabled)).toBe(false);
    await monitor.click();
    await expect.poll(() => app.evaluate(() => window.__engineMonitor?.params.enabled)).toBe(true);
    await expect
      .poll(() => app.evaluate(() => window.__engineChains?.monitor?.[0]))
      .toMatchObject({ type: "plugin", state: "aGk=" });
    await app.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });
}
