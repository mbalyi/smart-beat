import type { Locator, Page } from "@playwright/test";

import {
  PRACTICE_SONG,
  emitMenuAction,
  expect,
  expectNoA11yViolations,
  openSong,
  test,
  waitForAnimations,
} from "./fixtures";

/**
 * Practice together (#158): several tabs in one session. One live session (one connection, one
 * clock) moves between the tabs of the app: the host adds the shown tab with "Add this tab to the
 * session", switching to an included tab moves the session there, and a guest that already has a
 * tab of the host's shows it instead of receiving another copy. The other player is simulated by
 * the page's Tauri mock (`window.__practiceTogether`), as in practice-together.spec.ts.
 */

const STRUCTURE_SONG = "/Users/me/Music/structure-song.gp";
const ADD = "Add this tab to the session";

const chip = (app: Page) => app.getByTestId("together-chip");
const tabBar = (app: Page) => app.getByRole("navigation", { name: "Open songs" });
const tabButton = (app: Page, name: string) =>
  tabBar(app).getByRole("button", { name, exact: true });
const closeButton = (app: Page, name: string) =>
  app.getByRole("button", { name: `Close ${name}`, exact: true });

/** The fingerprint of a song file as a guest with the same file open would send it. */
async function fingerprintOf(app: Page, path: string): Promise<{ key: string; bars: number }> {
  return app.evaluate(async (file) => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: unknown })
      .__TAURI_INTERNALS__ as {
      invoke: (cmd: string, args: unknown) => Promise<ArrayBuffer>;
    };
    const bytes = new Uint8Array(await internals.invoke("read_score_file", { path: file }));
    const scoreModule = "/src/lib/score/score.ts";
    const printModule = "/src/lib/practice-together/fingerprint.ts";
    const { parseScore } = await import(/* @vite-ignore */ scoreModule);
    const { scoreFingerprint } = await import(/* @vite-ignore */ printModule);
    return scoreFingerprint(parseScore(bytes).score);
  }, path);
}

async function openTogether(app: Page) {
  await emitMenuAction(app, "practice-together");
  const dialog = app.getByRole("dialog", { name: "Practice together" });
  await expect(dialog).toBeVisible();
  await waitForAnimations(app);
  return dialog;
}

async function closeDialog(dialog: Locator) {
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(dialog).toBeHidden();
}

/** Counts of the frames the app sent so far, to tell what was sent after a step. */
const sentCount = (app: Page, type: string) =>
  app.evaluate((t) => window.__practiceTogether.sentOf(t).length, type);

/**
 * The host has tab 1 (the practice song) open, hosts a session and lets a guest in that has the
 * same tab and can take tabs; resolves with the dialog closed and both sides synchronized.
 */
async function hostWithGuestInTabOne(app: Page) {
  await openSong(app);
  const dialog = await openTogether(app);
  await dialog.getByRole("button", { name: "Start a session" }).click();
  await expect(dialog.getByTestId("room-code")).toBeVisible();
  const score = await fingerprintOf(app, PRACTICE_SONG);
  await app.evaluate((s) => {
    window.__practiceTogether.state("open");
    window.__practiceTogether.frame({
      type: "hello",
      name: "Bass laptop",
      role: "guest",
      caps: ["transport", "tab"],
      score: s,
    });
  }, score);
  const card = app.getByRole("alertdialog", { name: "Let this player in?" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Let in" }).click();
  await expect(chip(app)).toHaveAttribute("data-phase", "synchronized", { timeout: 15_000 });
  await closeDialog(dialog);
  return score;
}

/**
 * Plays the part of the guest for the tab offer the host just sent: asks for it to be taken
 * whole (all pieces acknowledged), and says it is done. Resolves with the offer.
 */
async function guestTakesTheOffer(app: Page, previous = 0) {
  await expect.poll(() => sentCount(app, "tab-offer")).toBe(previous + 1);
  const offer = await app.evaluate(
    (n) => window.__practiceTogether.sentOf("tab-offer")[n] as Record<string, unknown>,
    previous,
  );
  await app.evaluate(
    ([id, n]) => {
      window.__practiceTogether.frame({ type: "tab-ack", id, n });
      window.__practiceTogether.frame({ type: "tab-done", id, ok: true });
    },
    [offer.id as number, offer.chunks as number] as const,
  );
  return offer;
}

/** The host says what its tab is, as a guest receives it: this page's own song, in pieces. */
async function sendHostTab(
  app: Page,
  {
    key,
    id,
    path = PRACTICE_SONG,
    name = "Riff",
  }: { key: string; id: number; path?: string; name?: string },
) {
  await app.evaluate(
    async ([file, offerKey, offerId, offerName]) => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: unknown })
        .__TAURI_INTERNALS__ as {
        invoke: (cmd: string, args: unknown) => Promise<ArrayBuffer>;
      };
      const source = new Uint8Array(await internals.invoke("read_score_file", { path: file }));
      const scoreModule = "/src/lib/score/score.ts";
      const writerModule = "/src/lib/export/gp7.ts";
      const formatModule = "/src/lib/score/format.ts";
      const { parseScore } = await import(/* @vite-ignore */ scoreModule);
      const { writeGp7 } = await import(/* @vite-ignore */ writerModule);
      const { fileKey } = await import(/* @vite-ignore */ formatModule);
      const { score } = parseScore(source);
      const bytes: Uint8Array = writeGp7(score);
      const size = 8 * 1024;
      const chunks = Math.ceil(bytes.length / size);
      const frame = window.__practiceTogether.frame;
      frame({
        type: "tab-offer",
        id: offerId,
        name: offerName,
        size: bytes.length,
        chunks,
        sha: await fileKey(bytes),
        key: offerKey,
        bars: score.masterBars.length,
      });
      for (let i = 0; i < chunks; i += 1) {
        let text = "";
        for (const byte of bytes.subarray(i * size, (i + 1) * size))
          text += String.fromCharCode(byte);
        frame({ type: "tab-chunk", id: offerId, i, data: btoa(text) });
      }
    },
    [path, key, id, name] as const,
  );
}

/** The app joins a host as a guest; resolves once it has said hello and is welcomed. */
async function joinAsGuest(app: Page, dialog: Locator) {
  await dialog.getByRole("radio", { name: "Join an existing session" }).click();
  await dialog.getByLabel("Room code").fill("ABCD-EFGH-JKMN-PQRS-TVWX");
  await dialog.getByRole("button", { name: "Join the session" }).click();
  await expect.poll(() => sentCount(app, "hello")).toBe(1);
  await app.evaluate(() =>
    window.__practiceTogether.frame({ type: "welcome", session: "s1", version: 1, name: "Host" }),
  );
}

/** Answers the guest's latest hello with a welcome, as the host does for a guest that is back. */
async function welcomeAgain(app: Page, previous: number) {
  await expect.poll(() => sentCount(app, "hello")).toBeGreaterThan(previous);
  await app.evaluate(() =>
    window.__practiceTogether.frame({ type: "welcome", session: "s1", version: 1, name: "Host" }),
  );
}

test.describe("Practice together: several tabs in one session (host)", () => {
  test("offers to add the shown tab to the running session, and the guest gets it without leaving", async ({
    app,
  }) => {
    await hostWithGuestInTabOne(app);
    expect(await sentCount(app, "bye")).toBe(0);

    // A second tab: the session keeps running in the first one.
    await openSong(app, STRUCTURE_SONG);
    await expect(tabButton(app, "Structure Song")).toHaveAttribute("aria-current", "true");
    const dialog = await openTogether(app);
    const add = dialog.getByRole("button", { name: ADD });
    await expect(add).toBeVisible();

    // The host adds it: the guest is sent that tab, over the same connection.
    await add.click();
    const offer = await guestTakesTheOffer(app);
    expect(offer).toMatchObject({ name: "structure-song.gp" });
    await expect(chip(app)).toHaveAttribute("data-phase", "synchronized", { timeout: 15_000 });

    // Nobody left, nobody rejoined, and there is still only one room.
    expect(await sentCount(app, "bye")).toBe(0);
    await closeDialog(dialog);
    await expect(chip(app)).toHaveAccessibleName(/synchronized with Bass laptop/);
    await expect(tabBar(app).getByRole("listitem")).toHaveCount(2);
  });

  test("moves the session back with the tab, and the guest that has that tab is not sent it again", async ({
    app,
  }) => {
    await hostWithGuestInTabOne(app);
    await openSong(app, STRUCTURE_SONG);
    const dialog = await openTogether(app);
    await dialog.getByRole("button", { name: ADD }).click();
    await guestTakesTheOffer(app);
    await expect(chip(app)).toHaveAttribute("data-phase", "synchronized", { timeout: 15_000 });
    await closeDialog(dialog);
    const chunksSent = await sentCount(app, "tab-chunk");
    const offersSent = await sentCount(app, "tab-offer");

    // Back to the first tab: the session goes with it (the chip shows it), with no new copy.
    await tabButton(app, "Practice Song").click();
    await expect(tabButton(app, "Practice Song")).toHaveAttribute("aria-current", "true");
    await expect(chip(app)).toBeVisible();
    await expect(chip(app)).toHaveAttribute("data-phase", "synchronized", { timeout: 15_000 });
    // If the host asks again, the guest says it has it ("have"): the pieces are never sent twice.
    if ((await sentCount(app, "tab-offer")) > offersSent) {
      const again = await app.evaluate(
        (n) => window.__practiceTogether.sentOf("tab-offer")[n] as Record<string, unknown>,
        offersSent,
      );
      await app.evaluate(
        (id) => window.__practiceTogether.frame({ type: "tab-done", id, ok: true, reason: "have" }),
        again.id as number,
      );
    }
    expect(await sentCount(app, "tab-chunk")).toBe(chunksSent);
    expect(await sentCount(app, "bye")).toBe(0);
  });

  test("only one tab plays: switching tabs while it plays stops it for everyone", async ({
    app,
  }) => {
    await hostWithGuestInTabOne(app);
    await openSong(app, STRUCTURE_SONG);
    const dialog = await openTogether(app);
    await dialog.getByRole("button", { name: ADD }).click();
    await guestTakesTheOffer(app);
    await expect(chip(app)).toHaveAttribute("data-phase", "synchronized", { timeout: 15_000 });
    await closeDialog(dialog);

    // Play in this tab: both start together.
    await app.getByRole("button", { name: "Play" }).click();
    await expect.poll(() => sentCount(app, "cmd")).toBeGreaterThan(0);
    const before = await sentCount(app, "cmd");

    // Another tab: the shared playback ends (a command to everyone), and nothing plays here.
    await tabButton(app, "Practice Song").click();
    await expect(tabButton(app, "Practice Song")).toHaveAttribute("aria-current", "true");
    await expect.poll(() => sentCount(app, "cmd")).toBeGreaterThan(before);
    const last = await app.evaluate(() => {
      const cmds = window.__practiceTogether.sentOf("cmd") as unknown as {
        cmd: { action: string };
      }[];
      return cmds[cmds.length - 1]!.cmd.action;
    });
    expect(["pause", "stop"]).toContain(last);
    await expect(app.getByRole("button", { name: "Play" })).toBeVisible();
    await expect(app.getByRole("button", { name: "Pause" })).toHaveCount(0);
  });

  test("Leave ends the session for every tab", async ({ app }) => {
    await hostWithGuestInTabOne(app);
    await openSong(app, STRUCTURE_SONG);
    const dialog = await openTogether(app);
    await dialog.getByRole("button", { name: ADD }).click();
    await guestTakesTheOffer(app);
    await expect(chip(app)).toHaveAttribute("data-phase", "synchronized", { timeout: 15_000 });

    await dialog.getByRole("button", { name: "Leave session" }).click();
    await expect.poll(() => sentCount(app, "bye")).toBe(1);
    // The dialog is behind the tab bar's modal layer until it is closed.
    await closeDialog(dialog);
    await expect(chip(app)).toHaveCount(0);
    // The first tab is not in a session any more either.
    await tabButton(app, "Practice Song").click();
    await expect(tabButton(app, "Practice Song")).toHaveAttribute("aria-current", "true");
    await expect(chip(app)).toHaveCount(0);
    const reopened = await openTogether(app);
    await expect(reopened.getByRole("button", { name: "Start a session" })).toBeVisible();
    await expect(reopened.getByRole("button", { name: ADD })).toHaveCount(0);
  });

  test("offers nothing to add when no session is running", async ({ app }) => {
    await openSong(app);
    await openSong(app, STRUCTURE_SONG);
    const dialog = await openTogether(app);
    await expect(dialog.getByRole("button", { name: "Start a session" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: ADD })).toHaveCount(0);
  });
});

test.describe("Practice together: several tabs in one session (guest)", () => {
  test("a second tab from the host opens next to the first, and the session goes with it", async ({
    app,
  }) => {
    await openSong(app);
    const dialog = await openTogether(app);
    await joinAsGuest(app, dialog);

    // The host's first tab, then its second: two received tabs besides the guest's own.
    await sendHostTab(app, { key: "host-tab-one", id: 7 });
    await expect
      .poll(() => app.evaluate(() => window.__practiceTogether.sentOf("tab-done")))
      .toEqual([{ type: "tab-done", id: 7, ok: true }]);
    await welcomeAgain(app, 1);
    await expect(chip(app)).toHaveAttribute("data-phase", "synchronized", { timeout: 15_000 });

    await sendHostTab(app, { key: "host-tab-two", id: 8, path: STRUCTURE_SONG, name: "Structure" });
    await expect
      .poll(() => app.evaluate(() => window.__practiceTogether.sentOf("tab-done").length))
      .toBe(2);
    await welcomeAgain(app, 2);
    await expect(chip(app)).toHaveAttribute("data-phase", "synchronized", { timeout: 15_000 });

    // The older received tab stays (the session left it, it is not closed under the guest).
    await expect(closeButton(app, "Practice Song")).toBeVisible();
    await expect(closeButton(app, "Practice Song (from Host)")).toBeVisible();
    await expect(closeButton(app, "Structure Song (from Host)")).toBeVisible();
    await expect(tabButton(app, "Structure Song (from Host)")).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(await sentCount(app, "bye")).toBe(0);
  });

  test("a tab the guest already has is shown, not received again", async ({ app }) => {
    await openSong(app);
    const dialog = await openTogether(app);
    await joinAsGuest(app, dialog);
    await sendHostTab(app, { key: "host-tab-one", id: 7 });
    await expect.poll(() => sentCount(app, "tab-done")).toBe(1);
    await welcomeAgain(app, 1);
    await sendHostTab(app, { key: "host-tab-two", id: 8, path: STRUCTURE_SONG, name: "Structure" });
    await expect.poll(() => sentCount(app, "tab-done")).toBe(2);
    await welcomeAgain(app, 2);
    await expect(tabButton(app, "Structure Song (from Host)")).toHaveAttribute(
      "aria-current",
      "true",
    );
    const hellos = await sentCount(app, "hello");

    // The host goes back to its first tab and offers it again: the guest has it already.
    await app.evaluate(() =>
      window.__practiceTogether.frame({
        type: "tab-offer",
        id: 9,
        name: "Riff",
        size: 10,
        chunks: 1,
        sha: "0".repeat(64),
        key: "host-tab-one",
        bars: 4,
      }),
    );
    await expect
      .poll(() => app.evaluate(() => window.__practiceTogether.sentOf("tab-done").slice(2)))
      .toEqual([{ type: "tab-done", id: 9, ok: true, reason: "have" }]);
    // No third copy; the first received tab is the one shown, and the session is in it.
    await expect(tabBar(app).getByRole("listitem")).toHaveCount(3);
    await expect(tabButton(app, "Practice Song (from Host)")).toHaveAttribute(
      "aria-current",
      "true",
    );
    await welcomeAgain(app, hellos);
    await expect(chip(app)).toHaveAttribute("data-phase", "synchronized", { timeout: 15_000 });
  });
});

test.describe("Practice together: Sync tab", () => {
  test("sends the tab again with progress, and waits while it is on its way", async ({ app }) => {
    await hostWithGuestInTabOne(app);
    expect(await sentCount(app, "tab-offer")).toBe(0);
    const dialog = await openTogether(app);
    const sync = dialog.getByRole("button", { name: "Sync tab" });
    await expect(sync).toBeEnabled();

    await sync.click();
    // The tab goes out again, whatever the guest said it has, in pieces, with a progress bar.
    await expect.poll(() => sentCount(app, "tab-offer")).toBe(1);
    await expect(dialog.getByTestId("tab-transfer")).toBeVisible();
    await expect(sync).toBeDisabled();

    // The guest takes it: the progress ends and the button comes back.
    const offer = await app.evaluate(
      () => window.__practiceTogether.sentOf("tab-offer")[0] as Record<string, unknown>,
    );
    await app.evaluate(
      ([id, n]) => {
        window.__practiceTogether.frame({ type: "tab-ack", id, n });
        window.__practiceTogether.frame({ type: "tab-done", id, ok: true });
      },
      [offer.id as number, offer.chunks as number] as const,
    );
    await expect(sync).toBeEnabled();
    await expect(chip(app)).toHaveAttribute("data-phase", "synchronized", { timeout: 15_000 });
  });
});

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`Practice together: several tabs, ${colorScheme} mode`, () => {
    test(`the dialog with "${ADD}" has no WCAG violations`, async ({ app }) => {
      test.slow();
      await app.emulateMedia({ colorScheme });
      await hostWithGuestInTabOne(app);
      await openSong(app, STRUCTURE_SONG);
      const dialog = await openTogether(app);
      await expect(dialog.getByRole("button", { name: ADD })).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });

      // After adding: the Play together step of the new tab.
      await dialog.getByRole("button", { name: ADD }).click();
      await guestTakesTheOffer(app);
      await expect(dialog.getByTestId("peer-other")).toContainText("Bass laptop", {
        timeout: 15_000,
      });
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
    });

    test("the Play together step with Sync tab has no WCAG violations", async ({ app }) => {
      test.slow();
      await app.emulateMedia({ colorScheme });
      await hostWithGuestInTabOne(app);
      const dialog = await openTogether(app);
      await expect(dialog.getByRole("button", { name: "Sync tab" })).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
      await dialog.getByRole("button", { name: "Sync tab" }).click();
      await expect(dialog.getByTestId("tab-transfer")).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
    });
  });
}
