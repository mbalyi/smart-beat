import {
  dropFiles,
  expect,
  expectNoA11yViolations,
  openSong,
  playedSeconds,
  test,
} from "./fixtures";
import type { Locator, Page } from "@playwright/test";

/**
 * Effect chains and the pedalboard (#34, #36): the library, drag and drop,
 * knobs, presets, sounds and sound automation, the mastering chain and the
 * native engine switch. The engine itself is mocked (see tauri-mock.js):
 * these tests cover the UI and what it sends.
 */

async function openPedalboard(app: Page, track = "Guitar") {
  await app.getByRole("button", { name: `Actions for ${track}` }).click();
  await app.getByRole("menuitem", { name: "Effects (pedalboard)…" }).click();
  const dialog = app.getByRole("dialog", { name: `Pedalboard: ${track}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

const libraryItem = (dialog: Locator, name: string) =>
  dialog.getByTestId("library-effect").filter({ hasText: new RegExp(`^${name}$`) });

test.describe("pedalboard (#36)", () => {
  test("adds effects from the library, by button and by dragging, and turns knobs", async ({
    app,
  }) => {
    await openSong(app);
    const dialog = await openPedalboard(app);
    await expectNoA11yViolations(app);
    await dialog.getByRole("combobox", { name: "Effect category" }).click();
    await app.getByRole("option", { name: "Time" }).click();
    await expect(dialog.getByTestId("library-effect")).toHaveCount(2);
    await dialog.getByRole("button", { name: "Add Delay" }).click();
    await libraryItem(dialog, "Reverb").dragTo(dialog.getByTestId("pedalboard"));
    await expect(dialog.getByTestId("effect-block")).toHaveCount(2);
    await expect(dialog.getByRole("listitem", { name: "Reverb 2" })).toBeVisible();

    // Drag the reverb in front of the delay, then drag the delay back out.
    // Pedals are grabbed by their grip (#128).
    await dialog
      .getByRole("listitem", { name: "Reverb 2" })
      .getByTestId("pedal-grip")
      .dragTo(dialog.getByRole("listitem", { name: "Delay 1" }));
    await expect(dialog.getByRole("listitem", { name: "Reverb 1" })).toBeVisible();
    await dialog
      .getByRole("listitem", { name: "Delay 2" })
      .getByTestId("pedal-grip")
      .dragTo(dialog.getByTestId("effect-library"));
    await expect(dialog.getByTestId("effect-block")).toHaveCount(1);

    const mix = dialog.getByRole("slider", { name: "Reverb 1, Mix" });
    await mix.focus();
    await app.keyboard.press("ArrowUp");
    await expect(mix).toHaveAttribute("aria-valuetext", "26%");
    // Delete on the focused pedal removes it.
    await dialog.getByRole("listitem", { name: "Reverb 1" }).focus();
    await app.keyboard.press("Delete");
    await expect(dialog.getByTestId("effect-block")).toHaveCount(0);
  });

  test("loads a genre preset from the inspector's pedalboard", async ({ app }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Pedalboard…" }).click();
    const dialog = app.getByRole("dialog", { name: "Pedalboard: Guitar" });
    await dialog.getByRole("combobox", { name: "Genre" }).click();
    await app.getByRole("option", { name: "Metalcore" }).click();
    await dialog.getByRole("combobox", { name: "Guitar presets" }).click();
    await app.getByRole("option", { name: /Metalcore tight/ }).click();
    // Gate › compressor › boost › amp › cab › EQ (#42).
    await expect(dialog.getByTestId("effect-block")).toHaveCount(6);
    await expect(dialog.getByRole("listitem", { name: "Cabinet 5" })).toBeVisible();
  });

  test("the mastering chain holds three effects and is one switch away", async ({ app }) => {
    await openSong(app);
    const dialog = await openPedalboard(app);
    await dialog.getByRole("radio", { name: "Mastering" }).click();
    const master = app.getByRole("dialog", { name: "Pedalboard: Master" });
    await master.getByRole("combobox", { name: "Master presets" }).click();
    await app.getByRole("option", { name: /Loud metal master/ }).click();
    await expect(master.getByTestId("effect-block")).toHaveCount(3);
    await expect(master.getByRole("button", { name: "Add Reverb" })).toBeDisabled();
  });

  test("names the track being edited, not the one highlighted in the mixer (#83)", async ({
    app,
  }) => {
    await openSong(app);
    // Bass is the highlighted track; the pedalboard is opened from the Guitar row.
    await app.getByRole("button", { name: "Show Bass" }).click();
    await expect(app.getByRole("button", { name: /^Show Bass/ })).toContainText("(shown)");
    const dialog = await openPedalboard(app, "Guitar");
    await expect(dialog.getByRole("radio", { name: "Current track: Guitar" })).toBeVisible();
    await expect(dialog.getByRole("radiogroup", { name: "Chain to edit" })).not.toContainText(
      "Bass",
    );
    // Mastering and back returns to the track it was opened for.
    await dialog.getByRole("radio", { name: "Mastering" }).click();
    const master = app.getByRole("dialog", { name: "Pedalboard: Master" });
    await expect(master.getByRole("radio", { name: "Current track: Guitar" })).toBeVisible();
    await master.getByRole("radio", { name: "Current track: Guitar" }).click();
    await expect(app.getByRole("dialog", { name: "Pedalboard: Guitar" })).toBeVisible();
  });

  test("gives a track a second sound that switches in at a bar", async ({ app }) => {
    await openSong(app);
    await app.getByRole("switch", { name: "Native engine with effects" }).click();
    await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
    const dialog = await openPedalboard(app);
    await dialog.getByRole("button", { name: "Add Chorus" }).click();
    await dialog.getByRole("button", { name: "Add sound" }).click();
    await expect(dialog.getByRole("combobox", { name: "Sound" })).toHaveText("Sound 2");
    await dialog.getByRole("button", { name: "Add Tremolo" }).click();
    const automation = dialog.getByRole("region", { name: "Sound automation" });
    await automation.getByRole("button", { name: "Add a switch" }).click();
    await automation.getByRole("spinbutton", { name: "From bar" }).fill("3");
    await expect
      .poll(() => app.evaluate(() => window.__engineConfig.sounds[0]?.switches.length))
      .toBeGreaterThan(0);
    const sounds = await app.evaluate(() => window.__engineConfig.sounds[0]?.sounds);
    expect((sounds as { type: string }[][]).map((chain) => chain.map((s) => s.type))).toEqual([
      ["chorus"],
      ["chorus", "tremolo"],
    ]);
    await expectNoA11yViolations(app);
  });

  test("imports a cabinet into the sound library, renames and removes it", async ({ app }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Pedalboard…" }).click();
    await app.getByRole("button", { name: "Sounds…" }).click();
    const library = app.getByRole("dialog", { name: "Sound library" });
    await expect(library.getByText("4×12 modern (generated)")).toBeVisible();
    await expectNoA11yViolations(app);
    await app.evaluate(() => (window.__dialogResult = "/irs/V30 Mesa.wav"));
    await library.getByRole("button", { name: "Import .wav…" }).click();
    await expect(library.getByText("V30 Mesa", { exact: true })).toBeVisible();

    await library.getByRole("button", { name: "Rename V30 Mesa" }).click();
    await library.getByRole("textbox", { name: "Name of V30 Mesa" }).fill("Mesa 4×12");
    await library.getByRole("button", { name: "Save the name and tags" }).click();
    await expect(library.getByText("Mesa 4×12", { exact: true })).toBeVisible();
    await library.getByRole("button", { name: "Remove Mesa 4×12" }).click();
    await expect(library.getByText("Mesa 4×12", { exact: true })).toHaveCount(0);
  });

  test("imports an amp capture and a cabinet, then drags them onto the board (#41)", async ({
    app,
  }) => {
    await openSong(app);
    const dialog = await openPedalboard(app);
    await dialog.getByRole("button", { name: "Sounds…" }).click();
    const library = app.getByRole("dialog", { name: "Sound library" });
    await app.evaluate(() => (window.__dialogResult = "/captures/Plexi crunch.nam"));
    await library.getByRole("button", { name: "Import .nam…" }).click();
    await expect(library.getByText("Plexi crunch", { exact: true })).toBeVisible();
    await app.evaluate(() => (window.__dialogResult = "/irs/Greenback.wav"));
    await library.getByRole("button", { name: "Import .wav…" }).click();
    await expect(library.getByText("Greenback", { exact: true })).toBeVisible();
    // Tags, then the filter.
    await library.getByRole("button", { name: "Rename Greenback" }).click();
    await library.getByRole("textbox", { name: "Tags of Greenback" }).fill("rock, vintage");
    await library.getByRole("button", { name: "Save the name and tags" }).click();
    await library.getByRole("button", { name: "vintage" }).click();
    await expect(library.getByTestId("library-item")).toHaveCount(1);
    await library.getByRole("button", { name: "vintage" }).click();
    await expectNoA11yViolations(app);
    await library.getByRole("button", { name: "Done" }).click();

    // Both are in "My sounds" now: drag them onto the board.
    const mine = dialog.getByRole("list", { name: "Your amps and cabinets" });
    await mine
      .getByTestId("library-asset")
      .filter({ hasText: "Plexi crunch" })
      .dragTo(dialog.getByTestId("pedalboard"));
    await mine
      .getByTestId("library-asset")
      .filter({ hasText: "Greenback" })
      .dragTo(dialog.getByTestId("pedalboard"));
    await expect(dialog.getByTestId("effect-block")).toHaveCount(2);
    // (A pedal dropped on the middle of the board may land before another.)
    await expect(dialog.getByRole("listitem", { name: /^Amp \(capture\) \d/ })).toBeVisible();
    await expect(dialog.getByRole("listitem", { name: /^Cabinet \d/ })).toBeVisible();
    // The capture is selected in its block, and loudness matching is a switch.
    await expect(dialog.getByRole("combobox", { name: "Amp or pedal capture" })).toContainText(
      "Plexi crunch",
    );
    const matching = dialog.getByRole("switch", { name: /Amp \(capture\) \d: Match loudness/ });
    await matching.click();
    await expect(matching).toBeChecked();
    await expectNoA11yViolations(app);
  });

  test("a broken or wrong file gives a clear error and adds nothing (#41)", async ({ app }) => {
    await openSong(app);
    await app.getByRole("button", { name: "Pedalboard…" }).click();
    await app.getByRole("button", { name: "Sounds…" }).click();
    const library = app.getByRole("dialog", { name: "Sound library" });
    const before = await library.getByTestId("library-item").count();
    await app.evaluate(() => (window.__dialogResult = "/captures/broken.nam"));
    await library.getByRole("button", { name: "Import .nam…" }).click();
    await expect(app.getByText("The file could not be imported")).toBeVisible();
    await expect(app.getByText(/not a Neural Amp Modeler file/)).toBeVisible();
    // A WAV file given to the capture importer.
    await app.evaluate(() => (window.__dialogResult = "/irs/cab.wav"));
    await library.getByRole("button", { name: "Import .nam…" }).click();
    await expect(app.getByText("This is not a Neural Amp Modeler (.nam) file")).toBeVisible();
    await expect(library.getByTestId("library-item")).toHaveCount(before);
    // A long impulse response imports, with a note about it.
    await app.evaluate(() => (window.__dialogResult = "/irs/Big hall.wav"));
    await library.getByRole("button", { name: "Import .wav…" }).click();
    await expect(library.getByText(/Only the first 1.4 s/)).toBeVisible();
  });

  test("dropping a .nam file on the window imports it into the library (#41)", async ({ app }) => {
    await openSong(app);
    await dropFiles(app, ["/captures/Dropped amp.nam"]);
    await expect(app.getByText("Imported “Dropped amp”")).toBeVisible();
    await app.getByRole("button", { name: "Pedalboard…" }).click();
    const dialog = app.getByRole("dialog", { name: "Pedalboard: Guitar" });
    await expect(
      dialog.getByRole("list", { name: "Your amps and cabinets" }).getByText("Dropped amp"),
    ).toBeVisible();
  });

  test("the sound library and the pedalboard with imported sounds pass the accessibility checks in dark mode (#41)", async ({
    app,
  }) => {
    await app.emulateMedia({ colorScheme: "dark" });
    await openSong(app);
    const dialog = await openPedalboard(app);
    await dialog.getByRole("button", { name: "Sounds…" }).click();
    const library = app.getByRole("dialog", { name: "Sound library" });
    await app.evaluate(() => (window.__dialogResult = "/captures/Plexi crunch.nam"));
    await library.getByRole("button", { name: "Import .nam…" }).click();
    await app.evaluate(() => (window.__dialogResult = "/irs/Big hall.wav"));
    await library.getByRole("button", { name: "Import .wav…" }).click();
    await library.getByRole("button", { name: "Rename Plexi crunch" }).click();
    await library.getByRole("textbox", { name: "Tags of Plexi crunch" }).fill("metal");
    await library.getByRole("button", { name: "Save the name and tags" }).click();
    await expect(library.getByRole("group", { name: "Filter by tag" })).toBeVisible();
    await expect(library.getByText(/Only the first 1.4 s/)).toBeVisible();
    await expectNoA11yViolations(app);
    await library.getByRole("button", { name: "Done" }).click();
    await expect(dialog.getByTestId("library-asset").first()).toBeVisible();
    await expectNoA11yViolations(app);
  });

  test("the pedalboard passes the accessibility checks in dark mode", async ({ app }) => {
    await app.emulateMedia({ colorScheme: "dark" });
    await openSong(app);
    const dialog = await openPedalboard(app);
    await dialog.getByRole("button", { name: "Add Amp", exact: true }).click();
    await dialog.getByRole("button", { name: "Add Equalizer" }).click();
    await expectNoA11yViolations(app);
  });

  test("the native engine plays through the effects and drives the cursor", async ({ app }) => {
    await openSong(app);
    await app.getByRole("switch", { name: "Native engine with effects" }).click();
    await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });

    const dialog = await openPedalboard(app);
    await dialog.getByRole("button", { name: "Add Equalizer" }).click();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect
      .poll(() =>
        app.evaluate(() => window.__engineChains?.[0]?.map((s: { type: string }) => s.type)),
      )
      .toEqual(["eq"]);

    await app.getByRole("button", { name: "Play" }).click();
    await expect.poll(() => playedSeconds(app), { timeout: 10_000 }).toBeGreaterThan(0);
    await app.getByRole("button", { name: "Stop" }).click();
  });
});

/** Third-party plugins: VST3 and CLAP blocks (#80). */
test.describe("plugins (#80)", () => {
  test("adds a scanned plugin block and saves its settings", async ({ app }) => {
    await openSong(app);
    await app.getByRole("switch", { name: "Native engine with effects" }).click();
    await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
    const dialog = await openPedalboard(app);
    await dialog.getByRole("switch", { name: "Use third-party plugins" }).click();
    await dialog.getByRole("button", { name: /Scan for plugins/ }).click();
    await app.evaluate(() => {
      window.__pluginLoading = true;
    });
    await dialog.getByRole("button", { name: "Add plugin Test Amp" }).click();
    await expect(dialog.getByRole("listitem", { name: "Test Amp 1" })).toBeVisible();
    await expect(dialog.getByText("Test Amp · Loading…", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Open editor…" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Save settings" })).toBeDisabled();
    await expectNoA11yViolations(app);
    await app.evaluate(() => {
      window.__pluginLoading = false;
    });
    await expect(dialog.getByText("Test Amp · +5.3 ms", { exact: true })).toBeVisible();
    // The block reaches the engine with its scanned path.
    await expect
      .poll(() =>
        app.evaluate(
          () => window.__engineChains?.[0] as { type: string; path?: string }[] | undefined,
        ),
      )
      .toEqual([
        {
          type: "plugin",
          enabled: true,
          format: "vst3",
          path: expect.any(String),
          name: "Test Amp",
          state: "",
        },
      ]);
    // The plugin's own editor opens and its settings land in the block.
    await dialog.getByRole("button", { name: "Open editor…" }).click();
    await dialog.getByRole("button", { name: "Save settings" }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (window.__engineChains?.[0] as { type: string; state?: string }[] | undefined)?.[0]
              ?.state,
        ),
      )
      .toBe("aGk=");
    await dialog.getByRole("switch", { name: "Use third-party plugins" }).click();
    await expect.poll(() => app.evaluate(() => window.__pluginsEnabled)).toBe(false);
    await expect(dialog.getByRole("button", { name: "Open editor…" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Save settings" })).toBeDisabled();
    await dialog.getByRole("switch", { name: "Use third-party plugins" }).click();
    await expect.poll(() => app.evaluate(() => window.__pluginsEnabled)).toBe(true);
    await expect(dialog.getByRole("button", { name: "Open editor…" })).toBeEnabled();
  });
});

/** Compressor settings and the mastering chain (#39). */
test.describe("compressor and mastering (#39)", () => {
  async function withEngine(app: Page) {
    await openSong(app);
    await app.getByRole("switch", { name: "Native engine with effects" }).click();
    await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
  }

  test("a mastering chain of EQ, compressor and limiter reaches the engine", async ({ app }) => {
    await withEngine(app);
    // Playing first: the pedalboard is modal, and its meters move while playing.
    // Right after the engine starts a click can come too early: try until it plays.
    await expect(async () => {
      if (await app.getByRole("button", { name: "Play" }).isVisible()) {
        await app.getByRole("button", { name: "Play" }).click();
      }
      await expect(app.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    const dialog = await openPedalboard(app);
    await dialog.getByRole("radio", { name: "Mastering" }).click();
    const master = app.getByRole("dialog", { name: "Pedalboard: Master" });
    for (const name of ["Equalizer", "Compressor", "Limiter"]) {
      await master.getByRole("button", { name: `Add ${name}` }).click();
    }
    await expect(master.getByRole("button", { name: "Add Reverb" })).toBeDisabled();
    await master.getByRole("combobox", { name: "Limiter 3: preset" }).click();
    await app.getByRole("option", { name: "Master loud" }).click();
    await expect
      .poll(() =>
        app.evaluate(() =>
          (
            window.__engineChains?.master as { type: string; ceilingDb?: number }[] | undefined
          )?.map((s) => [s.type, s.ceilingDb ?? null]),
        ),
      )
      .toEqual([
        ["eq", null],
        ["compressor", null],
        ["limiter", -0.8],
      ]);

    // While playing, the compressor and the limiter show how hard they work.
    await expect(
      master.getByRole("meter", { name: "Limiter 3: gain reduction" }),
    ).not.toHaveAttribute("aria-valuetext", "No reduction");
    await expectNoA11yViolations(app);
  });

  test("a compressor preset reaches the engine", async ({ app }) => {
    await withEngine(app);
    const dialog = await openPedalboard(app);
    await dialog.getByRole("button", { name: "Add Compressor" }).click();
    await dialog.getByRole("combobox", { name: "Compressor 1: preset" }).click();
    await app.getByRole("option", { name: "Guitar and bass glue" }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () => (window.__engineChains?.[0] as { ratio?: number }[] | undefined)?.[0]?.ratio,
        ),
      )
      .toBe(3);
  });

  test("the drum mixer's bus compressor squeezes the whole kit", async ({ app }) => {
    await app.emulateMedia({ colorScheme: "dark" });
    await withEngine(app);
    await app.getByRole("combobox", { name: "Track" }).click();
    await app.getByRole("option", { name: "Drums" }).click();
    await app.getByRole("button", { name: "Drum mixer…" }).click();
    const mixer = app.getByRole("dialog", { name: "Drum mixer: Drums" });
    await mixer.getByRole("button", { name: "Add a bus compressor" }).click();
    await expect
      .poll(() =>
        app.evaluate(() =>
          (window.__engineChains?.[2] as { type: string }[] | undefined)?.map((s) => s.type),
        ),
      )
      .toEqual(["compressor"]);
    await expect(mixer.getByRole("combobox", { name: "Preset" })).toHaveText("Parallel drum bus");
    await expectNoA11yViolations(app);
  });
});

/** Heavy-genre presets and the preset browser (#42). */
test.describe("preset browser (#42)", () => {
  async function withEngine(app: Page) {
    await openSong(app);
    await app.getByRole("switch", { name: "Native engine with effects" }).click();
    await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
  }

  test("filters by genre and applies a guitar tone", async ({ app }) => {
    await withEngine(app);
    const dialog = await openPedalboard(app);
    await dialog.getByRole("button", { name: "Browse presets…" }).click();
    const browser = app.getByRole("dialog", { name: "Presets" });
    await browser
      .getByRole("radiogroup", { name: "Genre" })
      .getByRole("radio", { name: "Djent" })
      .click();
    await expect(browser.getByTestId("preset").first()).toContainText("Djent");
    await browser.getByTestId("preset").filter({ hasText: "Djent 8-string" }).click();
    await expectNoA11yViolations(app);
    await browser.getByRole("button", { name: /^Apply/ }).click();
    await expect(browser).toBeHidden();
    await expect
      .poll(() =>
        app.evaluate(() =>
          (window.__engineChains?.[0] as { type: string }[] | undefined)?.map((s) => s.type),
        ),
      )
      .toEqual(["gate", "compressor", "drive", "ampSim", "cab", "eq"]);
  });

  test("applies a drum mix: kit levels and the drum bus", async ({ app }) => {
    await app.emulateMedia({ colorScheme: "dark" });
    await withEngine(app);
    await app.getByRole("combobox", { name: "Track" }).click();
    await app.getByRole("option", { name: "Drums" }).click();
    await app.getByRole("button", { name: "Drum mixer…" }).click();
    await app.getByRole("button", { name: "Drum mix presets…" }).click();
    const browser = app.getByRole("dialog", { name: "Presets" });
    await browser.getByTestId("preset").filter({ hasText: "Deathcore blast" }).click();
    await expectNoA11yViolations(app);
    await browser.getByRole("button", { name: /^Apply/ }).click();
    await expect
      .poll(() =>
        app.evaluate(() => {
          const drums = window.__engineConfig.drums[2];
          return drums ? drums.elements.length : 0;
        }),
      )
      .toBeGreaterThan(10);
    await expect
      .poll(() =>
        app.evaluate(() =>
          (window.__engineChains?.[2] as { type: string }[] | undefined)?.map((s) => s.type),
        ),
      )
      .toEqual(["gate", "compressor", "eq"]);
    // The drum mixer shows the new levels.
    const mixer = app.getByRole("dialog", { name: "Drum mixer: Drums" });
    await expect(mixer.getByRole("slider", { name: "Volume, Hi-Hat" })).toHaveAttribute(
      "aria-valuetext",
      "-8.0 dB",
    );
  });

  test("applies a mastering preset that ends in the limiter", async ({ app }) => {
    await withEngine(app);
    const dialog = await openPedalboard(app);
    await dialog.getByRole("radio", { name: "Mastering" }).click();
    await app.getByRole("button", { name: "Browse presets…" }).click();
    const browser = app.getByRole("dialog", { name: "Presets" });
    await browser
      .getByRole("radiogroup", { name: "Genre" })
      .getByRole("radio", { name: "Metalcore" })
      .click();
    await browser.getByTestId("preset").filter({ hasText: "Metalcore master" }).click();
    await browser.getByRole("button", { name: /^Apply/ }).click();
    await expect
      .poll(() =>
        app.evaluate(() =>
          (window.__engineChains?.master as { type: string }[] | undefined)?.map((s) => s.type),
        ),
      )
      .toEqual(["eq", "compressor", "limiter"]);
  });
});
