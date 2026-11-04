import type { Page } from "@playwright/test";

import features from "../src/lib/features.json" with { type: "json" };

import { expect, expectNoA11yViolations, tabKey, test } from "./fixtures";

declare global {
  interface Window {
    __stems: {
      songs: {
        id: string;
        name: string;
        skipped: string[];
        pinned: boolean;
        lastOpened: number | null;
        savedPath: string | null;
        hasOriginal: boolean;
      }[];
      originalMissing: boolean;
      requests: {
        path: string;
        kinds: string[];
        engine: string;
        strongDrums: boolean;
      }[];
      reads: { id: string; kind: string }[];
      renders: { gains: Record<string, number>; speed: number }[];
      cancelled: number;
      hold: boolean;
      holdRender: boolean;
      fail: string | null;
      mono: boolean;
      release: (() => void) | null;
      abort: (() => void) | null;
      releaseRender: (() => void) | null;
    };
    __stemBundles: {
      saves: { id: string; dest: string; includeOriginal: boolean }[];
      opens: string[];
      files: Record<string, unknown>;
      hold: boolean;
      fail: string | null;
      release: (() => void) | null;
      abort: (() => void) | null;
    };
    __stemModels: {
      models: Record<string, { downloaded: boolean; termsAccepted: boolean; available: boolean }>;
      downloads: string[];
      removed: string[];
      cancelled: number;
      hold: boolean;
      fail: string | null;
      release: (() => void) | null;
    };
  }
}

/** What the tempo detector answers (the contract of `detectStemTempo` in src/lib/tauri.ts, command `stems_detect_tempo`). */
interface MockTempo {
  bpm: number;
  confidence: number;
  firstBeatSec: number;
  alternatives: number[];
  steady: boolean;
  sections: { startSec: number; endSec: number; bpm: number }[];
}

const STEADY_TEMPO: MockTempo = {
  bpm: 92,
  confidence: 0.9,
  firstBeatSec: 0.4,
  alternatives: [46, 184],
  steady: true,
  sections: [],
};

const CHANGING_TEMPO: MockTempo = {
  ...STEADY_TEMPO,
  steady: false,
  sections: [
    { startSec: 0, endSec: 3, bpm: 92 },
    { startSec: 3, endSec: 6, bpm: 140 },
  ],
};

/**
 * Makes the tempo detection answer with `tempo` (or fail), whatever the shared mock does, and
 * records the songs it was asked about in `window.__tempoAsks`.
 */
async function mockTempo(app: Page, tempo: MockTempo | "fail", delayMs = 0) {
  await app.evaluate(
    ([answer, delay]) => {
      const w = window as unknown as {
        __tempoAsks: string[];
        __TAURI_INTERNALS__: { invoke: (cmd: string, ...rest: unknown[]) => Promise<unknown> };
      };
      w.__tempoAsks = [];
      const real = w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
      w.__TAURI_INTERNALS__.invoke = async (cmd, ...rest) => {
        if (cmd !== "stems_detect_tempo") return real(cmd, ...rest);
        w.__tempoAsks.push(String((rest[0] as { id?: string } | undefined)?.id));
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (answer === "fail") throw new Error("No tempo.");
        return answer;
      };
    },
    [tempo, delayMs] as const,
  );
}

/** Records every metronome click handed to Web Audio: its length (short) and when it starts. */
async function recordClicks(app: Page) {
  await app.evaluate(() => {
    const w = window as unknown as { __clicks: { when: number; now: number }[] };
    w.__clicks = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...args) {
      // The stems and mixes are seconds long; a click is under a third of a second.
      if (this.buffer && this.buffer.duration < 0.3) {
        w.__clicks.push({ when: Number(args[0] ?? 0), now: this.context.currentTime });
      }
      return start.apply(this, args as Parameters<typeof start>);
    };
  });
}

/** Stem separation (#186), with the stems commands mocked in e2e/tauri-mock.js. */

const SONG_PATH = "/Users/me/Music/neon-nights.mp3";

test.describe("Stem separation (#186)", () => {
  test.skip(!features["stem-separation"], "stem-separation is off in src/lib/features.json");

  async function openDialog(app: Page) {
    await app.getByRole("button", { name: "Stem separation" }).click();
    const dialog = app.getByRole("dialog", { name: "Stem separation" });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  /**
   * Chooses the song through the (mocked) native dialog and goes to the options. HTDemucs is
   * chosen first but is not downloaded here, so the built-in Fast engine is picked, unless the
   * test is about the engine choice itself (`keepEngine`).
   */
  async function chooseSong(app: Page, path = SONG_PATH, keepEngine = false) {
    const dialog = app.getByRole("dialog", { name: "Stem separation" });
    await app.evaluate((p) => (window.__dialogResult = p), path);
    await dialog.getByRole("button", { name: "Choose a song" }).click();
    await expect(dialog.getByTestId("stem-file-name")).toBeVisible();
    await dialog.getByRole("button", { name: "Next" }).click();
    if (!keepEngine) await dialog.getByRole("radio", { name: "Fast" }).check();
    return dialog;
  }

  /** Welcome button, song, Separate, and the page. */
  async function separate(app: Page, path = SONG_PATH) {
    await openDialog(app);
    const dialog = await chooseSong(app, path);
    await dialog.getByRole("button", { name: "Separate" }).click();
    const name = path
      .split("/")
      .pop()!
      .replace(/\.[^.]+$/, "");
    await expect(app.getByRole("heading", { level: 1, name })).toBeVisible();
    return app.getByRole("list", { name: "Stems" });
  }

  test("goes from the start screen to the dialog, the progress and the page", async ({ app }) => {
    await app.evaluate(() => (window.__stems.hold = true));
    const dialog = await openDialog(app);
    await expect(dialog.getByText("Runs on this computer. Nothing is uploaded.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Next" })).toBeDisabled();
    await chooseSong(app, SONG_PATH, true);

    // HTDemucs is chosen first; the built-in engine is the one with parts to choose from.
    await expect(dialog.getByRole("radio", { name: "HTDemucs", exact: true })).toBeChecked();
    await dialog.getByRole("radio", { name: "Fast" }).check();

    // The parts: four to choose from, Other always on and marked.
    await expect(dialog.getByRole("checkbox", { name: /^Drums/ })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: "Other, not separated" })).toBeDisabled();
    await dialog.getByRole("checkbox", { name: /^Guitars and keys/ }).click();
    await dialog.getByRole("radio", { name: "Strong" }).click();
    await dialog.getByRole("button", { name: "Separate" }).click();

    const bar = dialog.getByRole("progressbar", { name: "Separation progress" });
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(await app.evaluate(() => window.__stems.requests)).toEqual([
      { path: SONG_PATH, kinds: ["drums", "bass", "vocals"], engine: "fast", strongDrums: true },
    ]);

    await app.evaluate(() => window.__stems.release?.());
    await expect(dialog).toBeHidden();
    await expect(app.getByRole("heading", { level: 1, name: "neon-nights" })).toBeVisible();
    // Everything in the library is read for playing, and the welcome content is gone.
    await expect(app.getByRole("heading", { level: 1, name: /Practice, create/ })).toHaveCount(0);
    const rows = app.getByRole("list", { name: "Stems" }).getByRole("listitem");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(3).getByRole("heading")).toHaveText("Other (not separated)");
    // (React's development double-mount can read them twice.)
    await expect
      .poll(() =>
        app.evaluate(() => [...new Set(window.__stems.reads.map((read) => read.kind))].sort()),
      )
      .toEqual(["bass", "drums", "other", "vocals"]);
  });

  test("mutes and solos a stem, with the mouse and the keyboard", async ({ app, browserName }) => {
    await separate(app);
    const drums = app.getByTestId("stem-drums");
    const mute = drums.getByRole("button", { name: "Mute Drums" });
    await mute.click();
    await expect(mute).toHaveAttribute("aria-pressed", "true");
    await expect(drums).toHaveAttribute("data-heard", "false");
    await mute.click();
    await expect(drums).toHaveAttribute("data-heard", "true");

    // Solo: the others go quiet.
    const bass = app.getByTestId("stem-bass");
    await bass.getByRole("button", { name: "Solo Bass" }).click();
    await expect(bass).toHaveAttribute("data-heard", "true");
    await expect(drums).toHaveAttribute("data-heard", "false");
    await expect(app.getByTestId("stem-other")).toHaveAttribute("data-heard", "false");
    await bass.getByRole("button", { name: "Solo Bass" }).click();
    await expect(drums).toHaveAttribute("data-heard", "true");

    // The keyboard reaches Mute, then Solo, then the volume; Space and the arrows work them.
    const vocals = app.getByTestId("stem-vocals");
    const voiceMute = vocals.getByRole("button", { name: "Mute Vocals" });
    await voiceMute.focus();
    await app.keyboard.press("Space");
    await expect(voiceMute).toHaveAttribute("aria-pressed", "true");
    await app.keyboard.press(tabKey(browserName));
    await expect(vocals.getByRole("button", { name: "Solo Vocals" })).toBeFocused();
    await app.keyboard.press(tabKey(browserName));
    const volume = vocals.getByRole("slider", { name: "Volume, Vocals" });
    await expect(volume).toBeFocused();
    await app.keyboard.press("ArrowLeft");
    await expect(volume).toHaveAttribute("aria-valuetext", "95%");
    await app.keyboard.press("Home");
    await expect(volume).toHaveAttribute("aria-valuetext", "0%");
  });

  test("plays and pauses, and moves around with the Position slider", async ({ app }) => {
    await separate(app);
    await expect(app.getByRole("button", { name: "Play" })).toBeEnabled();
    await app.getByRole("button", { name: "Play" }).click();
    await expect(app.getByRole("button", { name: "Pause" })).toBeVisible();
    await app.getByRole("button", { name: "Pause" }).click();
    await expect(app.getByRole("button", { name: "Play" })).toBeVisible();

    const position = app.getByRole("slider", { name: "Position" });
    await position.focus();
    await app.keyboard.press("End");
    await expect(app.getByRole("timer", { name: "Position" })).toHaveText("0:06 / 0:06");
    await app.getByRole("button", { name: "Stop" }).click();
    await expect(app.getByRole("timer", { name: "Position" })).toHaveText("0:00 / 0:06");
  });

  for (const [width, height] of [
    [1280, 520],
    [375, 812],
  ] as const) {
    test(`puts the transport above the tab bar and keeps it in view while the rows scroll at ${width} px`, async ({
      app,
    }) => {
      await app.setViewportSize({ width, height });
      await separate(app);
      const transport = app.getByRole("region", { name: "Transport" });
      const tabs = app.getByRole("navigation", { name: /Open songs/ });
      const rows = app.getByRole("list", { name: "Stems" });
      await expect(transport).toBeVisible();
      const [t, n, r] = await Promise.all([
        transport.boundingBox(),
        tabs.boundingBox(),
        rows.boundingBox(),
      ]);
      // Header, then the transport, then the tab bar, then the rows, with no overlap.
      expect(t!.y + t!.height).toBeLessThanOrEqual(n!.y + 1);
      expect(n!.y + n!.height).toBeLessThanOrEqual(r!.y + 1);
      const top = t!.y;
      // Scrolling the page: the strip stays where it is, the tab bar goes under it.
      await rows.evaluate((list) => {
        const scroller = list.closest("div.overflow-y-auto")!;
        scroller.scrollTo(0, scroller.scrollHeight);
      });
      await expect.poll(async () => (await tabs.boundingBox())!.y + 1).toBeLessThan(top + 1);
      const scrolled = await transport.boundingBox();
      expect(scrolled!.y).toBeCloseTo(top, 0);
      await expect(app.getByRole("button", { name: "Play" })).toBeInViewport();
      // The last row is not hidden under the strip: its top is at or below the strip's bottom.
      const last = await rows.getByRole("listitem").last().boundingBox();
      expect(last!.y + last!.height).toBeGreaterThan(scrolled!.y + scrolled!.height);
    });
  }

  test("says it is finding the tempo, then shows it in the details", async ({ app }) => {
    await mockTempo(app, STEADY_TEMPO, 600);
    await separate(app);
    await expect(app.getByText("Finding the tempo…")).toBeVisible();
    // Playing is not held back.
    await expect(app.getByRole("button", { name: "Play" })).toBeEnabled();
    await expect(app.getByTestId("stem-tempo")).toHaveText("92 BPM");
    await expect(app.getByTestId("stems-info")).toContainText(/engine · \d parts · 92 BPM/);
    await expect(app.getByTestId("stem-tempo-changes")).toHaveCount(0);
    // Asked for this song only (React's development double-mount can ask twice).
    const asks = await app.evaluate(
      () => (window as unknown as { __tempoAsks: string[] }).__tempoAsks,
    );
    expect(new Set(asks).size).toBe(1);
  });

  test("says when the tempo was not found, and takes one that is tapped or typed", async ({
    app,
  }) => {
    await mockTempo(app, { ...STEADY_TEMPO, confidence: 0.1 });
    await separate(app);
    await expect(app.getByTestId("stem-tempo")).toHaveText("Tempo not found");
    await expect(app.getByRole("button", { name: "Metronome" })).toBeDisabled();
    await app.getByTestId("stem-tempo").click();
    const menu = app.getByRole("dialog", { name: "Tempo" });
    await menu.getByRole("spinbutton", { name: "Type a tempo" }).fill("100");
    await app.keyboard.press("Enter");
    await expect(app.getByTestId("stem-tempo")).toHaveText("100 BPM");
    await expect(app.getByRole("button", { name: "Metronome" })).toBeEnabled();
    const tap = menu.getByRole("button", { name: "Tap tempo" });
    await tap.click();
    await app.waitForTimeout(500);
    await tap.click();
    await expect(app.getByTestId("stem-tempo")).toHaveText(/^\d+(\.\d)? BPM$/);
    await expect(menu.getByText(/BPM from 2 taps/)).toBeVisible();
  });

  test("halves, doubles and picks another tempo, and remembers it for the song", async ({
    app,
  }) => {
    await mockTempo(app, STEADY_TEMPO);
    await separate(app);
    await app.getByTestId("stem-tempo").click();
    const menu = app.getByRole("dialog", { name: "Tempo" });
    await menu.getByRole("button", { name: "Halve" }).click();
    await expect(app.getByTestId("stem-tempo")).toHaveText("46 BPM");
    await menu.getByRole("button", { name: "Double" }).click();
    await menu.getByRole("button", { name: "Double" }).click();
    await expect(app.getByTestId("stem-tempo")).toHaveText("184 BPM");
    await menu.getByRole("button", { name: "46 BPM" }).click();
    await expect(app.getByTestId("stem-tempo")).toHaveText("46 BPM");
    await app.keyboard.press("Escape");
    // Leaving the page and opening the song again keeps the tempo the user chose.
    await app.getByRole("button", { name: "Smart Beat", exact: true }).click();
    await app.getByRole("button", { name: /^neon-nights/ }).click();
    await expect(app.getByRole("heading", { level: 1, name: "neon-nights" })).toBeVisible();
    await expect(app.getByTestId("stem-tempo")).toHaveText("46 BPM");
  });

  test("clicks the metronome on the beat grid while playing, and stops when paused", async ({
    app,
  }) => {
    await mockTempo(app, { ...STEADY_TEMPO, bpm: 120, firstBeatSec: 0, alternatives: [] });
    await recordClicks(app);
    await separate(app);
    await expect(app.getByTestId("stem-tempo")).toHaveText("120 BPM");
    await app.getByRole("button", { name: "Metronome" }).click();
    await expect(app.getByRole("button", { name: "Click sound and volume" })).toBeVisible();
    await app.getByRole("button", { name: "Play" }).click();
    await expect(app.getByRole("button", { name: "Pause" })).toBeVisible();
    await app.waitForTimeout(1800);
    await app.getByRole("button", { name: "Pause" }).click();
    const clicks = await app.evaluate(
      () => (window as unknown as { __clicks: { when: number }[] }).__clicks,
    );
    // 120 BPM = a click every half second.
    expect(clicks.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < clicks.length; i++) {
      expect(clicks[i]!.when - clicks[i - 1]!.when).toBeCloseTo(0.5, 2);
    }
    // No clicks once paused.
    const heard = clicks.length;
    await app.waitForTimeout(600);
    expect(
      await app.evaluate(() => (window as unknown as { __clicks: unknown[] }).__clicks.length),
    ).toBe(heard);
  });

  test("shows Tempo changes with the parts, and says the click uses one tempo", async ({ app }) => {
    await mockTempo(app, CHANGING_TEMPO);
    await separate(app);
    await app.getByTestId("stem-tempo-changes").click();
    const popover = app.getByRole("dialog", { name: "Tempo changes" });
    await expect(popover.getByTestId("stem-tempo-sentence")).toHaveText(
      "92 BPM until 0:03, then 140 BPM",
    );
    await expect(popover.getByText("The playhead is in the 92 BPM part.")).toBeVisible();
    await expect(popover.getByText(/clicks at one tempo/)).toBeVisible();
    await popover.getByRole("button", { name: "Follow the tempo changes" }).click();
    await expect(popover.getByText(/The metronome follows the changes/)).toBeVisible();
  });

  test("sets and clears an A-B loop at the playhead", async ({ app }) => {
    await separate(app);
    await app.getByRole("button", { name: "Set loop start" }).click();
    await expect(app.getByText(/Loop starts at 0:00. Set its end./)).toBeVisible();
    await app.getByRole("slider", { name: "Position" }).focus();
    await app.keyboard.press("End");
    await app.getByRole("button", { name: "Set loop end" }).click();
    await expect(app.getByText(/Looping 0:00 to 0:06/)).toBeVisible();
    await app.getByRole("button", { name: "Clear loop" }).click();
    await expect(app.getByText(/No loop/)).toBeVisible();
  });

  /** The page's Speed menu, the same one an open song has. */
  const setSpeed = async (app: Page, percent: number) => {
    await app.getByRole("combobox", { name: "Speed" }).click();
    await app.getByRole("option", { name: `${percent}%` }).click();
  };

  test("seeks when a waveform is clicked and sets a loop by dragging", async ({ app }) => {
    await separate(app);
    const wave = app.getByTestId("waveform-bass");
    const box = (await wave.boundingBox())!;
    await app.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(app.getByRole("timer", { name: "Position" })).toHaveText("0:03 / 0:06");

    await app.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await app.mouse.down();
    await app.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 5 });
    await app.mouse.up();
    await expect(app.getByText(/Looping 0:01 to 0:04/)).toBeVisible();
  });

  test("renders a slower mix with the gains, and again after a change", async ({ app }) => {
    await separate(app);
    await setSpeed(app, 80);
    await expect.poll(() => app.evaluate(() => window.__stems.renders.length)).toBe(1);
    expect(await app.evaluate(() => window.__stems.renders[0])).toEqual({
      gains: { drums: 1, bass: 1, vocals: 1, panned: 1, other: 1 },
      speed: 0.8,
    });
    await expect(app.getByText("Rendering…")).toHaveCount(0);

    await app.getByTestId("stem-bass").getByRole("button", { name: "Mute Bass" }).click();
    await expect.poll(() => app.evaluate(() => window.__stems.renders.length)).toBe(2);
    expect(await app.evaluate(() => window.__stems.renders[1]?.gains.bass)).toBe(0);
  });

  test("shows Rendering… while a slowed mix is made, and no spinning with reduced motion", async ({
    app,
  }) => {
    await app.emulateMedia({ reducedMotion: "reduce" });
    await separate(app);
    await app.evaluate(() => (window.__stems.holdRender = true));
    await setSpeed(app, 60);
    const status = app.getByRole("status").filter({ hasText: "Rendering…" });
    await expect(status).toBeVisible();
    const animation = await status
      .locator("svg")
      .evaluate((svg) => getComputedStyle(svg).animationName);
    expect(animation).toBe("none");
    await app.evaluate(() => window.__stems.releaseRender?.());
    await expect(app.getByText("Rendering…")).toHaveCount(0);
  });

  test("can be cancelled, and the dialog goes back to the options", async ({ app }) => {
    await app.evaluate(() => (window.__stems.hold = true));
    const dialog = await openDialog(app);
    await chooseSong(app);
    await dialog.getByRole("button", { name: "Separate" }).click();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog.getByRole("button", { name: "Separate" })).toBeEnabled();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    expect(await app.evaluate(() => window.__stems.cancelled)).toBe(1);
    await app.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("shows why a separation failed", async ({ app }) => {
    await app.evaluate(() => (window.__stems.fail = "The file could not be decoded."));
    const dialog = await openDialog(app);
    await chooseSong(app);
    await dialog.getByRole("button", { name: "Separate" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("The file could not be decoded.");
  });

  test("takes a song dropped on the window", async ({ app }) => {
    const dialog = await openDialog(app);
    const paths = [SONG_PATH];
    const position = { x: 100, y: 100 };
    await app.evaluate((payload) => window.__emitTauriEvent("tauri://drag-drop", payload), {
      paths,
      position,
    });
    await expect(dialog.getByTestId("stem-file-name")).toHaveText("neon-nights.mp3");
  });

  test("says that a mono song could not be split", async ({ app }) => {
    await app.evaluate(() => (window.__stems.mono = true));
    await separate(app);
    await expect(app.getByTestId("stems-skipped")).toContainText(
      "This file is mono, so vocals and guitars and keys cannot be separated.",
    );
    await expect(app.getByTestId("stem-vocals")).toHaveCount(0);
  });

  /** The Recent grid's card of a separated song (the card is a list item with its own buttons). */
  const stemCard = (app: Page, name: string) =>
    app.getByRole("listitem").filter({ has: app.getByRole("button", { name: new RegExp(name) }) });

  test("shows a separated song in the Recent grid, reopens it and deletes it", async ({ app }) => {
    await separate(app);
    await app.getByRole("button", { name: "Smart Beat", exact: true }).click();
    await expect(app.getByRole("heading", { level: 1, name: /Practice, create/ })).toBeVisible();
    // The old separate section is gone: the song is a card among the recent songs.
    await expect(app.getByRole("region", { name: "Your separated songs" })).toHaveCount(0);
    const card = stemCard(app, "neon-nights");
    await expect(card.getByText("Stems", { exact: true })).toBeVisible();
    await expect(card.getByText("Saved", { exact: true })).toHaveCount(0);

    await card.getByRole("button", { name: /^neon-nights/ }).click();
    await expect(app.getByRole("heading", { level: 1, name: "neon-nights" })).toBeVisible();
    await app.getByRole("button", { name: "Smart Beat", exact: true }).click();

    await card.getByRole("button", { name: "Delete neon-nights" }).click();
    await card.getByRole("button", { name: "Delete the stems of neon-nights" }).click();
    await expect(stemCard(app, "neon-nights")).toHaveCount(0);
    expect(await app.evaluate(() => window.__stems.songs.length)).toBe(0);
  });

  test("lists the newest or last opened stems first, and marks the saved ones", async ({ app }) => {
    await separate(app);
    await app.getByRole("button", { name: "Smart Beat", exact: true }).click();
    await separate(app, "/Users/me/Music/blue-moon.mp3");
    await app.evaluate(() => (window.__saveResult = "/Users/me/Music/blue-moon.sbstems"));
    await saveStems(app);
    await app.getByRole("button", { name: "Smart Beat", exact: true }).click();

    const names = () =>
      app
        .getByRole("button", { name: /^(neon-nights|blue-moon)/ })
        .evaluateAll((buttons) => buttons.map((button) => button.textContent?.slice(0, 9)));
    await expect.poll(names).toEqual(["blue-moon", "neon-nigh"]);
    await expect(stemCard(app, "blue-moon").getByText("Saved", { exact: true })).toBeVisible();
    await expect(stemCard(app, "neon-nights").getByText("Saved", { exact: true })).toHaveCount(0);

    // Opening the older one makes it the first.
    await stemCard(app, "neon-nights")
      .getByRole("button", { name: /^neon-nights/ })
      .click();
    await expect(app.getByRole("heading", { level: 1, name: "neon-nights" })).toBeVisible();
    await app.getByRole("button", { name: "Smart Beat", exact: true }).click();
    await expect.poll(names).toEqual(["neon-nigh", "blue-moon"]);
  });

  /** The page's "Save stems" button and the dialog it opens. */
  async function openSaveDialog(app: Page) {
    await app.getByRole("button", { name: "Save stems" }).click();
    const dialog = app.getByRole("dialog", { name: "Save stems" });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  /** Opens the dialog, saves to the (mocked) native dialog's `__saveResult` and closes it. */
  async function saveStems(app: Page) {
    const dialog = await openSaveDialog(app);
    await dialog.getByRole("button", { name: "Save to this computer" }).click();
    await expect(dialog.getByTestId("save-stems-path")).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).first().click();
    await expect(dialog).toBeHidden();
  }

  const BUNDLE_PATH = "/Users/me/Music/neon-nights.sbstems";

  test("saves the stems with the original song, and says where", async ({ app }) => {
    await separate(app);
    const dialog = await openSaveDialog(app);
    const box = dialog.getByRole("checkbox", { name: "Include the original song" });
    await expect(box).toBeChecked();
    await expect(box).toBeEnabled();
    await app.evaluate((path) => (window.__saveResult = path), BUNDLE_PATH);
    await dialog.getByRole("button", { name: "Save to this computer" }).click();

    await expect(dialog.getByText(BUNDLE_PATH)).toBeVisible();
    await expect(dialog.getByRole("progressbar", { name: "Save progress" })).toHaveCount(0);
    const saves = await app.evaluate(() => window.__stemBundles.saves);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ dest: BUNDLE_PATH, includeOriginal: true });
    expect(saves[0].id).toBe("neonnights000000");
    expect(await app.evaluate(() => window.__stems.songs[0].savedPath)).toBe(BUNDLE_PATH);
    await dialog.getByRole("button", { name: "Close" }).first().click();
    await expect(dialog).toBeHidden();
  });

  test("saves the stems without the original song when the box is cleared", async ({ app }) => {
    await separate(app);
    const dialog = await openSaveDialog(app);
    await dialog.getByRole("checkbox", { name: "Include the original song" }).uncheck();
    await app.evaluate((path) => (window.__saveResult = path), BUNDLE_PATH);
    await dialog.getByRole("button", { name: "Save to this computer" }).click();
    await expect(dialog.getByText(BUNDLE_PATH)).toBeVisible();
    const saves = await app.evaluate(() => window.__stemBundles.saves);
    expect(saves).toHaveLength(1);
    expect(saves[0].includeOriginal).toBe(false);
    expect(
      await app.evaluate(() => window.__stemBundles.files[window.__stemBundles.saves[0].dest]),
    ).toMatchObject({
      hasOriginal: false,
    });
  });

  test("cannot include the original song when it is not on this computer any more", async ({
    app,
  }) => {
    await app.evaluate(() => (window.__stems.originalMissing = true));
    await separate(app);
    const dialog = await openSaveDialog(app);
    const box = dialog.getByRole("checkbox", { name: "Include the original song" });
    await expect(box).toBeDisabled();
    await expect(box).not.toBeChecked();
    await app.evaluate((path) => (window.__saveResult = path), BUNDLE_PATH);
    await dialog.getByRole("button", { name: "Save to this computer" }).click();
    await expect(dialog.getByText(BUNDLE_PATH)).toBeVisible();
    const saves = await app.evaluate(() => window.__stemBundles.saves);
    expect(saves[0].includeOriginal).toBe(false);
  });

  test("shows the progress of a save, then the file", async ({ app }) => {
    await separate(app);
    await app.evaluate((path) => {
      window.__stemBundles.hold = true;
      window.__saveResult = path;
    }, BUNDLE_PATH);
    const dialog = await openSaveDialog(app);
    await dialog.getByRole("button", { name: "Save to this computer" }).click();
    const bar = dialog.getByRole("progressbar", { name: "Save progress" });
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute("aria-valuenow", "50");
    await expect(dialog.getByText(BUNDLE_PATH)).toHaveCount(0);

    await app.evaluate(() => window.__stemBundles.release?.());
    await expect(dialog.getByText(BUNDLE_PATH)).toBeVisible();
    await expect(bar).toHaveCount(0);
  });

  test("does nothing when the native save dialog is cancelled, and closes with Escape", async ({
    app,
  }) => {
    await separate(app);
    await app.evaluate(() => (window.__saveResult = null));
    const dialog = await openSaveDialog(app);
    await dialog.getByRole("button", { name: "Save to this computer" }).click();
    await expect(dialog.getByRole("button", { name: "Save to this computer" })).toBeEnabled();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    expect(await app.evaluate(() => window.__stemBundles.saves)).toEqual([]);
    await app.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(app.getByRole("button", { name: "Save stems" })).toBeFocused();
  });

  test("shows why saving failed, and can try again", async ({ app }) => {
    await separate(app);
    await app.evaluate((path) => {
      window.__stemBundles.fail = "There is not enough room on the disk.";
      window.__saveResult = path;
    }, BUNDLE_PATH);
    const dialog = await openSaveDialog(app);
    await dialog.getByRole("button", { name: "Save to this computer" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("There is not enough room on the disk.");
    await app.evaluate(() => (window.__stemBundles.fail = null));
    await dialog.getByRole("button", { name: "Save to this computer" }).click();
    await expect(dialog.getByText(BUNDLE_PATH)).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
  });

  /** Saves the page's stems to the bundle path, deletes them from the library and goes home. */
  async function saveAndForget(app: Page) {
    await separate(app);
    await app.evaluate((path) => (window.__saveResult = path), BUNDLE_PATH);
    await saveStems(app);
    await app.getByRole("button", { name: "Smart Beat", exact: true }).click();
    await stemCard(app, "neon-nights").getByRole("button", { name: "Delete neon-nights" }).click();
    await app.getByRole("button", { name: "Delete the stems of neon-nights" }).click();
    await expect(stemCard(app, "neon-nights")).toHaveCount(0);
  }

  test("opens saved stems from the start screen", async ({ app }) => {
    await saveAndForget(app);
    await app.evaluate((path) => (window.__dialogResult = path), BUNDLE_PATH);
    await app.getByRole("button", { name: "Open saved stems" }).click();
    await app.getByRole("button", { name: "Open from this computer" }).click();
    await expect(app.getByRole("heading", { level: 1, name: "neon-nights" })).toBeVisible();
    await expect(app.getByRole("list", { name: "Stems" }).getByRole("listitem")).toHaveCount(5);
    expect(await app.evaluate(() => window.__stemBundles.opens)).toEqual([BUNDLE_PATH]);
    // It is in the library again, marked as saved.
    await app.getByRole("button", { name: "Smart Beat", exact: true }).click();
    await expect(stemCard(app, "neon-nights").getByText("Saved", { exact: true })).toBeVisible();
  });

  test("shows why a stems file could not be opened", async ({ app }) => {
    await app.evaluate(() => (window.__dialogResult = "/Users/me/Music/broken.sbstems"));
    await app.getByRole("button", { name: "Open saved stems" }).click();
    await app.getByRole("button", { name: "Open from this computer" }).click();
    // A toast, as for a song that cannot be opened.
    await expect(app.getByText("Couldn't open the saved stems")).toBeVisible();
    await expect(app.getByText("This is not a Smart Beat stems file.")).toBeVisible();
    await expect(app.getByRole("heading", { level: 1, name: /Practice, create/ })).toBeVisible();
  });

  test("opens a stems file that the system asked for, like a double-click in Finder", async ({
    app,
  }) => {
    await saveAndForget(app);
    await app.evaluate(
      (path) => window.__emitTauriEvent("stems-bundle-opened", { path }),
      BUNDLE_PATH,
    );
    await expect(app.getByRole("heading", { level: 1, name: "neon-nights" })).toBeVisible();
    expect(await app.evaluate(() => window.__stemBundles.opens)).toEqual([BUNDLE_PATH]);
  });

  /** The options step with the engine cards (the dialog is open and a song is chosen). */
  async function toEngines(app: Page) {
    const dialog = await openDialog(app);
    await chooseSong(app, SONG_PATH, true);
    const group = dialog.getByRole("radiogroup", { name: "Engine" });
    await expect(group).toBeVisible();
    return { dialog, group };
  }

  test("lists the engines with what each is best at and recommends HTDemucs", async ({ app }) => {
    const { group } = await toEngines(app);
    await expect(group.getByRole("radio")).toHaveCount(6);
    await expect(group.getByRole("radio", { name: "HTDemucs", exact: true })).toBeChecked();
    await expect(group.getByRole("radio", { name: "Fast" })).not.toBeChecked();
    const card = (name: string) =>
      group.locator("[data-engine]").filter({ has: app.getByRole("radio", { name, exact: true }) });
    await expect(card("HTDemucs")).toContainText("Recommended");
    await expect(card("HTDemucs")).toContainText("Best all-round choice");
    await expect(card("SCNet XL")).toContainText("Best for vocals");
    await expect(card("SCNet Small")).toContainText("lightest of the new models");
    await expect(card("UMX-HQ")).toContainText("better on drums and bass");
    await expect(group.getByText("Recommended")).toHaveCount(1);
    await expect(card("HTDemucs")).toContainText("Download 168 MB");
  });

  test("downloads a model with its terms and progress, then separates with it", async ({ app }) => {
    await app.evaluate(() => {
      window.__stemModels.hold = true;
      window.__stems.hold = true;
    });
    const { dialog, group } = await toEngines(app);
    await group.getByRole("radio", { name: "HTDemucs", exact: true }).check();
    await expect(dialog.getByRole("button", { name: "Separate" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Download HTDemucs" }).click();
    const terms = dialog.getByTestId("stem-neural-setup");
    await expect(terms).toContainText("Terms of HTDemucs");
    const accept = terms.getByRole("button", { name: "Accept and download" });
    await expect(accept).toBeDisabled();
    await terms.getByRole("checkbox", { name: /I only use music I have the rights to/ }).check();
    await accept.click();

    const bar = dialog.getByRole("progressbar", { name: "Download progress" });
    await expect(bar).toHaveAttribute("aria-valuenow", "50");
    await expect(dialog.getByRole("button", { name: "Back" })).toBeDisabled();
    await app.evaluate(() => window.__stemModels.release?.());
    await expect(dialog.getByText("HTDemucs is on this computer.")).toBeVisible();
    expect(await app.evaluate(() => window.__stemModels.downloads)).toEqual(["htdemucs"]);

    await dialog.getByRole("button", { name: "Separate" }).click();
    await expect(dialog.getByRole("progressbar", { name: "Separation progress" })).toBeVisible();
    expect(await app.evaluate(() => window.__stems.requests)).toEqual([
      {
        path: SONG_PATH,
        kinds: ["drums", "bass", "vocals"],
        engine: "htdemucs",
        strongDrums: false,
      },
    ]);
    await app.evaluate(() => window.__stems.release?.());
    await expect(app.getByText(/HTDemucs engine/)).toBeVisible();
  });

  test("stops a download and goes back to the terms", async ({ app }) => {
    await app.evaluate(() => (window.__stemModels.hold = true));
    const { dialog, group } = await toEngines(app);
    await group.getByRole("radio", { name: "SCNet XL" }).check();
    await dialog.getByRole("button", { name: "Download SCNet XL" }).click();
    await dialog.getByRole("checkbox", { name: /I only use music/ }).check();
    await dialog.getByRole("button", { name: "Accept and download" }).click();
    await dialog.getByRole("button", { name: "Cancel download" }).click();
    await expect(dialog.getByRole("button", { name: "Accept and download" })).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    expect(await app.evaluate(() => window.__stemModels.cancelled)).toBe(1);
    await dialog.getByRole("button", { name: "Not now" }).click();
    await expect(group.getByRole("radio", { name: "SCNet XL" })).toBeChecked();
    await expect(dialog.getByRole("button", { name: "Separate" })).toBeDisabled();
  });

  test("cannot download a model that is not published yet", async ({ app }) => {
    await app.evaluate(() => (window.__stemModels.models["scnet-xl"].available = false));
    const { dialog, group } = await toEngines(app);
    await group.getByRole("radio", { name: "SCNet XL" }).check();
    await expect(dialog.getByText(/SCNet XL is not published yet/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Download SCNet XL" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Separate" })).toBeDisabled();
  });

  test("deletes a model from its card with a second click and moves the choice", async ({
    app,
  }) => {
    await app.evaluate(() => {
      Object.assign(window.__stemModels.models.scnet, { downloaded: true, termsAccepted: true });
    });
    const { dialog, group } = await toEngines(app);
    const card = group.locator("[data-engine=scnet]");
    await group.getByRole("radio", { name: "SCNet Small" }).check();
    await expect(dialog.getByRole("button", { name: "Separate" })).toBeEnabled();
    await expect(card).toContainText("On this computer");
    await card.getByRole("button", { name: "Delete the SCNet Small model" }).click();
    expect(await app.evaluate(() => window.__stemModels.removed)).toEqual([]);
    await card.getByRole("button", { name: "Delete SCNet Small" }).click();
    await expect(card).toContainText("Download 50 MB");
    expect(await app.evaluate(() => window.__stemModels.removed)).toEqual(["scnet"]);
    // Nothing else is on this computer: the choice is Fast again.
    await expect(group.getByRole("radio", { name: "Fast" })).toBeChecked();
    await expect(dialog.getByRole("button", { name: "Separate" })).toBeEnabled();
  });

  test("offers the 6-part engine with its size, its terms and Delete", async ({ app }) => {
    const { dialog, group } = await toEngines(app);
    const card = group.locator("[data-engine=htdemucs-6s]");
    await expect(card).toContainText("HTDemucs 6-part");
    await expect(card).toContainText("Download 111 MB");
    await group.getByRole("radio", { name: "HTDemucs 6-part" }).check();
    await dialog.getByRole("button", { name: "Download HTDemucs 6-part" }).click();
    await expect(dialog.getByTestId("stem-neural-setup")).toContainText("Terms of HTDemucs 6-part");
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Accept and download" }).click();
    await expect(card).toContainText("On this computer");
    await card.getByRole("button", { name: "Delete the HTDemucs 6-part model" }).click();
    await card.getByRole("button", { name: "Delete HTDemucs 6-part" }).click();
    await expect(card).toContainText("Download 111 MB");
  });

  test("closes the dialog with Escape and offers it again", async ({ app }) => {
    const dialog = await openDialog(app);
    await app.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(app.getByRole("button", { name: "Stem separation" })).toBeFocused();
    await openDialog(app);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`has no WCAG violations in the dialog at 375 px in ${colorScheme} mode`, async ({
      app,
    }) => {
      await app.setViewportSize({ width: 375, height: 812 });
      await app.emulateMedia({ colorScheme });
      const dialog = await openDialog(app);
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
      await chooseSong(app);
      await expect(dialog.getByRole("button", { name: "Separate" })).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
      expect(await dialog.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);

      await app.evaluate(() => (window.__stems.hold = true));
      await dialog.getByRole("button", { name: "Separate" }).click();
      await expect(dialog.getByRole("progressbar")).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
    });

    for (const width of [1280, 375]) {
      test(`has no WCAG violations in the engine cards and terms at ${width} px in ${colorScheme} mode`, async ({
        app,
      }) => {
        await app.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        await app.emulateMedia({ colorScheme });
        await app.evaluate(() => {
          window.__stemModels.models["scnet-xl"].available = false;
          Object.assign(window.__stemModels.models.scnet, {
            downloaded: true,
            termsAccepted: true,
          });
        });
        const { dialog, group } = await toEngines(app);
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });
        await group.getByRole("radio", { name: "HTDemucs", exact: true }).check();
        await expect(dialog.getByRole("button", { name: "Download HTDemucs" })).toBeVisible();
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });
        await group.getByRole("radio", { name: "SCNet XL" }).check();
        await expect(dialog.getByRole("button", { name: "Download SCNet XL" })).toBeDisabled();
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });
        await group.getByRole("radio", { name: "HTDemucs", exact: true }).check();
        await dialog.getByRole("button", { name: "Download HTDemucs" }).click();
        await expect(dialog.getByTestId("stem-neural-setup")).toBeVisible();
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });
        expect(await dialog.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
      });

      test(`has no WCAG violations in the Save dialog at ${width} px in ${colorScheme} mode`, async ({
        app,
      }) => {
        await app.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        await app.emulateMedia({ colorScheme });
        await separate(app);
        const dialog = await openSaveDialog(app);
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });

        // The original is gone: the box is disabled.
        await dialog.getByRole("button", { name: "Close" }).first().click();
        await app.evaluate(() => (window.__stems.songs[0].hasOriginal = false));
        await app.getByRole("button", { name: "Smart Beat", exact: true }).click();
        await stemCard(app, "neon-nights")
          .getByRole("button", { name: /^neon-nights/ })
          .click();
        await openSaveDialog(app);
        await expect(
          dialog.getByRole("checkbox", { name: "Include the original song" }),
        ).toBeDisabled();
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });
        await dialog.getByRole("button", { name: "Close" }).first().click();

        // Saving: the progress bar.
        await app.evaluate((path) => {
          window.__stemBundles.hold = true;
          window.__saveResult = path;
        }, BUNDLE_PATH);
        await openSaveDialog(app);
        await dialog.getByRole("button", { name: "Save to this computer" }).click();
        await expect(dialog.getByRole("progressbar", { name: "Save progress" })).toBeVisible();
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });

        // Saved: the path.
        await app.evaluate(() => window.__stemBundles.release?.());
        await expect(dialog.getByText(BUNDLE_PATH)).toBeVisible();
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });
        expect(await dialog.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);

        // A failure.
        await dialog.getByRole("button", { name: "Close" }).first().click();
        await app.evaluate(() => {
          window.__stemBundles.hold = false;
          window.__stemBundles.fail = "There is not enough room on the disk.";
        });
        await openSaveDialog(app);
        await dialog.getByRole("button", { name: "Save to this computer" }).click();
        await expect(dialog.getByRole("alert")).toBeVisible();
        await app.mouse.move(0, 0);
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });
      });

      test(`has no WCAG violations in the Recent grid with stems at ${width} px in ${colorScheme} mode`, async ({
        app,
      }) => {
        await app.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        await app.emulateMedia({ colorScheme });
        await separate(app);
        await app.evaluate((path) => (window.__saveResult = path), BUNDLE_PATH);
        await saveStems(app);
        await app.getByRole("button", { name: "Smart Beat", exact: true }).click();
        await separate(app, "/Users/me/Music/blue-moon.mp3");
        await app.getByRole("button", { name: "Smart Beat", exact: true }).click();
        await expect(
          stemCard(app, "neon-nights").getByText("Saved", { exact: true }),
        ).toBeVisible();
        await expect(stemCard(app, "blue-moon").getByText("Stems", { exact: true })).toBeVisible();
        await expectNoA11yViolations(app);
        // The delete question is open on one card.
        await stemCard(app, "blue-moon").getByRole("button", { name: "Delete blue-moon" }).click();
        await app.mouse.move(0, 0);
        await expectNoA11yViolations(app);
        expect(
          await app.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        ).toBeLessThanOrEqual(0);
      });

      test(`has no WCAG violations on the page at ${width} px in ${colorScheme} mode`, async ({
        app,
      }) => {
        await app.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        await app.emulateMedia({ colorScheme });
        await separate(app);
        await expect(app.getByRole("button", { name: "Play" })).toBeEnabled();
        await expectNoA11yViolations(app);
        // With a loop drawn and a stem muted.
        await app.getByRole("button", { name: "Set loop start" }).click();
        await app.getByTestId("stem-drums").getByRole("button", { name: "Mute Drums" }).click();
        await expectNoA11yViolations(app);
        expect(
          await app.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        ).toBeLessThanOrEqual(0);
      });
    }

    for (const width of [375, 1280]) {
      test(`has no WCAG violations with the tempo menus open at ${width} px in ${colorScheme} mode`, async ({
        app,
      }) => {
        await app.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        await app.emulateMedia({ colorScheme });
        await mockTempo(app, CHANGING_TEMPO);
        await separate(app);
        await expect(app.getByRole("button", { name: "Play" })).toBeEnabled();
        await app.getByRole("button", { name: "Metronome" }).click();
        await app.getByTestId("stem-tempo").click();
        await expect(app.getByRole("dialog", { name: "Tempo" })).toBeVisible();
        await expectNoA11yViolations(app);
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });
        await app.keyboard.press("Escape");
        await app.getByTestId("stem-tempo-changes").click();
        await expect(app.getByRole("dialog", { name: "Tempo changes" })).toBeVisible();
        await expectNoA11yViolations(app);
        await app.keyboard.press("Escape");
        await app.getByRole("button", { name: "Click sound and volume" }).click();
        await expectNoA11yViolations(app);
        expect(
          await app.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        ).toBeLessThanOrEqual(0);
      });
    }
  }
});
