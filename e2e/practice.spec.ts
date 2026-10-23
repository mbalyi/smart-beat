import type { Page } from "@playwright/test";

import { emitMenuAction, expect, openSong, playedSeconds, test } from "./fixtures";

/**
 * Practice tools (#7) with the real synthesizer. The practice song lasts 12 s:
 * bars 1–2 at 60 BPM (4 s each), bars 3–4 at 120 BPM (2 s each).
 */

/** Samples the position display every 200 ms for `ms`, as seconds played. */
async function samplePlayed(page: Page, ms: number): Promise<number[]> {
  return page.evaluate(async (duration) => {
    const samples: number[] = [];
    const end = performance.now() + duration;
    while (performance.now() < end) {
      const text = document.querySelector("[role=timer]")?.textContent ?? "";
      const [m, s] = text.split("/")[0]!.trim().split(":").map(Number);
      samples.push(m! * 60 + s!);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return samples;
  }, ms);
}

async function goToBar(page: Page, bar: number) {
  const field = page.getByRole("spinbutton", { name: "Bar" });
  await field.fill(String(bar));
  await field.press("Enter");
}

test.describe("practice tools (#7)", () => {
  test("loops the chosen bars", async ({ app }) => {
    await openSong(app);
    await goToBar(app, 3);

    await app.getByRole("button", { name: "Loop" }).click();
    await expect(app.getByRole("spinbutton", { name: "Loop from bar" })).toHaveValue("3");
    await expect(app.getByRole("spinbutton", { name: "Loop to bar" })).toHaveValue("3");
    await app.getByRole("button", { name: "Play" }).click();
    await expect.poll(() => playedSeconds(app), { timeout: 10_000 }).toBeGreaterThanOrEqual(9);

    // Bar 3 plays from 0:08 to 0:10, over and over: never beyond it.
    const samples = await samplePlayed(app, 4_500);
    expect(Math.max(...samples)).toBeLessThanOrEqual(10);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(8);
    expect(new Set(samples).size).toBeGreaterThan(1); // it does play
    await expect(app.getByRole("button", { name: "Pause" })).toBeVisible();
  });

  test("loops a range of bars set in the fields, and stops looping", async ({ app }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Loop" }).click();
    const to = app.getByRole("spinbutton", { name: "Loop to bar" });
    await to.fill("2");
    await to.press("Enter");

    await app.getByRole("button", { name: "Play" }).click();
    await expect.poll(() => playedSeconds(app), { timeout: 12_000 }).toBeGreaterThanOrEqual(7);
    const samples = await samplePlayed(app, 2_500);
    expect(Math.max(...samples)).toBeLessThanOrEqual(8); // bars 1–2: 0:00–0:08
    expect(Math.min(...samples)).toBeLessThan(2); // back at the start

    await app.getByRole("button", { name: "Loop" }).click();
    await expect(to).toBeHidden();
  });

  test("plays slower at a lower speed", async ({ app }) => {
    await openSong(app);
    await app.getByRole("combobox", { name: "Speed" }).click();
    await app.getByRole("option", { name: "50%", exact: true }).click();

    await app.getByRole("button", { name: "Play" }).click();
    await expect(app.getByText("30 BPM")).toBeVisible(); // 60 BPM at half speed
    // The position counts real time: bar 1 (4 s at full speed) now lasts 8 s.
    await expect.poll(() => playedSeconds(app), { timeout: 10_000 }).toBeGreaterThanOrEqual(5);
    await expect(app.getByRole("spinbutton", { name: "Bar" })).toHaveValue("1");
  });

  test("Stop in a loop sends the next Play back to the loop start, Pause does not (#93)", async ({
    app,
  }) => {
    await openSong(app);
    await goToBar(app, 3);
    await app.getByRole("button", { name: "Loop" }).click();
    await expect(app.getByRole("button", { name: "Auto-restart" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await app.getByRole("button", { name: "Play" }).click();
    await expect.poll(() => playedSeconds(app), { timeout: 10_000 }).toBeGreaterThanOrEqual(9);
    await app.getByRole("button", { name: "Pause" }).click();
    const paused = await playedSeconds(app);
    await app.getByRole("button", { name: "Play" }).click();
    expect(Math.abs((await playedSeconds(app)) - paused)).toBeLessThanOrEqual(1);

    await app.getByRole("button", { name: "Stop", exact: true }).click();
    await expect.poll(() => playedSeconds(app)).toBe(8);

    // The option can be switched off (the native engine then stops at the song start).
    await app.getByRole("button", { name: "Auto-restart" }).click();
    await expect(app.getByRole("button", { name: "Auto-restart" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  test("counts in before playing", async ({ app }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Count-in" }).click();
    await expect(app.getByRole("button", { name: "Count-in" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await app.getByRole("button", { name: "Play" }).click();
    // One bar of count-in at 60 BPM: the song itself starts after 4 s.
    await app.waitForTimeout(2_500);
    expect(await playedSeconds(app)).toBe(0);
    await expect.poll(() => playedSeconds(app), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  });

  test("count-in and metronome have settings popups that are remembered (#182)", async ({
    app,
  }) => {
    await openSong(app);
    // The gears only show while the control is on.
    await expect(app.getByRole("button", { name: "Beats to count in" })).toHaveCount(0);
    await app.getByRole("button", { name: "Count-in" }).click();
    await app.getByRole("button", { name: "Metronome" }).click();

    // Keyboard: the gear opens the popup, and the arrow keys pick the beats.
    await app.getByRole("button", { name: "Beats to count in" }).focus();
    await app.keyboard.press("Enter");
    const beats = app.getByRole("combobox", { name: "Beats to count in" });
    await expect(beats).toContainText("4 beats");
    await beats.click();
    await app.getByRole("option", { name: "8 beats" }).click();
    await expect(beats).toContainText("8 beats");
    await app.keyboard.press("Escape");

    await app.getByRole("button", { name: "Click sound and volume" }).click();
    await expect(app.getByRole("combobox", { name: "Click sound" })).toBeVisible();
    await app.getByRole("slider", { name: "Click volume" }).fill("2");
    await expect(app.getByRole("slider", { name: "Click volume" })).toHaveAttribute(
      "aria-valuetext",
      "200 percent",
    );
    await app.keyboard.press("Escape");

    await app.reload();
    await openSong(app);
    await app.getByRole("button", { name: "Beats to count in" }).click();
    await expect(app.getByRole("combobox", { name: "Beats to count in" })).toContainText("8 beats");
    await app.keyboard.press("Escape");
    await app.getByRole("button", { name: "Click sound and volume" }).click();
    await expect(app.getByRole("slider", { name: "Click volume" })).toHaveAttribute(
      "aria-valuetext",
      "200 percent",
    );
  });

  test("remembers the metronome and count-in", async ({ app }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Metronome" }).click();
    await emitMenuAction(app, "toggle-count-in");
    await expect(app.getByRole("button", { name: "Count-in" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect
      .poll(() => app.evaluate(() => window.__menuState))
      .toMatchObject({ metronome: true, countIn: true });

    await app.reload();
    await openSong(app);
    await expect(app.getByRole("button", { name: "Metronome" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("the Speed Trainer speeds up after each loop", async ({ app }) => {
    await openSong(app);
    await goToBar(app, 4);
    await emitMenuAction(app, "speed-trainer");
    const dialog = app.getByRole("dialog", { name: "Speed Trainer" });
    await expect(dialog.getByRole("spinbutton", { name: "From bar" })).toHaveValue("4");
    await dialog.getByRole("spinbutton", { name: "Start speed" }).fill("100");
    await dialog.getByRole("spinbutton", { name: "Target speed" }).fill("200");
    await dialog.getByRole("spinbutton", { name: "Increase by" }).fill("50");
    await dialog.getByRole("button", { name: "Start" }).click();

    // It starts playing bar 4 (2 s at 120 BPM) at 100%, then 150%, then 200%.
    await expect(app.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(app.getByText("Trainer 100% → 200%")).toBeVisible();
    await expect(app.getByText("Trainer 150% → 200%")).toBeVisible({ timeout: 10_000 });
    await expect(app.getByText("180 BPM")).toBeVisible();
    await expect(app.getByText("Trainer 200% → 200%")).toBeVisible({ timeout: 10_000 });

    await app.getByRole("button", { name: "Stop the Speed Trainer" }).click();
    await expect(app.getByRole("button", { name: "Speed Trainer…" })).toBeVisible();
  });
});
