import type { Page } from "@playwright/test";

import {
  PRACTICE_SONG,
  dropFiles,
  emitMenuAction,
  expect,
  expectNoA11yViolations,
  openSong,
  test,
} from "./fixtures";

/**
 * Audio lanes (#185): several lanes of clips next to the tracks, in stem colours, edited in the
 * track list, the lane editor and the studio, recorded as plain takes, saved with the song, and
 * an old single audio track opening as a lane. Decoding and playback are in the (mocked) engine.
 */

/** Opens the practice song with the native engine on (the lanes play there). */
async function openWithEngine(app: Page) {
  await openSong(app);
  await app.getByRole("switch", { name: "Native engine with effects" }).click();
  await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
}

/** Opens `file` as a new lane from the Track menu; returns its row. */
async function addLane(app: Page, file: string) {
  await app.evaluate((path) => (window.__dialogResult = path), file);
  await emitMenuAction(app, "add-audio-lane");
  const name = file
    .split("/")
    .pop()!
    .replace(/\.[^.]+$/, "");
  const row = app
    .locator("[data-testid^='lane-row-']")
    .filter({ has: app.getByRole("button", { name: `Edit the lane ${name}` }) });
  await expect(row).toBeVisible();
  return row;
}

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

test.describe("audio lanes (#185)", () => {
  test("a file dropped on the window becomes a lane, and the engine plays it", async ({ app }) => {
    await openWithEngine(app);
    await dropFiles(app, ["/Users/me/Music/backing.mp3"]);
    const row = app.locator("[data-testid^='lane-row-']");
    await expect(row).toHaveCount(1);
    await expect(row.getByRole("button", { name: /backing\.mp3 on backing/ })).toBeVisible();
    await expect(app.getByText(/is not a Guitar Pro file/)).toHaveCount(0);
    await expect.poll(() => app.evaluate(() => window.__engineLanes?.audio.lanes.length)).toBe(1);
  });

  test("lanes take the stem colours, and a lane's colour can be changed", async ({ app }) => {
    await openWithEngine(app);
    const vocals = await addLane(app, "/Users/me/Music/vocals.wav");
    const drums = await addLane(app, "/Users/me/Music/drums.wav");
    const strip = (row: typeof vocals) => row.locator("span[aria-hidden='true']").first();
    const violet = await strip(vocals).evaluate((el) => getComputedStyle(el).backgroundColor);
    const magenta = await strip(drums).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(violet).not.toBe(magenta);
    await drums.getByRole("button", { name: "Colour of drums" }).click();
    await app
      .getByRole("group", { name: "Stem colours" })
      .getByRole("button", { name: "Bass" })
      .click();
    await expect
      .poll(() => app.evaluate(() => window.__engineLanes?.audio.lanes[1]))
      .toMatchObject({ name: "drums" });
    await app.keyboard.press("Escape");
    // Focus goes back to the colour chip, which shows its tooltip; a click on an empty spot of the
    // lane (it moves the edit cursor) puts it away, as a user would.
    await drums.locator("[data-lane-id]").click({ position: { x: 70, y: 40 } });
    await app.mouse.move(2, 2);
    await expect(app.locator("[data-radix-popper-content-wrapper]")).toHaveCount(0);
    // That click scrolled the track list; scrolled rows pass under its sticky header row, which
    // axe reads as overlapping targets. Scan it at rest.
    await app.evaluate(() =>
      document.querySelectorAll<HTMLElement>("*").forEach((el) => {
        if (el.scrollTop) el.scrollTop = 0;
      }),
    );
    await expectNoA11yViolations(app);
  });

  test("splits a clip at the edit cursor and moves the piece to another lane", async ({ app }) => {
    // Tall enough that both lanes are on screen (a drop lands on what is under the pointer).
    await app.setViewportSize({ width: 1280, height: 1100 });
    await openWithEngine(app);
    const first = await addLane(app, "/Users/me/Music/take.mp3");
    await addLane(app, "/Users/me/Music/other.mp3");
    // A click on the clip selects it and puts the edit cursor there, snapped to the beat. The
    // song is at 60 bpm: the four-second clip is one bar (21 px), so 10 px is the third beat.
    const clip = first.getByRole("button", { name: /take\.mp3 on take/ });
    await clip.click({ position: { x: 10, y: 10 } });
    await app.keyboard.press("s");
    await expect(first.getByRole("button", { name: /take\.mp3 on take/ })).toHaveCount(2);
    await expect
      .poll(() => app.evaluate(() => window.__engineLanes?.audio.lanes[0]?.clips.length))
      .toBe(2);
    // Drag the second piece down onto the other lane.
    const piece = first.getByRole("button", { name: /take\.mp3 on take/ }).nth(1);
    const from = (await piece.boundingBox())!;
    const target = (await app
      .locator("[data-testid^='lane-row-']")
      .nth(1)
      .locator("[data-lane-id]")
      .boundingBox())!;
    await app.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await app.mouse.down();
    await app.mouse.move(from.x + from.width / 2, target.y + target.height / 2, { steps: 6 });
    await app.mouse.up();
    await expect
      .poll(() => app.evaluate(() => window.__engineLanes?.audio.lanes[1]?.clips.length))
      .toBe(2);
  });

  test("the lane editor sets sync points, the filter and embedding", async ({ app }) => {
    await openWithEngine(app);
    const row = await addLane(app, "/Users/me/Music/take.mp3");
    await row.getByRole("button", { name: "Edit the lane take" }).click();
    const editor = app.getByRole("region", { name: "Lane editor: take" });
    await expect(editor).toBeVisible();
    await editor.getByRole("button", { name: "Sync point at bar 3" }).dblclick();
    await expect
      .poll(() => app.evaluate(() => window.__engineLanes?.audio.sync))
      .toEqual([{ bar: 2, ms: expect.any(Number) }]);
    await editor.getByRole("combobox", { name: "Filter" }).selectOption({ label: "Bass enhance" });
    await expect
      .poll(() => app.evaluate(() => window.__engineLanes?.audio.lanes[0]?.filter))
      .toBe("bassBoost");
    await editor.getByRole("button", { name: "Tasks" }).click();
    await app.getByRole("menuitem", { name: "Sync points from detected beats" }).click();
    await expect
      .poll(() => app.evaluate(() => window.__engineLanes?.audio.sync.length))
      .toBeGreaterThan(2);
    await expect(app.locator("[data-radix-popper-content-wrapper]")).toHaveCount(0);
    await app.mouse.move(2, 2);
    await expectNoA11yViolations(app);
  });

  test("the studio shows every lane, edits a range and measures a clip", async ({ app }) => {
    await openWithEngine(app);
    const row = await addLane(app, "/Users/me/Music/take.mp3");
    await row.getByRole("button", { name: "Edit the lane take" }).click();
    await app
      .getByRole("region", { name: "Lane editor: take" })
      .getByRole("button", { name: "Studio" })
      .click();
    const studio = app.getByRole("dialog", { name: "Studio" });
    await expect(studio).toBeVisible();
    await studio.getByRole("combobox", { name: "Ripple" }).selectOption({ label: "All lanes" });
    // Drag on the ruler across part of the clip, then delete that range.
    const ruler = studio.getByTestId("studio-ruler");
    const r = (await ruler.boundingBox())!;
    await app.mouse.move(r.x + 30, r.y + r.height / 2);
    await app.mouse.down();
    await app.mouse.move(r.x + 70, r.y + r.height / 2, { steps: 4 });
    await app.mouse.up();
    await studio.getByTestId("range-bar").getByRole("button", { name: "Delete range" }).click();
    await expect
      .poll(() => app.evaluate(() => window.__engineLanes?.audio.lanes[0]?.clips.length))
      .toBe(2);
    await studio
      .getByRole("button", { name: /take\.mp3 on take/ })
      .first()
      .click();
    await studio.getByRole("button", { name: "Spectrogram" }).click();
    await expect(studio.getByTestId("loudness")).toContainText("-14.2 LUFS");
    // The pointer off the buttons, so the scan sees them at rest (not hovered).
    await app.mouse.move(2, 2);
    await expectNoA11yViolations(app);
    await studio.getByRole("button", { name: "Back to score" }).click();
    await expect(studio).toBeHidden();
  });

  test("saves the lanes inside the song file, with the audio embedded", async ({ app }) => {
    await openWithEngine(app);
    await addLane(app, "/Users/me/Music/take.mp3");
    await emitMenuAction(app, "save");
    await expect
      .poll(() => app.evaluate((p) => window.__projectSettings[p], PRACTICE_SONG))
      .toMatchObject({
        version: 3,
        audio: { lanes: [{ name: "take" }], sources: [{ embedded: true }] },
      });
  });

  test("an old song's audio track opens as a lane", async ({ app }) => {
    await app.evaluate((path) => {
      window.__projectSettings[path] = {
        version: 2,
        master: 1,
        // The practice song's four tracks (a mix for other tracks is not used).
        tracks: Array.from({ length: 4 }, () => ({
          volume: 0.8,
          pan: 0,
          mute: false,
          solo: false,
        })),
        audioTrack: {
          name: "backing.mp3",
          embedded: true,
          enabled: true,
          volume: 0.7,
          pan: 0,
          mute: false,
          solo: false,
          eq: { lowDb: 0, midDb: 0, midHz: 1000, highDb: 0 },
          semitones: 0,
          cents: 0,
          filter: "off",
          sync: [],
        },
      } as never;
    }, PRACTICE_SONG);
    await openWithEngine(app);
    await expect(app.getByRole("button", { name: "Edit the lane backing.mp3" })).toBeVisible();
    await expect
      .poll(() => app.evaluate(() => Object.values(window.__engineSources).map((s) => s.entry)))
      .toContainEqual(expect.stringMatching(/^legacy-[0-9a-f]{8}\.mp3$/));
  });

  test("records a plain audio take onto a lane", async ({ app }) => {
    await installMicrophone(app);
    await openWithEngine(app);
    await app.getByRole("button", { name: "Record audio" }).click();
    const dialog = app.getByRole("dialog", { name: "Record audio" });
    await expect(dialog).toBeVisible();
    await expectNoA11yViolations(app, { popup: "[role=dialog]" });
    await dialog.getByRole("switch", { name: "Count-in" }).click();
    await dialog.getByRole("button", { name: "Start recording" }).click();
    await expect(app.getByLabel("Time recorded")).not.toHaveText("0:00", { timeout: 10_000 });
    await app
      .getByRole("region", { name: "Recording" })
      .getByRole("button", { name: "Stop" })
      .click();
    await expect(app.getByRole("button", { name: /on Recording/ })).toBeVisible({
      timeout: 20_000,
    });
    expect(Object.keys(await app.evaluate(() => window.__engineSources))).toContain("e".repeat(64));
  });

  test("the lanes and the record dialog pass the accessibility checks in dark mode", async ({
    app,
  }) => {
    await app.emulateMedia({ colorScheme: "dark" });
    await openWithEngine(app);
    const row = await addLane(app, "/Users/me/Music/take.mp3");
    await row.getByRole("button", { name: "Edit the lane take" }).click();
    await expectNoA11yViolations(app);
    await app.getByRole("button", { name: "Record audio" }).click();
    await expect(app.getByRole("dialog", { name: "Record audio" })).toBeVisible();
    await expectNoA11yViolations(app, { popup: "[role=dialog]" });
  });
});
