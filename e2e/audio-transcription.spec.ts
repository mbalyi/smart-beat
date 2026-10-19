import type { Page } from "@playwright/test";

import features from "../src/lib/features.json" with { type: "json" };

import { emitMenuAction, expect, expectNoA11yViolations, openSong, tabKey, test } from "./fixtures";

declare global {
  interface Window {
    __transcription: {
      configured: boolean;
      midiBase64: string;
      cancelled: string[];
      requests: Record<string, string>[];
    };
  }
}

/** Import from Audio (#88), with the transcription commands mocked in e2e/tauri-mock.js. */

/** A one-track Standard MIDI File: C4, E4, G4 as guitar quarter notes at 120 BPM. */
function midiBase64(): string {
  const notes = [60, 64, 67].flatMap((n) => [0x00, 0x90, n, 96, 0x83, 0x60, 0x80, n, 0]);
  const events = [0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, 0x00, 0xc0, 25, ...notes];
  const track = [...events, 0x00, 0xff, 0x2f, 0x00];
  const length = [24, 16, 8, 0].map((shift) => (track.length >> shift) & 0xff);
  const header = [0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0];
  return Buffer.from([
    ...Buffer.from("MThd"),
    ...header,
    ...Buffer.from("MTrk"),
    ...length,
    ...track,
  ]).toString("base64");
}

/**
 * A four-second mono 16-bit WAV of silence. Every webview reads its length; WebKit on Linux has no
 * MP3 decoder, so an MP3 would never show its duration there.
 */
function wavFile(seconds = 4, rate = 8000) {
  const data = rate * seconds * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data, 40);
  return {
    name: "recording.wav",
    mimeType: "audio/wav",
    buffer: Buffer.concat([header, Buffer.alloc(data)]),
  };
}
const RECORDING = wavFile();

/** MuScriptor is on this computer and the terms are accepted. */
async function installModel(app: Page) {
  await app.evaluate(() => {
    window.__muscriptor.termsAccepted = true;
    window.__muscriptor.installed.medium = true;
  });
}

async function openDialog(app: Page, { installed = true } = {}) {
  if (installed) await installModel(app);
  await app.evaluate((midi) => {
    window.__transcription.midiBase64 = midi;
  }, midiBase64());
  const welcome = app.getByRole("button", { name: "Import from Audio…" });
  if (await welcome.isVisible()) await welcome.click();
  else {
    // An open song: the File menu beside Open.
    await app.getByRole("button", { name: "File" }).click();
    await app.getByRole("menuitem", { name: "Import from Audio…" }).click();
  }
  const dialog = app.getByRole("dialog", { name: "Import from Audio" });
  await expect(dialog).toBeVisible();
  return dialog;
}

// Import from Audio is hidden until the audio-2-tab feature is switched on.
test.describe("Import from Audio (#88)", () => {
  test.skip(!features["audio-2-tab"], "audio-2-tab is off in src/lib/features.json");

  test("transcribes a recording, previews it and opens the MIDI as a new song", async ({ app }) => {
    const dialog = await openDialog(app);
    await expect(dialog.getByText(/transcribed on this computer/)).toBeVisible();

    await dialog.getByLabel("Choose an audio recording").setInputFiles(RECORDING);
    await expect(dialog.getByText("recording.wav")).toBeVisible();
    // The webview reads the duration before anything is uploaded.
    await expect(dialog.getByText(/MiB · \d+:\d\d/)).toBeVisible();

    await dialog.getByLabel("Search instruments").fill("bass guitar");
    await dialog.getByRole("button", { name: "electric bass" }).click();
    await expect(dialog.getByRole("button", { name: "Remove electric bass" })).toBeVisible();

    await dialog.getByRole("button", { name: "Transcribe" }).click();
    await expect(dialog.getByRole("heading", { name: "Generated MIDI preview" })).toBeVisible();
    await expect(
      dialog.getByRole("img", { name: "Transcribed notes by instrument" }),
    ).toBeVisible();

    expect(await app.evaluate(() => window.__transcription.requests)).toEqual([
      expect.objectContaining({
        "file-type": "wav",
        instruments: "electric_bass",
        "model-size": "medium",
      }),
    ]);

    await dialog.getByRole("button", { name: "Import MIDI into Smart Beat" }).click();
    await expect(dialog).toBeHidden();
    await expect(app.getByRole("heading", { name: "recording" })).toBeVisible();

    // The song exists only in memory, so closing it asks first.
    await expect(app.getByText("Edited")).toBeVisible();
    await app.getByRole("button", { name: "Close recording" }).click();
    await expect(app.getByRole("alertdialog")).toBeVisible();
  });

  test("opens from the File menu while a song is open, works by keyboard and keeps that song", async ({
    app,
    browserName,
  }) => {
    await openSong(app);
    const dialog = await openDialog(app);
    await app.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(app.getByRole("heading", { name: "Practice Song" })).toBeVisible();

    await emitMenuAction(app, "import-audio");
    await expect(dialog).toBeVisible();
    // Keyboard only: Tab reaches the recording picker inside the dialog, Escape closes it.
    const choose = dialog.getByRole("button", { name: "Choose recording…" });
    for (let i = 0; i < 6 && !(await choose.evaluate((e) => e === document.activeElement)); i++) {
      await app.keyboard.press(tabKey(browserName));
    }
    await expect(choose).toBeFocused();
    await app.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(app.getByRole("heading", { name: "Practice Song" })).toBeVisible();
  });

  test("offers the download first when MuScriptor is not on this computer", async ({ app }) => {
    const dialog = await openDialog(app, { installed: false });
    await expect(dialog.getByTestId("audio-needs-model")).toBeVisible();
    await expect(dialog.getByLabel("Choose an audio recording")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Transcribe" })).toHaveCount(0);
    // The dialog steps aside for the installer.
    await dialog.getByRole("button", { name: "Download MuScriptor" }).click();
    await expect(dialog).toBeHidden();
    await expect(app.getByRole("dialog", { name: "Powered by MuScriptor" })).toBeVisible();
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`has no WCAG violations at 375 px in ${colorScheme} mode`, async ({ app }) => {
      await app.setViewportSize({ width: 375, height: 812 });
      await app.emulateMedia({ colorScheme });
      const dialog = await openDialog(app);
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });

      await dialog.getByLabel("Choose an audio recording").setInputFiles(RECORDING);
      await dialog.getByRole("button", { name: "Transcribe" }).click();
      await expect(dialog.getByRole("heading", { name: "Generated MIDI preview" })).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
      expect(await dialog.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
    });
  }
});
