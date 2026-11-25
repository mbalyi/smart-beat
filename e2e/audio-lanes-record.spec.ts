import type { Page } from "@playwright/test";

import { emitMenuAction, expect, expectNoA11yViolations, openSong, test } from "./fixtures";

/**
 * Recording straight onto an audio lane (#249): the record icon on every lane (off, armed,
 * recording), the live input heard through the lane's own effects, the lane's clips quiet under
 * the take, Escape throwing the take away, and the keyboard flow. The engine and the microphone
 * are fakes (a tone), so only what the app asks of them is checked.
 */
test.use({ viewport: { width: 1280, height: 1000 } });

/** A microphone that plays a tone (a real one would ask for permission). */
async function installMicrophone(app: Page) {
  await app.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => [
          { kind: "audioinput", deviceId: "mic", label: "Test microphone", groupId: "" },
        ],
        getUserMedia: async () => {
          const context = new AudioContext();
          const tone = context.createOscillator();
          const destination = context.createMediaStreamDestination();
          tone.connect(destination);
          tone.start();
          return destination.stream;
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
  });
  await app.reload();
  await expect(app.getByRole("heading", { level: 1 })).toBeVisible();
}

/** A song with the native engine on, one lane called "take" with a Delay in its effect chain. */
async function openWithEffectLane(app: Page, options: { hear?: boolean } = {}) {
  await installMicrophone(app);
  await openSong(app);
  await app.getByRole("switch", { name: "Native engine with effects" }).click();
  await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
  await app.evaluate((path) => (window.__dialogResult = path), "/Users/me/Music/take.mp3");
  await emitMenuAction(app, "import-audio-file");
  await expect(app.getByRole("button", { name: "Edit the lane take" })).toBeVisible();
  // Without a count-in the take starts at once. Hearing the input is the player's choice here (the
  // system default input may be the computer's own microphone, which is not heard by default).
  await app.evaluate((hear) => {
    localStorage.setItem(
      "smart-beat:record-audio-setup",
      JSON.stringify({ mode: "playhead", countIn: false, preRollBars: 0 }),
    );
    if (hear) localStorage.setItem("smart-beat:record-hear-myself", "1");
    else localStorage.removeItem("smart-beat:record-hear-myself");
  }, options.hear ?? true);
  await app.getByRole("button", { name: "Effects of take" }).click();
  await app
    .getByRole("dialog", { name: /Pedalboard/ })
    .getByRole("button", { name: "Add Delay" })
    .click();
  await app.keyboard.press("Escape");
  await expect(app.getByRole("dialog", { name: /Pedalboard/ })).toBeHidden();
}

const recordIcon = (app: Page) => app.getByRole("button", { name: "Record on the lane take" });
const laneClips = (app: Page) =>
  app.evaluate(() => window.__engineLanes?.audio.lanes[0]?.clips.length ?? 0);

test.describe("record icon on an audio lane", () => {
  test("arms the lane and plays the input through the lane's effects", async ({ app }) => {
    await openWithEffectLane(app);
    await expect(recordIcon(app)).toHaveAttribute("aria-pressed", "false");
    await recordIcon(app).click();
    await expect(recordIcon(app)).toHaveAttribute("aria-pressed", "true");
    const bar = app.getByRole("region", { name: "Armed lane" });
    await expect(bar).toContainText("take is armed");
    await expect(bar).toContainText("System default, input 1");
    // The monitor track plays the input with the lane's effect chain: nothing was added to the song.
    await expect.poll(() => app.evaluate(() => window.__engineMonitor?.params.enabled)).toBe(true);
    await expect
      .poll(() => app.evaluate(() => window.__engineChains?.monitor?.map((s) => s.type)))
      .toEqual(["delay"]);
    // No take started by arming.
    await expect(app.getByRole("region", { name: "Recording" })).toBeHidden();

    // Hear myself off: the input is no longer played; letting go gives the song's monitor back.
    await bar.getByRole("switch", { name: "Hear myself" }).click();
    await expect
      .poll(() => app.evaluate(() => !!window.__engineMonitor?.params.enabled))
      .toBe(false);
    await bar.getByRole("switch", { name: "Hear myself" }).click();
    await expect.poll(() => app.evaluate(() => window.__engineMonitor?.params.enabled)).toBe(true);
    await bar.getByRole("button", { name: "Disarm the lane" }).click();
    await expect(recordIcon(app)).toHaveAttribute("aria-pressed", "false");
    await expect
      .poll(() => app.evaluate(() => !!window.__engineMonitor?.params.enabled))
      .toBe(false);
  });

  test("does not play the system default input until the player turns Hear myself on", async ({
    app,
  }) => {
    await openWithEffectLane(app, { hear: false });
    await recordIcon(app).click();
    const bar = app.getByRole("region", { name: "Armed lane" });
    await expect(bar).toBeVisible();
    // The default device may be the laptop's own microphone: nothing is played until it is chosen.
    await expect(bar.getByRole("switch", { name: "Hear myself" })).not.toBeChecked();
    await expect(bar.getByRole("alert")).toBeHidden();
    expect(await app.evaluate(() => !!window.__engineMonitor?.params.enabled)).toBe(false);
    // Turning it on plays it, and warns that speakers would feed back into that microphone.
    await bar.getByRole("switch", { name: "Hear myself" }).click();
    await expect.poll(() => app.evaluate(() => window.__engineMonitor?.params.enabled)).toBe(true);
    await expect(bar.getByRole("alert")).toContainText("use headphones");
  });

  test("keeps the lane's own clips quiet under the take, and Stop adds one clip", async ({
    app,
  }) => {
    await openWithEffectLane(app);
    await expect.poll(() => laneClips(app)).toBe(1);
    await recordIcon(app).click();
    await recordIcon(app).click();
    const recording = app.getByRole("region", { name: "Recording" });
    await expect(recording).toBeVisible();
    await expect(recordIcon(app)).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => laneClips(app)).toBe(0);
    await expect(app.getByLabel("Time recorded")).not.toHaveText("0:00", { timeout: 10_000 });

    // Pressing the same icon stops the take and keeps it: its clip comes next to the old one.
    await recordIcon(app).click();
    await expect.poll(() => laneClips(app), { timeout: 20_000 }).toBe(2);
    await expect(recording).toBeHidden();
    // One take: one lane, still armed for the next one.
    await expect(app.locator("[data-testid^='lane-row-']")).toHaveCount(1);
    await expect(recordIcon(app)).toHaveAttribute("aria-pressed", "true");
  });

  test("Escape throws the take away and adds nothing", async ({ app }) => {
    await openWithEffectLane(app);
    await recordIcon(app).click();
    await recordIcon(app).click();
    await expect(app.getByRole("region", { name: "Recording" })).toBeVisible();
    await expect(app.getByLabel("Time recorded")).not.toHaveText("0:00", { timeout: 10_000 });
    await app.keyboard.press("Escape");
    await expect(app.getByRole("region", { name: "Recording" })).toBeHidden();
    // The old clip is back for the engine, and no new clip or source was made.
    await expect.poll(() => laneClips(app)).toBe(1);
    await expect(app.locator("[data-testid^='lane-row-']")).toHaveCount(1);
    expect(Object.keys(await app.evaluate(() => window.__engineSources))).not.toContain(
      "e".repeat(64),
    );
  });

  test("a take on a new lane keeps the armed lane's clips audible", async ({ app }) => {
    await openWithEffectLane(app);
    await recordIcon(app).click();
    await app.getByRole("button", { name: "Record audio" }).click();
    const dialog = app.getByRole("dialog", { name: "Record audio" });
    await dialog.getByLabel("Record to").selectOption({ label: "A new lane" });
    await dialog.getByRole("button", { name: "Start recording" }).click();
    await expect(app.getByRole("region", { name: "Recording" })).toBeVisible();
    // The armed lane is not the destination: its clip keeps playing under the take.
    await expect.poll(() => laneClips(app)).toBe(1);
    await app.keyboard.press("Escape");
    await expect(app.getByRole("region", { name: "Recording" })).toBeHidden();
    await expect.poll(() => laneClips(app)).toBe(1);
  });

  for (const ending of ["Stop", "Escape"] as const) {
    test(`a take from the Record audio dialog on an unarmed lane leaves its clips audible after ${ending}`, async ({
      app,
    }) => {
      await openWithEffectLane(app);
      await expect.poll(() => laneClips(app)).toBe(1);
      await app.getByRole("button", { name: "Record audio" }).click();
      const dialog = app.getByRole("dialog", { name: "Record audio" });
      await dialog.getByLabel("Record to").selectOption({ label: "take" });
      await dialog.getByRole("button", { name: "Start recording" }).click();
      const recording = app.getByRole("region", { name: "Recording" });
      await expect(recording).toBeVisible();
      // The lane is not armed, but its own clips are quiet under the take.
      await expect(recordIcon(app)).toHaveAttribute("aria-pressed", "false");
      await expect.poll(() => laneClips(app)).toBe(0);
      await expect(app.getByLabel("Time recorded")).not.toHaveText("0:00", { timeout: 10_000 });
      if (ending === "Stop") await recording.getByRole("button", { name: "Stop" }).click();
      else await app.keyboard.press("Escape");
      await expect(recording).toBeHidden();
      // Back to normal: the old clip (and the new one after Stop) play again.
      await expect.poll(() => laneClips(app), { timeout: 20_000 }).toBe(ending === "Stop" ? 2 : 1);
    });
  }

  test("works with the keyboard alone", async ({ app }) => {
    await openWithEffectLane(app);
    await recordIcon(app).focus();
    await app.keyboard.press("Enter");
    await expect(recordIcon(app)).toHaveAttribute("aria-pressed", "true");
    await expect(app.getByRole("region", { name: "Armed lane" })).toBeVisible();
    await app.keyboard.press("Enter");
    await expect(app.getByRole("region", { name: "Recording" })).toBeVisible();
    await expect(app.getByLabel("Time recorded")).not.toHaveText("0:00", { timeout: 10_000 });
    await app.keyboard.press("Escape");
    await expect(app.getByRole("region", { name: "Recording" })).toBeHidden();
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the armed and recording lane pass the accessibility checks in ${colorScheme} mode`, async ({
      app,
    }) => {
      await app.emulateMedia({ colorScheme });
      await openWithEffectLane(app);
      await recordIcon(app).click();
      await expect(app.getByRole("region", { name: "Armed lane" })).toBeVisible();
      await expectNoA11yViolations(app);
      await recordIcon(app).click();
      await expect(app.getByRole("region", { name: "Recording" })).toBeVisible();
      await expectNoA11yViolations(app);
    });
  }
});
