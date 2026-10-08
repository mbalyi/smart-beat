import type { Page } from "@playwright/test";

import { emitMenuAction, expect, expectNoA11yViolations, openSong, test } from "./fixtures";

/** Customer feedback (#83 §1–3): a quiet first launch, Practice View and practice mixes. */

/** What the native engine was last told for each track. */
const engineMixes = (app: Page) =>
  app.evaluate(() => {
    const last = window.__ipcCalls.filter((c) => c.cmd === "audio_set_mix").at(-1);
    const args = last?.args as
      { mixes: { trimDb: number; mute: boolean; solo: boolean }[] } | undefined;
    return args?.mixes.map((m) => ({ trimDb: m.trimDb, mute: m.mute, solo: m.solo })) ?? null;
  });

const mixer = (app: Page) => app.getByRole("region", { name: "Tracks and mixer" });
const inspector = (app: Page) => app.getByRole("complementary", { name: "Inspector" });

test.describe("first launch (#83)", () => {
  test.use({ firstLaunch: true });

  test("a new install shows the score and the playback controls; panels are a click away", async ({
    app,
  }) => {
    await openSong(app);
    await expect(app.getByRole("button", { name: "Play" })).toBeVisible();
    await expect(mixer(app)).toHaveCount(0);
    await expect(inspector(app)).toHaveCount(0);
    await app.getByRole("button", { name: "Mixer" }).click();
    await expect(mixer(app)).toBeVisible();
    await emitMenuAction(app, "toggle-inspector");
    await expect(inspector(app)).toBeVisible();
    // Remembered for next time.
    await app.reload();
    await openSong(app);
    await expect(mixer(app)).toBeVisible();
    await expect(inspector(app)).toBeVisible();
  });
});

test.describe("Practice View (#83)", () => {
  test("hides the panels, keeps the controls and puts everything back", async ({ app }) => {
    await openSong(app);
    await expect(mixer(app)).toBeVisible();
    const toggle = app.getByRole("button", { name: "Practice View" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(mixer(app)).toHaveCount(0);
    await expect(inspector(app)).toHaveCount(0);
    await expect(app.getByRole("group", { name: "Practice" }).first()).toBeVisible();
    await expect(app.getByRole("button", { name: "Play" })).toBeVisible();
    // The menu item (and its shortcut) does the same.
    await emitMenuAction(app, "toggle-practice-view");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(mixer(app)).toBeVisible();
    await expect(inspector(app)).toBeVisible();
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`passes the accessibility checks in ${colorScheme} mode`, async ({ app }) => {
      await app.emulateMedia({ colorScheme });
      await openSong(app);
      await app.getByRole("button", { name: "Practice View" }).click();
      await expectNoA11yViolations(app);
      await app.getByRole("button", { name: /^Practice mix/ }).click();
      await expect(app.getByRole("dialog", { name: "Practice mix" })).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
    });
  }
});

test.describe("practice mixes (#83)", () => {
  test("hear only me, backing only and back to the normal mix", async ({ app }) => {
    await openSong(app);
    await app.getByRole("switch", { name: "Native engine with effects" }).click();
    await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
    // Bass is the track practised; the song's own mutes and solos stay as they are.
    await app.getByRole("button", { name: "Show Bass" }).click();
    await expect.poll(() => engineMixes(app)).not.toBeNull();
    const normal = (await engineMixes(app))!;
    await app.getByRole("button", { name: /^Practice mix/ }).click();
    const popover = app.getByRole("dialog", { name: "Practice mix" });
    await popover.getByRole("radio", { name: /Hear only me/ }).click();
    await expect
      .poll(() => engineMixes(app).then((m) => m?.map((t) => t.mute)))
      .toEqual([true, false, true, true]);
    await popover.getByRole("radio", { name: /Backing only/ }).click();
    await expect
      .poll(() => engineMixes(app).then((m) => m?.map((t) => t.mute)))
      .toEqual(normal.map((t, i) => i === 1 || t.mute));
    await popover.getByRole("radio", { name: /Others turned down/ }).click();
    await popover.getByRole("radio", { name: "Subtle" }).click();
    await expect
      .poll(() => engineMixes(app).then((m) => m?.map((t) => t.trimDb)))
      .toEqual([-6, 3, -6, -6]);
    await popover.getByRole("radio", { name: /Normal mix/ }).click();
    await expect.poll(() => engineMixes(app)).toEqual(normal);
  });
});
