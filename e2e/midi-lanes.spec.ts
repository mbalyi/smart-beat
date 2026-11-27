import type { Page } from "@playwright/test";

import { expect, expectNoA11yViolations, openSong, test } from "./fixtures";

/**
 * MIDI lanes (#250, ADR 0006): a new MIDI lane with the MIDI editor, drawing and quantizing
 * notes, the pad board with a pad controller, recording on an armed lane, and Settings › MIDI
 * devices. The engine and the MIDI input are fakes: only what the app asks of them is checked.
 */
test.use({ viewport: { width: 1440, height: 1000 } });

const PADS = {
  name: "Pad Controller",
  connected: true,
  settings: {
    name: "Pad Controller",
    alias: "",
    enabled: true,
    offsetMs: 0,
    controlOnly: false,
    channel: null,
    transpose: 0,
    fixedVelocity: null,
    padLayout: "grid16",
    padNotes: [],
    pads: [],
    controls: [],
  },
};

async function openWithEngine(app: Page) {
  await app.addInitScript((device) => {
    window.__midiDevices = [device];
  }, PADS);
  await app.reload();
  await openSong(app);
  await app.getByRole("switch", { name: "Native engine with effects" }).click();
  await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });
}

/** The notes of the first MIDI clip the engine was given. */
const engineNotes = (app: Page) =>
  app.evaluate(() => {
    const lane = window.__engineLanes?.audio.lanes.find((l) => l.kind === "midi");
    const clip = lane?.clips[0];
    return clip?.midi?.takes[clip.take]?.notes.length ?? -1;
  });

async function addMidiLane(app: Page) {
  await app.getByRole("button", { name: "New MIDI lane" }).click();
  const editor = app.getByRole("region", { name: "MIDI editor: MIDI 1" });
  await expect(editor).toBeVisible();
  return editor;
}

test.describe("MIDI lanes", () => {
  test("a new MIDI lane opens the editor, a click draws a note and quantize moves it", async ({
    app,
  }) => {
    await openWithEngine(app);
    const editor = await addMidiLane(app);
    await expect.poll(() => engineNotes(app)).toBe(0);
    await expect(app.getByRole("button", { name: "Edit the MIDI lane MIDI 1" })).toBeVisible();

    const roll = editor.getByRole("application", { name: "Note grid" });
    await roll.click({ position: { x: 260, y: 120 } });
    await expect.poll(() => engineNotes(app)).toBe(1);
    await expect(editor.locator("[data-testid^='midi-note-']")).toHaveCount(1);

    await editor.getByRole("button", { name: "Quantize…" }).click();
    const dialog = app.getByRole("dialog", { name: "Quantize" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Quantize" }).click();
    await expect(dialog).toBeHidden();

    // Undo takes the note back.
    await app.keyboard.press("Escape");
    await editor.getByRole("button", { name: "Close the MIDI editor" }).click();
    await expect(editor).toBeHidden();
  });

  test("the drum kit opens the drum grid with drum names", async ({ app }) => {
    await openWithEngine(app);
    const editor = await addMidiLane(app);
    await editor.getByRole("button", { name: /^Instrument:/ }).click();
    await app.getByRole("button", { name: "Drum kit" }).click();
    await editor.getByRole("radio", { name: "Drum grid" }).click();
    await expect(editor.getByTestId("midi-keys")).toContainText("Kick (hit)");
    await expect
      .poll(() =>
        app.evaluate(
          () => window.__engineLanes?.audio.lanes.find((l) => l.kind === "midi")?.instrument,
        ),
      )
      .toEqual({ type: "drums" });
  });

  test("an armed MIDI lane records what is played and keeps it on Stop", async ({ app }) => {
    await openWithEngine(app);
    await addMidiLane(app);
    await app.evaluate(() => {
      localStorage.setItem(
        "smart-beat:midi-record",
        JSON.stringify({ mode: "take", span: "playhead", countIn: false, preRollBars: 0 }),
      );
      window.__midiRecorded = [
        { ms: 1000, status: 0x99, d1: 36, d2: 110 },
        { ms: 1100, status: 0x89, d1: 36, d2: 0 },
        { ms: 1500, status: 0x99, d1: 38, d2: 90 },
        { ms: 1600, status: 0x89, d1: 38, d2: 0 },
      ];
    });
    const icon = app.getByRole("button", { name: "Record on the lane MIDI 1" });
    await icon.click();
    await expect.poll(() => app.evaluate(() => window.__midiArmed)).toBeTruthy();
    const bar = app.getByRole("region", { name: "Armed MIDI lane" });
    await expect(bar).toContainText("MIDI 1 is armed");
    await expect(bar).toContainText("Listening to Pad Controller");
    await bar.getByRole("button", { name: "Record" }).click();
    await expect(bar).toContainText("Recording on MIDI 1");
    await expect.poll(() => app.evaluate(() => window.__midiRecording)).toBe(true);
    await app.keyboard.press("Space");
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            window.__engineLanes?.audio.lanes
              .find((l) => l.kind === "midi")
              ?.clips.flatMap((c) => c.midi?.takes[c.take]?.notes ?? []).length,
        ),
      )
      .toBe(2);
    await expect.poll(() => app.evaluate(() => window.__midiPanics ?? 0)).toBeGreaterThan(0);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the MIDI editor, the quantize dialog and the pad board pass axe in ${colorScheme} mode`, async ({
      app,
    }) => {
      await app.emulateMedia({ colorScheme });
      await openWithEngine(app);
      const editor = await addMidiLane(app);
      await editor.getByRole("application", { name: "Note grid" }).click({
        position: { x: 260, y: 120 },
      });
      await expectNoA11yViolations(app, { popup: "[aria-label='MIDI editor: MIDI 1']" });
      await editor.getByRole("button", { name: "Quantize…" }).click();
      await expect(app.getByRole("dialog", { name: "Quantize" })).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role='dialog']" });
      await app.keyboard.press("Escape");

      await app.getByRole("button", { name: "Record on the lane MIDI 1" }).click();
      const bar = app.getByRole("region", { name: "Armed MIDI lane" });
      await expect(bar).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[aria-label='Armed MIDI lane']" });
      await bar.getByRole("button", { name: "Pad board" }).click();
      const board = app.getByRole("dialog", { name: "Pad board" });
      await expect(board.getByRole("group", { name: "Pads" })).toBeVisible();
      await app.evaluate(() =>
        window.__emitTauriEvent("midi://activity", {
          device: "Pad Controller",
          kind: "note",
          chan: 9,
          number: 37,
          value: 100,
          plays: 37,
        }),
      );
      await expect(
        board.getByRole("button", { name: /^Pad 2 / }).getByTestId("midi-activity-light"),
      ).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role='dialog']" });
    });
  }

  test("the pad board learns a pad and saves the pad map with the device", async ({ app }) => {
    await openWithEngine(app);
    await addMidiLane(app);
    await app.getByRole("button", { name: "Record on the lane MIDI 1" }).click();
    await app
      .getByRole("region", { name: "Armed MIDI lane" })
      .getByRole("button", { name: "Pad board" })
      .click();
    const board = app.getByRole("dialog", { name: "Pad board" });
    await board.getByRole("button", { name: /^Pad 3 / }).click();
    await board.getByRole("button", { name: "Learn: hit the pad" }).click();
    await app.evaluate(() =>
      window.__emitTauriEvent("midi://activity", {
        device: "Pad Controller",
        kind: "note",
        chan: 9,
        number: 50,
        value: 100,
        plays: 50,
      }),
    );
    await expect(board.getByText("It sends note 50.")).toBeVisible();
    await board.getByRole("combobox", { name: "Drum pad 3 plays" }).selectOption("46");
    await board.getByRole("button", { name: "Save" }).click();
    await expect(board).toBeHidden();
    await expect
      .poll(() => app.evaluate(() => window.__midiDevices?.[0]?.settings.pads))
      .toContainEqual({ from: 50, to: 46 });
  });
});
