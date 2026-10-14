import type { Page } from "@playwright/test";

import features from "../src/lib/features.json" with { type: "json" };
import {
  emitMenuAction,
  expect,
  expectNoA11yViolations,
  newSong,
  openSong,
  tabNumbers,
  test,
} from "./fixtures";

/**
 * Record to Tab (#108). A fake microphone plays a tone; the mocked Rust core answers with a few
 * open-string notes and a chord (e2e/tauri-mock.js). Until the real `recording.ts` is merged,
 * the tests that read the tab can't pass: they are marked below.
 */

test.skip(!features["record-2-tab"], "record-2-tab is off in src/lib/features.json");

declare global {
  interface Window {
    __recordTranscription: {
      requests: { sampleRate: number; bytes: number; instrument?: string; engine?: string }[];
      cancelled: number;
      hold: boolean;
      fail: string | null;
      shift: number;
      release: (() => void) | null;
    };
    __pianoModel: { installed: boolean; downloads: number; fail: string | null };
  }
}

/** Two inputs, and a microphone that plays a tone (a real one would ask for permission). */
async function installMicrophone(page: Page) {
  await page.addInitScript(() => {
    const inputs = [
      { kind: "audioinput", deviceId: "built-in", label: "MacBook Pro Microphone", groupId: "" },
      { kind: "audioinput", deviceId: "scarlett", label: "Scarlett 2i2 USB", groupId: "" },
    ];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => inputs,
        getUserMedia: async () => {
          const context = new AudioContext();
          const tone = context.createOscillator();
          tone.frequency.value = 110;
          const gain = context.createGain();
          gain.gain.value = 0.3;
          const destination = context.createMediaStreamDestination();
          tone.connect(gain).connect(destination);
          tone.start();
          return destination.stream;
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
  });
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

/** Waits until the take holds a second of sound: a fixed wait can end it too soon on a busy machine. */
/**
 * Waiting for the take to be drawn: the score re-renders after the take is added, which takes
 * several seconds when the machine is busy (the count-in and the render share one CPU with the
 * other workers), so these waits are generous.
 */
const DRAWN = { timeout: 20_000 };

async function untilRecorded(page: Page) {
  await expect(page.getByLabel("Time recorded")).not.toHaveText("0:00", { timeout: 10_000 });
}

async function openRecordDialog(page: Page) {
  await page.getByRole("button", { name: "File" }).click();
  await page.getByRole("menuitem", { name: /^Record to Tab…/ }).click();
  const dialog = page.getByRole("dialog", { name: /^Record to Tab/ });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("Record to Tab (#108)", () => {
  test.beforeEach(async ({ app }) => {
    await installMicrophone(app);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the dialog and the recording bar have no WCAG violations in ${colorScheme} mode`, async ({
      app,
    }) => {
      await app.emulateMedia({ colorScheme });
      await newSong(app);
      const dialog = await openRecordDialog(app);
      await expect(dialog.getByRole("meter", { name: "Input level" })).toBeVisible();
      await expect(dialog.getByText("Asking for the microphone…")).toBeHidden();
      await expectNoA11yViolations(app);
      await dialog.getByRole("radio", { name: "File" }).click();
      await expect(dialog.getByRole("region", { name: "Audio drop area" })).toBeVisible();
      await expectNoA11yViolations(app);
      await dialog.getByRole("radio", { name: "Free" }).click();
      await expectNoA11yViolations(app);

      await dialog.getByRole("button", { name: "Record" }).click();
      const bar = app.getByRole("region", { name: "Recording" });
      await expect(bar.getByRole("status")).toHaveText("Recording");
      await expectNoA11yViolations(app);
      await app.keyboard.press("Space");
    });
  }

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the piano dialog has no WCAG violations in ${colorScheme} mode`, async ({ app }) => {
      await app.emulateMedia({ colorScheme });
      await newSong(app);
      const dialog = await openRecordDialog(app);
      await dialog.getByRole("radio", { name: "Piano" }).click();
      // A piano has no strings to tune.
      await expect(dialog.getByRole("combobox", { name: "Tuning" })).toBeHidden();
      await expectNoA11yViolations(app);
      await dialog.getByRole("radio", { name: "File" }).click();
      await expect(dialog.getByText(/Choose a piano recording/)).toBeVisible();
      await expectNoA11yViolations(app);
    });
  }

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the high-accuracy piano model choice has no WCAG violations in ${colorScheme} mode`, async ({
      app,
    }) => {
      await app.emulateMedia({ colorScheme });
      await newSong(app);
      const dialog = await openRecordDialog(app);
      await dialog.getByRole("radio", { name: "Piano" }).click();
      await dialog.getByRole("radio", { name: "High accuracy" }).click();
      await expect(dialog.getByRole("button", { name: "Download the model" })).toBeVisible();
      await expectNoA11yViolations(app);
    });
  }

  test("piano: the high-accuracy model is downloaded once, then used", async ({ app }) => {
    test.slow();
    await newSong(app);
    const dialog = await openRecordDialog(app);
    await dialog.getByRole("radio", { name: "Piano" }).click();
    await dialog.getByRole("radio", { name: "High accuracy" }).click();
    // Without the model, recording waits for the download.
    await expect(dialog.getByText(/one-time download of 57 MB/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Record" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Download the model" }).click();
    await expect(dialog.getByRole("button", { name: "Download the model" })).toBeHidden();
    await expect(dialog.getByRole("button", { name: "Record" })).toBeEnabled();
    expect(await app.evaluate(() => window.__pianoModel.downloads)).toBe(1);

    await dialog.getByRole("radio", { name: "Free" }).click();
    await dialog.getByRole("button", { name: "Record" }).click();
    const bar = app.getByRole("region", { name: "Recording" });
    await expect(bar.getByRole("status")).toHaveText("Recording");
    await untilRecorded(app);
    await bar.getByRole("button", { name: "Stop" }).click();
    await expect
      .poll(() => app.evaluate(() => window.__recordTranscription.requests.length))
      .toBe(1);
    const [request] = await app.evaluate(() => window.__recordTranscription.requests);
    expect(request).toMatchObject({ instrument: "piano", engine: "transkun" });
    await expect(app.getByRole("heading", { level: 1, name: "Recording" })).toBeVisible();
  });

  test("piano: a failed model download is reported and can be tried again", async ({ app }) => {
    await newSong(app);
    await app.evaluate(() => {
      window.__pianoModel.fail = "The downloaded piano model is not the expected file.";
    });
    const dialog = await openRecordDialog(app);
    await dialog.getByRole("radio", { name: "Piano" }).click();
    await dialog.getByRole("radio", { name: "High accuracy" }).click();
    await dialog.getByRole("button", { name: "Download the model" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(/not the expected file/);
    await expect(dialog.getByRole("button", { name: "Record" })).toBeDisabled();
    await app.evaluate(() => {
      window.__pianoModel.fail = null;
    });
    await dialog.getByRole("button", { name: "Download the model" }).click();
    await expect(dialog.getByRole("button", { name: "Record" })).toBeEnabled();
  });

  test("piano: free mode opens a right-hand and a left-hand track", async ({ app }) => {
    test.slow();
    await newSong(app);
    const dialog = await openRecordDialog(app);
    await dialog.getByRole("radio", { name: "Piano" }).click();
    await dialog.getByRole("radio", { name: "Free" }).click();
    await dialog.getByRole("button", { name: "Record" }).click();
    const bar = app.getByRole("region", { name: "Recording" });
    await expect(bar.getByRole("status")).toHaveText("Recording");
    await untilRecorded(app);
    await bar.getByRole("button", { name: "Stop" }).click();

    await expect
      .poll(() => app.evaluate(() => window.__recordTranscription.requests.length))
      .toBe(1);
    const [request] = await app.evaluate(() => window.__recordTranscription.requests);
    expect(request!.instrument).toBe("piano");
    await expect(app.getByRole("heading", { level: 1, name: "Recording" })).toBeVisible();
    await expect(app.getByText("Recording (left hand)")).toBeVisible();
    // Piano notes are staff notes: there are no fret numbers.
    await expect.poll(() => tabNumbers(app), DRAWN).toEqual([]);
  });

  test("the instruments: a crown on the chosen one, bass strings, and drums that are not there yet", async ({
    app,
  }) => {
    await newSong(app);
    const dialog = await openRecordDialog(app);
    const crowned = (name: string) => dialog.getByRole("radio", { name }).locator("[data-crown]");
    await expect(crowned("Guitar")).toHaveCount(1);
    await expect(crowned("Piano")).toHaveCount(0);
    await expect(dialog.getByRole("radio", { name: "Drums, coming soon" })).toBeDisabled();
    await dialog.getByRole("radio", { name: "Bass" }).click();
    await expect(crowned("Bass")).toHaveCount(1);
    await expect(crowned("Guitar")).toHaveCount(0);
    await dialog.getByRole("combobox", { name: "Track" }).click();
    await app.getByRole("option", { name: "New track" }).click();
    await expect(dialog.getByRole("combobox", { name: "Strings" })).toHaveText("4 strings");
    await dialog.getByRole("radio", { name: "Piano" }).click();
    await expect(crowned("Piano")).toHaveCount(1);
    await expect(dialog.getByRole("combobox", { name: "Strings" })).toBeHidden();
    await expect(dialog.getByRole("img", { name: "Beta" })).toBeVisible();
  });

  test("a record button in the header opens the dialog and names itself on hover", async ({
    app,
  }) => {
    await newSong(app);
    const record = app.getByRole("button", { name: "Record to Tab" });
    await expect(record).toBeVisible();
    // Next to the File menu, which still lists Record to Tab as well.
    const file = app.getByRole("button", { name: "File" });
    const [recordBox, fileBox] = [await record.boundingBox(), await file.boundingBox()];
    expect(recordBox!.x).toBeLessThan(fileBox!.x);
    expect(Math.abs(recordBox!.y - fileBox!.y)).toBeLessThan(10);
    await record.hover();
    await expect(app.getByRole("tooltip", { name: "Record to Tab…" })).toBeVisible();
    await record.click();
    await expect(app.getByRole("dialog", { name: /^Record to Tab/ })).toBeVisible();
    await app.keyboard.press("Escape");
    await file.click();
    await expect(app.getByRole("menuitem", { name: /^Record to Tab…/ })).toBeVisible();
  });

  test("the dialog works at a narrow width", async ({ app }) => {
    await app.setViewportSize({ width: 480, height: 600 });
    await newSong(app);
    const dialog = await openRecordDialog(app);
    await dialog.getByRole("combobox", { name: "Track" }).click();
    await app.getByRole("option", { name: "New track" }).click();
    await expect(dialog.getByRole("combobox", { name: "Tuning" })).toBeVisible();
    expect(await app.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(480);
    await expect(dialog.getByRole("button", { name: "Record" })).toBeVisible();
  });

  test("the dialog fits a laptop screen without a scrollbar", async ({ app }) => {
    await app.setViewportSize({ width: 1280, height: 800 });
    await newSong(app);
    const dialog = await openRecordDialog(app);
    // A new track asks for the tuning too: the tallest the click mode gets.
    await dialog.getByRole("combobox", { name: "Track" }).click();
    await app.getByRole("option", { name: "New track" }).click();
    await expect(dialog.getByRole("combobox", { name: "Tuning" })).toBeVisible();
    const body = dialog.locator("[data-slot=dialog-body]");
    for (const mode of ["Click", "Free", "File"]) {
      await dialog.getByRole("radio", { name: mode }).click();
      const { scroll, client } = await body.evaluate((el) => ({
        scroll: el.scrollHeight,
        client: el.clientHeight,
      }));
      expect(scroll, `${mode} mode`).toBeLessThanOrEqual(client);
    }
  });

  test("the Record link next to Tuner opens the dialog for that track", async ({ app }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Fretboard" }).click();
    await app
      .getByRole("region", { name: "Fretboard" })
      .getByRole("button", { name: /^Record…/ })
      .click();
    const dialog = app.getByRole("dialog", { name: /^Record to Tab/ });
    await expect(dialog.getByRole("combobox", { name: "Track" })).toHaveText("Guitar");
    await app.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("free mode: records, transcribes and opens the take as a new song", async ({ app }) => {
    // Renders two songs (the new song, then the take): WebKit can need more than 30 s.
    test.slow();
    await newSong(app);
    const dialog = await openRecordDialog(app);
    await dialog.getByRole("radio", { name: "Free" }).click();
    await dialog.getByRole("button", { name: "Record" }).click();
    await expect(dialog).toBeHidden();

    const bar = app.getByRole("region", { name: "Recording" });
    await expect(bar.getByRole("status")).toHaveText("Recording");
    await untilRecorded(app);
    await bar.getByRole("button", { name: "Stop" }).click();

    // The mocked core got the samples (little-endian f32) and the rate.
    await expect
      .poll(() => app.evaluate(() => window.__recordTranscription.requests.length))
      .toBe(1);
    const [request] = await app.evaluate(() => window.__recordTranscription.requests);
    expect(request!.sampleRate).toBeGreaterThan(8000);
    expect(request!.bytes % 4).toBe(0);
    expect(request!.bytes).toBeGreaterThan(request!.sampleRate * 4);

    // Needs the merged recording.ts: the notes become tab in a new song.
    await expect(app.getByRole("heading", { level: 1, name: "Recording" })).toBeVisible();
    await expect
      .poll(async () => (await tabNumbers(app)).slice(0, 3), DRAWN)
      .toEqual(["0", "0", "0"]);
    await expect(app.getByText("Edited")).toBeVisible();
  });

  test("click mode: the take goes on the song's track as one undo step", async ({ app }) => {
    test.slow();
    await newSong(app);
    // The count-in at 120 BPM in 4/4 is two seconds; the mocked notes come after it.
    await app.evaluate(() => {
      window.__recordTranscription.shift = 2;
    });
    const dialog = await openRecordDialog(app);
    await expect(dialog.getByRole("combobox", { name: "Track" })).toHaveText("Guitar");
    await expect(dialog.getByRole("spinbutton", { name: "Start bar" })).toHaveValue("1");
    await dialog.getByRole("button", { name: "Record" }).click();

    const bar = app.getByRole("region", { name: "Recording" });
    await expect(bar.getByRole("status")).toHaveText("Count-in…");
    await expect(bar.getByRole("status")).toHaveText("Recording", { timeout: 15_000 });
    await app.waitForTimeout(1500);
    await app.keyboard.press("Space");

    await expect
      .poll(() => app.evaluate(() => window.__recordTranscription.requests.length))
      .toBe(1);
    // Needs the merged recording.ts. Open low E is string 1, fret 0.
    // Where the notes land depends on the real clocks (when playback started against when the
    // take began), which drift by up to a second on a busy machine, so only check that the
    // take was written: open strings are drawn. The timing is covered by take-timing.test.ts.
    await expect.poll(async () => (await tabNumbers(app)).length, DRAWN).toBeGreaterThan(2);
    expect(await tabNumbers(app)).toContain("0");
    await expect(app.getByText("Added your take to “Guitar”")).toBeVisible(DRAWN);

    await emitMenuAction(app, "undo");
    await expect.poll(() => tabNumbers(app), DRAWN).toEqual([]);
  });

  test("click mode on a new track adds the track", async ({ app }) => {
    test.slow();
    await newSong(app);
    await app.evaluate(() => {
      window.__recordTranscription.shift = 2;
    });
    const dialog = await openRecordDialog(app);
    await dialog.getByRole("combobox", { name: "Track" }).click();
    await app.getByRole("option", { name: "New track" }).click();
    await dialog.getByRole("button", { name: "Record" }).click();
    const bar = app.getByRole("region", { name: "Recording" });
    await expect(bar.getByRole("status")).toHaveText("Recording", { timeout: 15_000 });
    await app.keyboard.press("Space");
    // Needs the merged recording.ts.
    await expect(app.getByText("Added your take to “Recording”")).toBeVisible(DRAWN);
    // Where the notes land depends on the real clocks (when playback started against when the
    // take began), which drift by up to a second on a busy machine, so only check that the
    // take was written: open strings are drawn. The timing is covered by take-timing.test.ts.
    await expect.poll(async () => (await tabNumbers(app)).length, DRAWN).toBeGreaterThan(2);
    expect(await tabNumbers(app)).toContain("0");
  });

  test("Escape during the count-in throws the take away", async ({ app }) => {
    await newSong(app);
    const dialog = await openRecordDialog(app);
    await dialog.getByRole("button", { name: "Record" }).click();
    const bar = app.getByRole("region", { name: "Recording" });
    await expect(bar.getByRole("status")).toHaveText("Count-in…");
    await app.keyboard.press("Escape");
    await expect(bar).toBeHidden();
    expect(await app.evaluate(() => window.__recordTranscription.requests.length)).toBe(0);
  });

  test("Cancel stops the transcription and leaves the song alone", async ({ app }) => {
    await newSong(app);
    await app.evaluate(() => {
      window.__recordTranscription.hold = true;
    });
    const dialog = await openRecordDialog(app);
    await dialog.getByRole("radio", { name: "Free" }).click();
    await dialog.getByRole("button", { name: "Record" }).click();
    const bar = app.getByRole("region", { name: "Recording" });
    await expect(bar.getByRole("status")).toHaveText("Recording");
    await untilRecorded(app);
    await app.keyboard.press("Space");
    await expect(bar.getByRole("status")).toHaveText("Transcribing…");
    await bar.getByRole("button", { name: "Cancel" }).click();
    await expect(bar).toBeHidden();
    expect(await app.evaluate(() => window.__recordTranscription.cancelled)).toBe(1);
    await expect(app.getByText("Transcription stopped")).toBeVisible();
    await expect(app.getByRole("heading", { level: 1, name: "Untitled" })).toBeVisible();
  });

  test("a failed transcription is reported", async ({ app }) => {
    await newSong(app);
    await app.evaluate(() => {
      window.__recordTranscription.fail = "The model could not be loaded.";
    });
    const dialog = await openRecordDialog(app);
    await dialog.getByRole("radio", { name: "Free" }).click();
    await dialog.getByRole("button", { name: "Record" }).click();
    await expect(app.getByRole("region", { name: "Recording" }).getByRole("status")).toHaveText(
      "Recording",
    );
    await untilRecorded(app);
    await app.keyboard.press("Space");
    await expect(app.getByText("Couldn't turn your take into tab")).toBeVisible();
    await expect(app.getByText("The model could not be loaded.")).toBeVisible();
  });

  test("counts the finished take once", async ({ app }) => {
    await newSong(app);
    const dialog = await openRecordDialog(app);
    await dialog.getByRole("radio", { name: "Free" }).click();
    await dialog.getByRole("button", { name: "Record" }).click();
    await untilRecorded(app);
    await app.keyboard.press("Space");
    // Needs the merged recording.ts: a take that is not turned into tab is not counted.
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            window.__ipcCalls.filter(
              (c) =>
                c.cmd === "track_event" && (c.args as { event?: string }).event === "record_to_tab",
            ).length,
        ),
      )
      .toBe(1);
  });
});
