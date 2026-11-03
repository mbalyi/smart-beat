import type { Page } from "@playwright/test";

import features from "../src/lib/features.json" with { type: "json" };

import { expect, expectNoA11yViolations, tabKey, test } from "./fixtures";

declare global {
  interface Window {
    __stems: {
      songs: { id: string; name: string; skipped: string[] }[];
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

/** Stem separation (#186), with the stems commands mocked in e2e/tauri-mock.js. */

const SONG_PATH = "/Users/me/Music/neon-nights.mp3";

test.describe("Stem separation (#186)", () => {
  test.skip(!features["stem-separation"], "stem-separation is off in src/lib/features.json");

  async function openDialog(app: Page) {
    await app.getByRole("button", { name: "Stem separation…" }).click();
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
    await dialog.getByRole("button", { name: "Choose a song…" }).click();
    await expect(dialog.getByTestId("stem-file-name")).toBeVisible();
    await dialog.getByRole("button", { name: "Next" }).click();
    if (!keepEngine) await dialog.getByRole("radio", { name: "Fast" }).check();
    return dialog;
  }

  /** Welcome button, song, Separate, and the page. */
  async function separate(app: Page) {
    await openDialog(app);
    const dialog = await chooseSong(app);
    await dialog.getByRole("button", { name: "Separate" }).click();
    await expect(app.getByRole("heading", { level: 1, name: "neon-nights" })).toBeVisible();
    return app.getByRole("list", { name: "Stems" });
  }

  test("goes from the start screen to the dialog, the progress and the page", async ({ app }) => {
    await app.evaluate(() => (window.__stems.hold = true));
    const dialog = await openDialog(app);
    await expect(dialog.getByText("Runs on this computer. Nothing is uploaded.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Next" })).toBeDisabled();
    await chooseSong(app, SONG_PATH, true);

    // HTDemucs is chosen first; the built-in engine is the one with parts to choose from.
    await expect(dialog.getByRole("radio", { name: "HTDemucs" })).toBeChecked();
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
    await app.getByRole("radio", { name: "Speed 80%" }).click();
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
    await app.getByRole("radio", { name: "Speed 60%" }).click();
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

  test("lists separated songs on the start screen, reopens one and deletes one", async ({
    app,
  }) => {
    await separate(app);
    await app.getByRole("button", { name: "Back to start" }).click();
    await expect(app.getByRole("heading", { level: 1, name: /Practice, create/ })).toBeVisible();
    const section = app.getByRole("region", { name: "Your separated songs" });
    await expect(section.getByRole("button", { name: /^neon-nights/ })).toBeVisible();

    await section.getByRole("button", { name: /^neon-nights/ }).click();
    await expect(app.getByRole("heading", { level: 1, name: "neon-nights" })).toBeVisible();
    await app.getByRole("button", { name: "Back to start" }).click();

    await section.getByRole("button", { name: "Delete neon-nights" }).click();
    await section.getByRole("button", { name: "Delete the stems of neon-nights" }).click();
    await expect(section).toHaveCount(0);
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
    await expect(group.getByRole("radio")).toHaveCount(5);
    await expect(group.getByRole("radio", { name: "HTDemucs" })).toBeChecked();
    await expect(group.getByRole("radio", { name: "Fast" })).not.toBeChecked();
    const card = (name: string) =>
      group.locator("label").filter({ has: app.getByRole("radio", { name }) });
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
    await group.getByRole("radio", { name: "HTDemucs" }).check();
    await expect(dialog.getByRole("button", { name: "Separate" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Download HTDemucs…" }).click();
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
    await dialog.getByRole("button", { name: "Download SCNet XL…" }).click();
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
    await expect(dialog.getByRole("button", { name: "Download SCNet XL…" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Separate" })).toBeDisabled();
  });

  test("removes a model that is on this computer", async ({ app }) => {
    await app.evaluate(() => {
      Object.assign(window.__stemModels.models.scnet, { downloaded: true, termsAccepted: true });
    });
    const { dialog, group } = await toEngines(app);
    await group.getByRole("radio", { name: "SCNet Small" }).check();
    await expect(dialog.getByRole("button", { name: "Separate" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Remove SCNet Small from this computer" }).click();
    await expect(dialog.getByRole("button", { name: "Download SCNet Small…" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Separate" })).toBeDisabled();
    expect(await app.evaluate(() => window.__stemModels.removed)).toEqual(["scnet"]);
  });

  test("closes the dialog with Escape and offers it again", async ({ app }) => {
    const dialog = await openDialog(app);
    await app.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(app.getByRole("button", { name: "Stem separation…" })).toBeFocused();
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
        await group.getByRole("radio", { name: "HTDemucs" }).check();
        await expect(dialog.getByRole("button", { name: "Download HTDemucs…" })).toBeVisible();
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });
        await group.getByRole("radio", { name: "SCNet XL" }).check();
        await expect(dialog.getByRole("button", { name: "Download SCNet XL…" })).toBeDisabled();
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });
        await group.getByRole("radio", { name: "HTDemucs" }).check();
        await dialog.getByRole("button", { name: "Download HTDemucs…" }).click();
        await expect(dialog.getByTestId("stem-neural-setup")).toBeVisible();
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });
        expect(await dialog.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
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
  }
});
