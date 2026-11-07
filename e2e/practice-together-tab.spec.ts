import type { Page } from "@playwright/test";

import {
  PRACTICE_SONG,
  emitMenuAction,
  expect,
  openSong,
  test,
  waitForAnimations,
} from "./fixtures";

/**
 * Practice together (#158): sharing the host's tab. The other player is simulated by the page's
 * Tauri mock (`window.__practiceTogether`), as in practice-together.spec.ts.
 */

async function openDialog(app: Page) {
  await openSong(app);
  await emitMenuAction(app, "practice-together");
  const dialog = app.getByRole("dialog", { name: "Practice together" });
  await expect(dialog).toBeVisible();
  await waitForAnimations(app);
  return dialog;
}

const chip = (app: Page) => app.getByTestId("together-chip");

test.describe("Practice together: sharing the tab", () => {
  test("a host offers its tab to a guest that does not have it, in pieces", async ({ app }) => {
    const dialog = await openDialog(app);
    await dialog.getByRole("button", { name: "Start a session" }).click();
    await expect(dialog.getByTestId("room-code")).toBeVisible();
    // A guest with another tab, that can take one (an older Smart Beat would be turned away).
    await app.evaluate(() => {
      window.__practiceTogether.state("open");
      window.__practiceTogether.frame({
        type: "hello",
        name: "Bass laptop",
        role: "guest",
        caps: ["transport", "tab"],
        score: { key: "the-guests-own-tab", bars: 3 },
      });
    });
    const card = app.getByRole("alertdialog", { name: "Let this player in?" });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Let in" }).click();

    // No refusal: the host answers with an offer of the open tab.
    await expect
      .poll(() => app.evaluate(() => window.__practiceTogether.sentOf("tab-offer").length))
      .toBe(1);
    expect(await app.evaluate(() => window.__practiceTogether.sentOf("refuse"))).toEqual([]);
    const offer = await app.evaluate(
      () => window.__practiceTogether.sentOf("tab-offer")[0] as Record<string, unknown>,
    );
    expect(offer).toMatchObject({ name: "practice-song.gp" });
    expect(offer.size as number).toBeGreaterThan(100);
    const chunks = offer.chunks as number;
    expect(chunks).toBeGreaterThanOrEqual(1);

    // The pieces follow, a window at a time; the guest's answers let the rest go.
    await expect
      .poll(() => app.evaluate(() => window.__practiceTogether.sentOf("tab-chunk").length))
      .toBe(Math.min(chunks, 12));
    await app.evaluate(([id, n]) => window.__practiceTogether.frame({ type: "tab-ack", id, n }), [
      offer.id as number,
      chunks,
    ] as const);
    await expect
      .poll(() => app.evaluate(() => window.__practiceTogether.sentOf("tab-chunk").length))
      .toBe(chunks);

    // The guest has opened it: nothing stands in the way of starting together.
    await app.evaluate(
      (id) => window.__practiceTogether.frame({ type: "tab-done", id, ok: true }),
      offer.id as number,
    );
    await expect(chip(app)).toHaveAttribute("data-phase", "synchronized", { timeout: 15_000 });
    await expect(dialog.getByRole("alert")).toHaveCount(0);
  });

  test("a guest receives the host's tab, opens it as a tab of its own and stays in the session", async ({
    app,
  }) => {
    const dialog = await openDialog(app);
    await dialog.getByRole("radio", { name: "Join an existing session" }).click();
    await dialog.getByLabel("Room code").fill("ABCD-EFGH-JKMN-PQRS-TVWX");
    await dialog.getByRole("button", { name: "Join the session" }).click();
    await expect
      .poll(() => app.evaluate(() => window.__practiceTogether.sentOf("hello").length))
      .toBe(1);
    await app.evaluate(() =>
      window.__practiceTogether.frame({ type: "welcome", session: "s1", version: 1, name: "Host" }),
    );

    // The host's tab: this page's own song written as a Guitar Pro file, sent in pieces.
    await app.evaluate(async (path) => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: unknown })
        .__TAURI_INTERNALS__ as {
        invoke: (cmd: string, args: unknown) => Promise<ArrayBuffer>;
      };
      const source = new Uint8Array(await internals.invoke("read_score_file", { path }));
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
        id: 7,
        name: "Riff",
        size: bytes.length,
        chunks,
        sha: await fileKey(bytes),
        key: "the-hosts-version",
        bars: score.masterBars.length,
      });
      for (let i = 0; i < chunks; i += 1) {
        let text = "";
        for (const byte of bytes.subarray(i * size, (i + 1) * size))
          text += String.fromCharCode(byte);
        frame({ type: "tab-chunk", id: 7, i, data: btoa(text) });
      }
    }, PRACTICE_SONG);

    // The answer goes back, and the host's tab opens next to the guest's own.
    await expect
      .poll(() => app.evaluate(() => window.__practiceTogether.sentOf("tab-done")))
      .toEqual([{ type: "tab-done", id: 7, ok: true }]);
    // The tab bar is behind the dialog until it is closed.
    await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(
      app.getByRole("button", { name: "Close Practice Song (from Host)" }),
    ).toBeVisible();
    await expect(
      app.getByRole("button", { name: "Close Practice Song", exact: true }),
    ).toBeVisible();

    // The new tab carries the session on: it says hello again as the same guest, and is let back in.
    await expect
      .poll(() => app.evaluate(() => window.__practiceTogether.sentOf("hello").length))
      .toBe(2);
    const hello = await app.evaluate(
      () => window.__practiceTogether.sentOf("hello")[1] as Record<string, unknown>,
    );
    expect(hello).toMatchObject({ resume: true, session: "s1" });
    expect((hello.score as { key: string }).key).toBe("the-hosts-version");
    await app.evaluate(() =>
      window.__practiceTogether.frame({ type: "welcome", session: "s1", version: 1, name: "Host" }),
    );
    await expect(chip(app)).toHaveAttribute("data-phase", "synchronized", { timeout: 15_000 });
  });

  test("a guest is told when the tab arrives damaged", async ({ app }) => {
    const dialog = await openDialog(app);
    await dialog.getByRole("radio", { name: "Join an existing session" }).click();
    await dialog.getByLabel("Room code").fill("ABCD-EFGH-JKMN-PQRS-TVWX");
    await dialog.getByRole("button", { name: "Join the session" }).click();
    await expect
      .poll(() => app.evaluate(() => window.__practiceTogether.sentOf("hello").length))
      .toBe(1);
    await app.evaluate(() => {
      window.__practiceTogether.frame({ type: "welcome", session: "s1", version: 1, name: "Host" });
      window.__practiceTogether.frame({
        type: "tab-offer",
        id: 9,
        name: "Riff",
        size: 4,
        chunks: 1,
        sha: "0".repeat(64),
        key: "the-hosts-version",
        bars: 1,
      });
      window.__practiceTogether.frame({ type: "tab-chunk", id: 9, i: 0, data: btoa("abcd") });
    });

    await expect
      .poll(() => app.evaluate(() => window.__practiceTogether.sentOf("tab-abort")))
      .toEqual([{ type: "tab-abort", id: 9, reason: "checksum" }]);
    await expect(app.getByText("The tab arrived damaged", { exact: false }).first()).toBeVisible();
    // Nothing was opened.
    await expect(app.getByRole("button", { name: "Close Practice Song (from Host)" })).toHaveCount(
      0,
    );
  });
});
