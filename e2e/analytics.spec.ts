import type { Page } from "@playwright/test";

import { emitMenuAction, expect, expectNoA11yViolations, openSong, test } from "./fixtures";

/** The usage counters the page asked the core to record (#99), in order. */
const tracked = (app: Page) =>
  app.evaluate(() =>
    window.__ipcCalls
      .filter((call) => call.cmd === "track_event")
      .map((call) => {
        const { event, format } = call.args as { event: string; format: string | null };
        return format ? `${event}:${format}` : event;
      }),
  );

test.describe("anonymous usage counters (#99)", () => {
  test("counts starting the app, opening a song and the practice tools once each", async ({
    app,
  }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Loop" }).click();
    await app.getByRole("button", { name: "Metronome" }).click();
    await app.getByRole("button", { name: "Count-in" }).click();

    const events = await tracked(app);
    expect(events).toContain("app_start");
    expect(events).toContain("open_file:gp");
    expect(events.filter((e) => e === "loop_on")).toHaveLength(1);
    expect(events.filter((e) => e === "metronome_on")).toHaveLength(1);
    expect(events.filter((e) => e === "count_in_on")).toHaveLength(1);

    // Switching a tool off is not a use.
    await app.getByRole("button", { name: "Loop" }).click();
    expect((await tracked(app)).filter((e) => e === "loop_on")).toHaveLength(1);
  });

  test("counts the restart-after-Stop option (#93)", async ({ app }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Loop", exact: true }).click();
    await app.getByRole("button", { name: "Auto-restart" }).click();
    await app.getByRole("button", { name: "Auto-restart" }).click();
    const events = await tracked(app);
    expect(events).toContain("restart_on_stop_off");
    expect(events).toContain("restart_on_stop_on");
  });

  test("counts the mixer, a new song and a theme change, and never sends names or values", async ({
    app,
  }) => {
    await openSong(app);
    await emitMenuAction(app, "toggle-mixer");
    await emitMenuAction(app, "toggle-mixer");
    await emitMenuAction(app, "toggle-mixer");
    await emitMenuAction(app, "new-song");
    await emitMenuAction(app, "toggle-theme");

    await expect.poll(() => tracked(app)).toContain("new_song");
    const events = await tracked(app);
    expect(events.some((e) => e.startsWith("mixer_open"))).toBe(true);
    expect(events.some((e) => e === "theme_dark" || e === "theme_light")).toBe(true);

    // Only arguments the core accepts: an event name and, for files, a known extension.
    const args = await app.evaluate(() =>
      window.__ipcCalls.filter((c) => c.cmd === "track_event").map((c) => c.args),
    );
    for (const arg of args) {
      expect(Object.keys(arg as object).sort()).toEqual(["event", "format"]);
      expect((arg as { event: string }).event).toMatch(/^[a-z_]+$/);
    }
  });

  test("Help → Settings… switches the counters off and on", async ({ app }) => {
    await app.evaluate(() => {
      window.__usage = { enabled: true, available: true, noticeSeen: true };
    });
    await app.getByRole("button", { name: "Help" }).click();
    await app.getByRole("menuitem", { name: "Settings…" }).click();

    const dialog = app.getByRole("dialog", { name: "Settings" });
    const toggle = dialog.getByRole("switch", { name: "Share anonymous usage counts" });
    await expect(toggle).toBeChecked();
    await expectNoA11yViolations(app);

    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect.poll(() => app.evaluate(() => window.__usage.enabled)).toBe(false);
    await toggle.click();
    await expect.poll(() => app.evaluate(() => window.__usage.enabled)).toBe(true);

    await app.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("Settings says so when this build collects nothing", async ({ app }) => {
    await app.getByRole("button", { name: "Help" }).click();
    await app.getByRole("menuitem", { name: "Settings…" }).click();
    await expect(app.getByRole("dialog", { name: "Settings" })).toContainText(
      "does not collect any usage statistics",
    );
  });
});
