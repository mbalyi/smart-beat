import type { Locator, Page } from "@playwright/test";

import {
  PRACTICE_SONG,
  emitMenuAction,
  expect,
  expectNoA11yViolations,
  openSong,
  scoreRegion,
  tabNumbers,
  test,
  waitForAnimations,
} from "./fixtures";

/**
 * Practice together (#216): editing the tab together. The other player is simulated by the page's
 * Tauri mock (`window.__practiceTogether`), as in practice-together.spec.ts: it sends the frames a
 * guest would send, and what the host sent back is read from `sentOf`.
 */

const GUEST = "ann0000000000000";

async function fingerprint(app: Page): Promise<{ key: string; bars: number }> {
  return app.evaluate(async (path) => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: unknown })
      .__TAURI_INTERNALS__ as {
      invoke: (cmd: string, args: unknown) => Promise<ArrayBuffer>;
    };
    const bytes = new Uint8Array(await internals.invoke("read_score_file", { path }));
    const scoreModule = "/src/lib/score/score.ts";
    const printModule = "/src/lib/practice-together/fingerprint.ts";
    const { parseScore } = await import(/* @vite-ignore */ scoreModule);
    const { scoreFingerprint } = await import(/* @vite-ignore */ printModule);
    return scoreFingerprint(parseScore(bytes).score);
  }, PRACTICE_SONG);
}

async function openDialog(app: Page) {
  await openSong(app);
  await emitMenuAction(app, "practice-together");
  const dialog = app.getByRole("dialog", { name: "Practice together" });
  await expect(dialog).toBeVisible();
  await waitForAnimations(app);
  return dialog;
}

type Edit = { k: string; [key: string]: unknown };

/** The `edit` messages the host sent, decoded. */
const edits = (app: Page): Promise<Edit[]> =>
  app.evaluate(
    () => window.__practiceTogether.sentOf("edit").map((m) => m.body) as unknown as Edit[],
  );

/** A frame from the guest: an edit message. */
const guestSays = (app: Page, body: Edit) =>
  app.evaluate((b) => window.__practiceTogether.frame({ type: "edit", body: b }), body);

/** A guest's operation: a note written on the first beat of the first bar. */
const noteOp = (fret: number): Edit => ({
  k: "ops",
  ops: [
    {
      t: "ins",
      k: "note",
      p: "m0:t0.s0.v0.b0",
      a: null,
      d: { u: `${GUEST}-${fret}`, k: "note", p: { string: 1, fret } },
    },
  ],
});

/** Hosts a session, lets the simulated guest in, and brings it up to date: it edits along. */
async function hostWithEditingGuest(app: Page): Promise<{ dialog: Locator }> {
  const dialog = await openDialog(app);
  await dialog.getByRole("button", { name: "Start a session" }).click();
  await expect(dialog.getByTestId("room-code")).toBeVisible();
  const score = await fingerprint(app);
  await app.evaluate(
    ([s, guest]) => {
      window.__practiceTogether.state("open");
      window.__practiceTogether.frame({
        type: "hello",
        name: "Ann",
        role: "guest",
        caps: ["transport", "tab", "edit"],
        score: s,
        guest,
      });
    },
    [score, GUEST] as const,
  );
  const card = app.getByRole("alertdialog", { name: "Let this player in?" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Let in" }).click();
  // The host tells the guest it may edit; the guest says what it has; the host brings it up to date.
  await expect.poll(async () => (await edits(app)).some((e) => e.k === "rights")).toBe(true);
  await guestSays(app, { k: "since", seq: -1, key: score.key });
  await expect.poll(async () => (await edits(app)).some((e) => e.k === "live")).toBe(true);
  return { dialog };
}

const closeDialog = (app: Page) =>
  app.getByRole("button", { name: "Close", exact: true }).last().click();

test.describe("Practice together: editing the tab together", () => {
  test("a guest's edit shows on the host and goes back out, in the host's order", async ({
    app,
  }) => {
    await hostWithEditingGuest(app);
    await closeDialog(app);
    expect(await tabNumbers(app)).not.toContain("12");

    await guestSays(app, noteOp(12));
    await expect.poll(() => tabNumbers(app), { timeout: 10_000 }).toContain("12");

    // The host numbered it and sent it back to the guest, who sees it was its own (`from`).
    const echoed = (await edits(app)).filter((e) => e.k === "ops");
    expect(echoed).toHaveLength(1);
    expect(echoed[0]).toMatchObject({ from: GUEST, seq: 1 });
  });

  test("the host's own edit is sent to the guest as operations, not as a new tab", async ({
    app,
  }) => {
    await hostWithEditingGuest(app);
    await closeDialog(app);
    await emitMenuAction(app, "toggle-edit-mode");
    await expect(scoreRegion(app)).toBeFocused();
    await app.keyboard.press("Delete");
    await expect.poll(async () => (await edits(app)).filter((e) => e.k === "ops").length).toBe(1);
    const ops = (await edits(app)).find((e) => e.k === "ops")!;
    expect(ops).toMatchObject({ from: "host", seq: 1 });
    // Editing does not send the tab again.
    await app.waitForTimeout(1500);
    expect(await app.evaluate(() => window.__practiceTogether.sentOf("tab-offer").length)).toBe(0);
  });

  test("an edit during playback does not restart the song or send another start", async ({
    app,
  }) => {
    await hostWithEditingGuest(app);
    await closeDialog(app);
    await expect(app.getByTestId("together-chip")).toHaveAttribute("data-phase", "synchronized", {
      timeout: 15_000,
    });
    await app.getByRole("button", { name: "Play" }).click();
    await expect
      .poll(() => app.evaluate(() => window.__practiceTogether.sentOf("cmd").length))
      .toBe(1);
    await expect(app.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 15_000 });

    await guestSays(app, noteOp(12));
    await expect.poll(() => tabNumbers(app), { timeout: 10_000 }).toContain("12");

    // Still playing, with the one start it had: the edit was not a command.
    await expect(app.getByRole("button", { name: "Pause" })).toBeVisible();
    expect(await app.evaluate(() => window.__practiceTogether.sentOf("cmd").length)).toBe(1);
    expect(await app.evaluate(() => window.__practiceTogether.sentOf("tab-offer").length)).toBe(0);
  });

  test("a guest's cursor is drawn on the tab with its name", async ({ app }) => {
    await hostWithEditingGuest(app);
    await closeDialog(app);
    await guestSays(app, { k: "presence", cur: { track: "t0", beat: "m0:t0.s0.v0.b1" } });
    const cursor = app.getByTestId("remote-cursor");
    await expect(cursor).toHaveCount(1);
    await expect(cursor).toHaveAttribute("data-player", "Ann");
    await expect(cursor).toContainText("Ann");
  });

  test("turning editing off for guests ignores their edits, and the switch tells the guest", async ({
    app,
  }) => {
    const { dialog } = await hostWithEditingGuest(app);
    const toggle = dialog.getByRole("switch", { name: "Guests can edit the tab" });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect
      .poll(async () => (await edits(app)).filter((e) => e.k === "rights").at(-1))
      .toMatchObject({ canEdit: false });

    await closeDialog(app);
    await guestSays(app, noteOp(11));
    await app.waitForTimeout(500);
    expect(await tabNumbers(app)).not.toContain("11");
    expect((await edits(app)).filter((e) => e.k === "ops")).toHaveLength(0);
  });

  test("a guest that is removed has no edit access any more", async ({ app }) => {
    const { dialog } = await hostWithEditingGuest(app);
    await dialog.getByRole("button", { name: "Kick Ann" }).click();
    await dialog
      .getByRole("alertdialog", { name: "Kick Ann?" })
      .getByRole("button", { name: "Kick Ann" })
      .click();
    await expect.poll(() => app.evaluate(() => window.__practiceTogether.kicked.length)).toBe(1);
    await closeDialog(app);
    await guestSays(app, noteOp(10));
    await app.waitForTimeout(500);
    expect(await tabNumbers(app)).not.toContain("10");
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the session dialog with the editing switch has no WCAG violations in ${colorScheme} mode`, async ({
      app,
    }) => {
      await app.emulateMedia({ colorScheme });
      const { dialog } = await hostWithEditingGuest(app);
      await expect(dialog.getByRole("switch", { name: "Guests can edit the tab" })).toBeVisible();
      await expectNoA11yViolations(app);
    });

    test(`a remote cursor on the tab has no WCAG violations in ${colorScheme} mode`, async ({
      app,
    }) => {
      await app.emulateMedia({ colorScheme });
      await hostWithEditingGuest(app);
      await closeDialog(app);
      await guestSays(app, { k: "presence", cur: { track: "t0", beat: "m0:t0.s0.v0.b1" } });
      await expect(app.getByTestId("remote-cursor")).toHaveCount(1);
      await expectNoA11yViolations(app);
    });
  }
});
