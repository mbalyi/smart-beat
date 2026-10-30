import {
  dropFiles,
  emitMenuAction,
  expect,
  expectNoA11yViolations,
  openSong,
  test,
} from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * The audio track (#38): add a recording, see its waveform on the bars, sync
 * bars to it, transpose and filter it, and save it with the song. Decoding
 * and playback are in the (mocked) engine.
 */

async function addRecording(app: Page, file = "/Users/me/Music/take.mp3") {
  await openSong(app);
  await app.getByRole("switch", { name: "Native engine with effects" }).click();
  await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
  await app.evaluate((path) => (window.__dialogResult = path), file);
  await emitMenuAction(app, "add-audio-track");
  const editor = app.getByRole("region", { name: "Audio track" });
  await expect(editor.getByTestId("audio-waveform")).toBeVisible();
  return editor;
}

test.describe("audio track (#38)", () => {
  // Regression (found while testing #41): any dropped file was opened as a
  // song, so a recording dropped on an open song was never added.
  test("a recording dropped on the window becomes the audio track", async ({ app }) => {
    await openSong(app);
    await app.getByRole("switch", { name: "Native engine with effects" }).click();
    await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
    await dropFiles(app, ["/Users/me/Music/take.mp3"]);
    const editor = app.getByRole("region", { name: "Audio track" });
    await expect(editor.getByTestId("audio-waveform")).toBeVisible();
    await expect(app.getByText(/is not a Guitar Pro file/)).toHaveCount(0);
  });

  test("adds a recording, shows its waveform and mixes it", async ({ app }) => {
    const editor = await addRecording(app);
    await expect(editor.getByText(/take\.mp3 · 0:04\.00/)).toBeVisible();
    const row = app.getByTestId("audio-track-row");
    await expect(row.getByRole("button", { name: "Edit the audio track take.mp3" })).toBeVisible();
    await row.getByRole("button", { name: "Solo the audio track" }).click();
    await expect
      .poll(() => app.evaluate(() => window.__engineBacking?.source))
      .toEqual({ type: "file", path: "/Users/me/Music/take.mp3" });
    await expectNoA11yViolations(app);
  });

  test("syncs bars to the recording with sync points", async ({ app }) => {
    const editor = await addRecording(app);
    const waveform = editor.getByTestId("audio-waveform");
    const box = (await waveform.boundingBox())!;
    // Bar lines are 40 px apart at the default zoom: double-click near bar 3's.
    await waveform.dblclick({ position: { x: 82, y: box.height / 2 } });
    const marker = editor.getByRole("slider", { name: "Sync point at bar 3" });
    await expect(marker).toBeVisible();
    await marker.focus();
    await app.keyboard.press("Shift+ArrowRight");
    await expect(marker).toHaveAttribute("aria-valuetext", /in the recording/);
    const before = Number(await marker.getAttribute("aria-valuenow"));
    // hover() waits for the marker to be stable and to be the element under the
    // pointer; a bounding box read once (and used as raw mouse coordinates) can
    // be stale after the keyboard re-render, so the press would miss the handle.
    await marker.hover({ position: { x: 6, y: 10 } });
    const handle = (await marker.boundingBox())!;
    await app.mouse.down();
    await app.mouse.move(handle.x + 6 + 20, handle.y + 10, { steps: 4 });
    await app.mouse.up();
    await expect
      .poll(async () => Number(await marker.getAttribute("aria-valuenow")))
      .toBeGreaterThan(before);
    await expect.poll(() => app.evaluate(() => window.__engineBacking?.sync.length)).toBe(1);
    await editor.getByRole("button", { name: "Sync points from tempo changes" }).click();
    await expect(editor.getByRole("slider", { name: /Sync point at bar/ })).not.toHaveCount(1);
  });

  test("transposes and filters the recording", async ({ app }) => {
    const editor = await addRecording(app);
    await editor.getByLabel("Semitones").fill("-2");
    await editor.getByRole("combobox", { name: "Filter" }).click();
    await app.getByRole("option", { name: "Bass only" }).click();
    await expect
      .poll(() => app.evaluate(() => window.__engineBacking?.params))
      .toMatchObject({ semitones: -2, filter: "bassIsolate" });
  });

  test("saves the recording inside the song file when asked", async ({ app }) => {
    const editor = await addRecording(app);
    await editor.getByRole("switch", { name: "Embed the recording in the song file" }).click();
    await app.keyboard.press("Escape");
    await emitMenuAction(app, "save");
    await expect
      .poll(() => app.evaluate(() => window.__projectSettings["/Users/me/Music/practice-song.gp"]))
      .toMatchObject({ audioTrack: { name: "take.mp3" } });
    expect(await app.evaluate(() => window.__embeddedAudio)).toBe(true);
  });

  test("the audio track passes the accessibility checks in dark mode", async ({ app }) => {
    await app.emulateMedia({ colorScheme: "dark" });
    await addRecording(app);
    await expectNoA11yViolations(app);
  });
});
