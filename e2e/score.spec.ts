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

  test("mixing never interrupts playback; pan waits for the next pause", async ({ app }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Mixer" }).click();
    await app.getByRole("button", { name: "Play" }).click();
    await expect.poll(() => playedSeconds(app), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    await expect(app.getByText(/Pan changes are applied when you pause/)).toBeVisible();

    await app.getByRole("button", { name: "Mute Guitar" }).click();
    await app.getByRole("button", { name: "Solo Drums" }).click();
    await app.getByRole("slider", { name: "Volume, Bass" }).focus();
    await app.keyboard.press("PageDown");
    await app.getByRole("slider", { name: "Pan, Drums" }).focus();
    await app.keyboard.press("ArrowRight");
    const afterPan = await playedSeconds(app);

    await expect(app.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect.poll(() => playedSeconds(app), { timeout: 10_000 }).toBeGreaterThan(afterPan);
    expect(afterPan).toBeGreaterThanOrEqual(1); // didn't jump back to the start

    await app.getByRole("button", { name: "Pause" }).click();
    await expect(app.getByText(/Pan changes are applied when you pause/)).toBeHidden();
    await expect(app.getByRole("slider", { name: "Pan, Drums" })).toHaveAttribute(
      "aria-valuetext",
      "13% right",
    );
    // Applied in place: the position survives regenerating the MIDI.
    await expect.poll(() => playedSeconds(app)).toBeGreaterThanOrEqual(afterPan);
  });

  test("playback keeps real time while the score and mixer are used", async ({
    app,
    browserName,
  }) => {
    await openSong(app);
    // Sample the position every 200 ms: it must never go backwards or stall.
    await app.evaluate(() => {
      const samples: { at: number; text: string }[] = [];
      (window as unknown as { __samples: typeof samples }).__samples = samples;
      setInterval(() => {
        const text = document.querySelector("[role=timer]")?.textContent ?? "";
        samples.push({ at: performance.now(), text: text.split("/")[0]!.trim() });
      }, 200);
    });
    await app.getByRole("button", { name: "Play" }).click();
    await expect.poll(() => playedSeconds(app), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    // Work with the score and mixer while it plays.
    await app.getByRole("combobox", { name: "Track" }).click();
    await app.getByRole("option", { name: "Bass" }).click();
    await app.getByRole("radio", { name: "Continuous" }).click();
    await app.getByRole("radio", { name: "Score", exact: true }).click();
    await app.getByRole("button", { name: "Mixer" }).click();
    await app.getByRole("button", { name: "Mute Piano" }).click();
    await app.getByRole("slider", { name: "Master volume" }).focus();
    await app.keyboard.press("ArrowLeft");
    await app.waitForTimeout(3_000);

    const samples = await app.evaluate(
      () => (window as unknown as { __samples: { at: number; text: string }[] }).__samples,
    );
    const seconds = samples.map(({ at, text }) => {
      const [m, s] = text.split(":").map(Number);
      return { at, played: m! * 60 + s! };
    });
    const playing = seconds.filter((s) => s.played >= 1);
    const first = playing[0]!;
    const last = playing.at(-1)!;
    // Never goes backwards.
    for (let i = 1; i < playing.length; i++) {
      expect(playing[i]!.played).toBeGreaterThanOrEqual(playing[i - 1]!.played);
    }
    // Keeps pace with the clock (the display has 1 s steps, hence ±1.5 s).
    // alphaTab relays audio through the page's main thread; CI's headless
    // WebKit on Linux renders in software, and redrawing the score there can
    // hold the page up for over a second, so it gets more slack.
    const slowRenderer = browserName === "webkit" && process.platform === "linux";
    const wallSeconds = (last.at - first.at) / 1000;
    expect(Math.abs(last.played - first.played - wallSeconds)).toBeLessThanOrEqual(
      slowRenderer ? 3 : 1.5,
    );
    expect(wallSeconds).toBeGreaterThan(3);
  });

  test("switches to the high-quality sounds and keeps playing from the same point", async ({
    app,
  }) => {
    // Stand in for the 15 MB FluidR3 download with the bundled font.
    const sounds = await readFile(SONIVOX);
    await app.route("**/soundfont/FluidR3Mono_GM.sf3", (route) =>
      route.fulfill({ contentType: "application/octet-stream", body: sounds }),
    );
    await openSong(app);
    await app.getByRole("button", { name: "Mixer" }).click();
    await app.getByRole("button", { name: "Play" }).click();
    await expect.poll(() => playedSeconds(app), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    const before = await playedSeconds(app);

    await app.getByRole("combobox", { name: "Instrument sounds" }).click();
    await app.getByRole("option", { name: /High quality/ }).click();

    // Continues on its own, from where it was (not from the start).
    await expect(app.getByRole("button", { name: "Pause" })).toBeEnabled({ timeout: 30_000 });
    await expect.poll(() => playedSeconds(app), { timeout: 10_000 }).toBeGreaterThan(before);
    await app.getByRole("button", { name: "Pause" }).click();

    await app.reload(); // the choice is remembered
    await openSong(app);
    await app.getByRole("button", { name: "Mixer" }).click();
    await expect(app.getByRole("combobox", { name: "Instrument sounds" })).toHaveText(
      /High quality/,
    );
  });

  test("survives switching sounds quickly back and forth while playing", async ({ app }) => {
    const sounds = await readFile(SONIVOX);
    await app.route("**/soundfont/FluidR3Mono_GM.sf3", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800)); // a slow download
      await route.fulfill({ contentType: "application/octet-stream", body: sounds });
    });
    await openSong(app);
    await app.getByRole("button", { name: "Mixer" }).click();
    await app.getByRole("button", { name: "Play" }).click();
    await expect.poll(() => playedSeconds(app), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    const before = await playedSeconds(app);
    const sound = app.getByRole("combobox", { name: "Instrument sounds" });

    await sound.click();
    await app.getByRole("option", { name: /High quality/ }).click();
    await sound.click();
    await app.getByRole("option", { name: /Standard/ }).click();

    await expect(sound).toHaveText(/Standard/);
    await expect(app.getByRole("button", { name: "Pause" })).toBeEnabled({ timeout: 30_000 });
    await expect.poll(() => playedSeconds(app), { timeout: 10_000 }).toBeGreaterThan(before);
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

  test.describe("in a window where the panel covers the score", () => {
    test.use({ viewport: { width: 1000, height: 720 } });

    test("the playback cursor stays under the mixer panel", async ({ app }) => {
      await openSong(app);
      await app.getByRole("button", { name: "Mixer" }).click();
      const mixer = app.getByRole("dialog", { name: "Mixer" });
      await mixer.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      const bar = app.getByRole("spinbutton", { name: "Bar" });
      await bar.fill("4");
      await bar.press("Enter");

      const panel = (await mixer.boundingBox())!;
      const cursorBar = score(app).locator(".at-cursor-bar");
      // alphaTab moves the cursor asynchronously: wait until it reaches bar 4,
      // which runs under the panel at this window size.
      await expect
        .poll(async () => {
          const box = await cursorBar.boundingBox();
          return box ? box.x + box.width : 0;
        })
        .toBeGreaterThan(panel.x + 10);
      const cursor = (await cursorBar.boundingBox())!;
      const point = [panel.x + 10, cursor.y + cursor.height / 2];

      const panelOnTop = await app.evaluate(([x, y]) => {
        // The cursor ignores the pointer; make it hit-testable so elementFromPoint
        // reports what is painted on top.
        for (const el of document.querySelectorAll<HTMLElement>(".at-cursors, .at-cursors *")) {
          el.style.pointerEvents = "auto";
        }
        return document.elementFromPoint(x!, y!)?.closest("[role=dialog]") !== null;
      }, point);
      expect(panelOnTop).toBe(true);
    });
  });

  test("shows pressed Mute and Solo buttons in distinct colours", async ({ app }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Mixer" }).click();
    // Read once the colour transition has finished.
    const background = (name: string) =>
      app.getByRole("button", { name }).evaluate(async (el) => {
        await Promise.all(el.getAnimations().map((a) => a.finished));
        return getComputedStyle(el).backgroundColor;
      });

    await app.getByRole("button", { name: "Solo Bass" }).click();
    await app.mouse.move(0, 0); // not the hover shade

    // Tailwind's red-700 and amber-400 (browsers report oklch or rgb).
    await expect.poll(() => background("Mute Piano")).toMatch(/oklch\(0\.50|rgb\(1[89]\d, 0, /);
    await expect
      .poll(() => background("Solo Bass"))
      .toMatch(/oklch\(0\.82|rgb\(2[45]\d, 1[6-9]\d, /);
    const idle = await background("Mute Guitar");
    expect(idle).not.toBe(await background("Mute Piano"));
    expect(idle).not.toBe(await background("Solo Bass"));
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
