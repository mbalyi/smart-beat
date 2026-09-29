import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Page } from "@playwright/test";

import {
  dropFiles,
  emitMenuAction,
  expect,
  openSong,
  playedSeconds,
  PRACTICE_SONG,
  serveFixtures,
  test,
  waitForScore,
} from "./fixtures";

/**
 * The real UI with the real alphaTab renderer and synthesizer (Chromium ≈
 * WebView2, WebKit ≈ WKWebView/WebKitGTK); only the Rust core is mocked.
 */

const SONIVOX = path.join(
  import.meta.dirname,
  "../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf3",
);

const score = (page: Page) => page.getByRole("region", { name: /^Score:/ });

test.describe("opening Guitar Pro files (#4)", () => {
  test("File → Open… renders the song picked in the native dialog", async ({ app }) => {
    await openSong(app);

    await expect(app.getByRole("heading", { level: 1, name: "Practice Song" })).toBeVisible();
    await expect(app.getByText("Smart Beat", { exact: true }).last()).toBeVisible();
    await expect(score(app).locator("svg").first()).toBeVisible();
    await expect(app).toHaveTitle("Practice Song — Smart Beat");
    const dialog = await app.evaluate(() =>
      window.__ipcCalls.find((c) => c.cmd === "plugin:dialog|open"),
    );
    expect(dialog?.args).toMatchObject({
      options: { filters: [{ extensions: ["gp3", "gp4", "gp5", "gpx", "gp"] }] },
    });
  });

  test("opens a file dropped onto the window", async ({ app }) => {
    await dropFiles(app, ["/Users/me/Music/readme.txt", PRACTICE_SONG]);

    await waitForScore(app);
    await expect(app.getByRole("heading", { level: 1, name: "Practice Song" })).toBeVisible();
  });

  test("explains why a damaged file can't be opened", async ({ app }) => {
    await dropFiles(app, ["/Users/me/Music/corrupt.gp5"]);

    await expect(app.getByText("Couldn't open “corrupt.gp5”")).toBeVisible();
    await expect(app.getByText(/damaged or uses a Guitar Pro version/)).toBeVisible();
    await expect(app.getByRole("heading", { level: 1 })).toHaveText(/Write, play/);
  });

  test("explains which files it opens", async ({ app }) => {
    await dropFiles(app, ["/Users/me/Music/scan.pdf"]);

    await expect(app.getByText(/Smart Beat opens Guitar Pro files/)).toBeVisible();
  });

  test("switches tracks and notation", async ({ app }) => {
    await openSong(app);
    const surface = score(app).locator(".at-surface");
    const heightWith = async () => (await surface.boundingBox())!.height;
    const scoreAndTab = await heightWith();

    await app.getByRole("radio", { name: "Tab", exact: true }).click();
    await expect.poll(heightWith).toBeLessThan(scoreAndTab); // one staff instead of two

    await app.getByRole("combobox", { name: "Track" }).click();
    await app.getByRole("option", { name: "Drums" }).click();
    await expect(app.getByRole("region", { name: "Score: Drums" })).toBeVisible();
    await expect(app.getByRole("radio", { name: "Score", exact: true })).toBeChecked();
    await expect(app.getByRole("radio", { name: "Tab", exact: true })).toBeDisabled();

    // Each track keeps its own notation.
    await app.getByRole("combobox", { name: "Track" }).click();
    await app.getByRole("option", { name: "Guitar" }).click();
    await expect(app.getByRole("radio", { name: "Tab", exact: true })).toBeChecked();
  });

  test.describe("in a narrow window", () => {
    // Four bars fit on one line in a wide window.
    test.use({ viewport: { width: 480, height: 700 } });

    test("lays the song out as pages or as one continuous row", async ({ app }) => {
      await openSong(app);
      const overflow = () => score(app).evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(await overflow()).toBeLessThanOrEqual(0); // bars wrap onto new lines

      await app.getByRole("radio", { name: "Continuous" }).click();

      await expect.poll(overflow).toBeGreaterThan(0); // scrolls sideways inside the score
      const pageOverflow = await app.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(pageOverflow).toBeLessThanOrEqual(0); // the window itself never does
    });
  });

  test("works in a plain browser with a file picker", async ({ page }) => {
    await serveFixtures(page);
    await page.goto("/");

    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Open a file…" }).click();
    await (await chooser).setFiles(path.join(import.meta.dirname, "fixtures/practice-song.gp"));

    await waitForScore(page);
    await expect(page.getByRole("heading", { level: 1, name: "Practice Song" })).toBeVisible();
  });
});

test.describe("playback (#5)", () => {
  test("plays with a cursor that follows the music, pauses and stops", async ({ app }) => {
    await openSong(app);
    const cursor = score(app).locator(".at-cursor-beat");
    const cursorX = async () => (await cursor.boundingBox())?.x ?? 0;
    const start = await cursorX();

    await app.getByRole("button", { name: "Play" }).click();

    await expect(app.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect.poll(() => playedSeconds(app), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    expect(await cursorX()).toBeGreaterThan(start);

    await app.getByRole("button", { name: "Pause" }).click();
    const paused = await playedSeconds(app);
    await app.waitForTimeout(1_200);
    expect(await playedSeconds(app)).toBe(paused);

    await app.getByRole("button", { name: "Stop" }).click();
    await expect(app.getByRole("timer")).toHaveText("0:00 / 0:12");
  });

  test("respects tempo changes in the score", async ({ app }) => {
    await openSong(app);

    // 2 bars at 60 BPM (8 s) + 2 bars at 120 BPM (4 s).
    await expect(app.getByRole("timer")).toHaveText("0:00 / 0:12");
    await expect(app.getByText("60 BPM")).toBeVisible();

    const bar = app.getByRole("spinbutton", { name: "Bar" });
    await bar.fill("3");
    await bar.press("Enter");

    await expect(app.getByRole("timer")).toHaveText("0:08 / 0:12");
    await app.getByRole("button", { name: "Play" }).click();
    await expect(app.getByText("120 BPM")).toBeVisible();
  });

  test("starts from a bar clicked in the score", async ({ app }) => {
    await openSong(app);
    // alphaTab draws bar numbers as red SVG text above each bar.
    const barNumber = score(app).locator('svg text[fill="#C80000"]', { hasText: /^3\s*$/ });
    // WebKit reports wrong client boxes for SVG text: use its box within its SVG.
    const box = await barNumber.evaluate((el: SVGTextElement) => {
      const svg = el.ownerSVGElement!.getBoundingClientRect();
      const text = el.getBBox();
      return { x: svg.x + text.x, y: svg.y + text.y };
    });

    // Click a note of bar 3 on the tab staff below its number.
    await app.mouse.click(box.x + 20, box.y + 150);

    await expect(app.getByRole("spinbutton", { name: "Bar" })).toHaveValue("3");
    await expect.poll(() => playedSeconds(app)).toBe(8); // bars 1–2 at 60 BPM
  });

  test("Space plays and pauses outside of controls", async ({ app }) => {
    await openSong(app);

    await score(app).focus();
    await app.keyboard.press("Space");
    await expect(app.getByRole("button", { name: "Pause" })).toBeVisible();
    await app.keyboard.press("Space");
    await expect(app.getByRole("button", { name: "Play" })).toBeVisible();
  });
});

test.describe("mixer (#6)", () => {
  test("starts from the file's mix, and saves changes for the song", async ({ app }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Mixer" }).click();
    const mixer = app.getByRole("dialog", { name: "Mixer" });

    // From the file: bass at 12/16 panned left, piano muted.
    await expect(mixer.getByRole("slider", { name: "Volume, Bass" })).toHaveAttribute(
      "aria-valuetext",
      "75%",
    );
    await expect(mixer.getByRole("slider", { name: "Pan, Bass" })).toHaveAttribute(
      "aria-valuetext",
      "50% left",
    );
    await expect(mixer.getByRole("button", { name: "Mute Piano" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await mixer.getByRole("button", { name: "Solo Drums" }).click();
    const volume = mixer.getByRole("slider", { name: "Volume, Guitar" });
    await volume.focus();
    await app.keyboard.press("End");
    await mixer.getByRole("slider", { name: "Master volume" }).focus();
    await app.keyboard.press("PageDown");

    await expect
      .poll(() => app.evaluate(() => [...window.__mixes.values()][0]))
      .toMatchObject({
        master: expect.any(Number),
        tracks: [{ volume: 1 }, {}, { solo: true }, { mute: true }],
      });

    // Reopening the song restores the saved mix.
    await app.keyboard.press("Escape");
    await openSong(app);
    await app.getByRole("button", { name: "Mixer" }).click();
    await expect(app.getByRole("button", { name: "Solo Drums" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(app.getByRole("slider", { name: "Volume, Guitar" })).toHaveAttribute(
      "aria-valuetext",
      "100%",
    );
  });

  test("keeps playing while tracks are muted, soloed and panned", async ({ app }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Mixer" }).click();
    await app.getByRole("button", { name: "Play" }).click();
    await expect.poll(() => playedSeconds(app), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    await app.getByRole("button", { name: "Mute Guitar" }).click();
    await app.getByRole("slider", { name: "Pan, Drums" }).focus();
    await app.keyboard.press("ArrowRight"); // regenerates the MIDI
    const afterPan = await playedSeconds(app);

    await expect(app.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect.poll(() => playedSeconds(app), { timeout: 10_000 }).toBeGreaterThan(afterPan);
    expect(afterPan).toBeGreaterThanOrEqual(1); // didn't jump back to the start
  });

  test("switches to the high-quality sounds", async ({ app }) => {
    // Stand in for the 15 MB FluidR3 download with the bundled font.
    const sounds = await readFile(SONIVOX);
    await app.route("**/soundfont/FluidR3Mono_GM.sf3", (route) =>
      route.fulfill({ contentType: "application/octet-stream", body: sounds }),
    );
    await openSong(app);
    await app.getByRole("button", { name: "Mixer" }).click();

    await app.getByRole("combobox", { name: "Instrument sounds" }).click();
    await app.getByRole("option", { name: /High quality/ }).click();

    await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
    await app.reload(); // the choice is remembered
    await openSong(app);
    await app.getByRole("button", { name: "Mixer" }).click();
    await expect(app.getByRole("combobox", { name: "Instrument sounds" })).toHaveText(
      /High quality/,
    );
  });

  test("falls back to the standard sounds when the others are missing", async ({ app }) => {
    await app.route("**/soundfont/FluidR3Mono_GM.sf3", (route) => route.fulfill({ status: 404 }));
    await openSong(app);
    await app.getByRole("button", { name: "Mixer" }).click();

    await app.getByRole("combobox", { name: "Instrument sounds" }).click();
    await app.getByRole("option", { name: /High quality/ }).click();

    await expect(app.getByText("High quality sounds are not available")).toBeVisible({
      timeout: 30_000,
    });
    await expect(app.getByRole("combobox", { name: "Instrument sounds" })).toHaveText(/Standard/);
    await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
  });

  test("reports that the mix is only kept for the session in a browser", async ({ page }) => {
    await serveFixtures(page);
    await page.goto("/");
    await page
      .locator("input[type=file]")
      .setInputFiles(path.join(import.meta.dirname, "fixtures/practice-song.gp"));
    await waitForScore(page);

    await page.getByRole("button", { name: "Mixer" }).click();

    await expect(page.getByText("Changes last until you open another song.")).toBeVisible();
  });
});

test("the menu can open a song while another one is open", async ({ app }) => {
  await openSong(app);
  await emitMenuAction(app, "open");
  await waitForScore(app);
  await expect(app.getByRole("heading", { level: 1, name: "Practice Song" })).toBeVisible();
});
