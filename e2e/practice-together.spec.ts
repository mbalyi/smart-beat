import type { Page } from "@playwright/test";

import {
  PRACTICE_SONG,
  emitMenuAction,
  expect,
  expectNoA11yViolations,
  openSong,
  test,
  waitForAnimations,
} from "./fixtures";

/** The score as the host has it open: what a guest with the same file sends in its hello. */
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

/** Hosts a session and lets the simulated guest in; resolves once both sides are in sync. */
async function hostWithGuest(app: Page) {
  const dialog = await openDialog(app);
  await dialog.getByRole("button", { name: "Start a session" }).click();
  await expect(dialog.getByTestId("room-code")).toHaveText("ABCD-EFGH-JKMN-PQRS-TVWX");
  const score = await fingerprint(app);
  await app.evaluate((s) => {
    window.__practiceTogether.state("open");
    window.__practiceTogether.frame({
      type: "hello",
      name: "Bass laptop",
      role: "guest",
      caps: ["transport"],
      score: s,
    });
  }, score);
  return { dialog, score };
}

async function letIn(app: Page) {
  const card = app.getByRole("alertdialog", { name: "Let this player in?" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Let in" }).click();
}

const chip = (app: Page) => app.getByTestId("together-chip");

test.describe("Practice together", () => {
  test("opens from the menu with the host choice ready, and the internet is not in this build", async ({
    app,
  }) => {
    const dialog = await openDialog(app);
    await expect(dialog.getByRole("button", { name: "Start a session" })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Over the internet" })).toBeDisabled();
    await expect(dialog.getByRole("radio", { name: "Same network" })).toBeChecked();
  });

  test("hosts a session: shows the code, asks before letting the guest in, then syncs", async ({
    app,
  }) => {
    const { dialog } = await hostWithGuest(app);
    await expect(
      dialog.getByText("Listening on 192.168.1.5:50123", { exact: false }),
    ).toBeVisible();
    await letIn(app);
    await expect
      .poll(() => app.evaluate(() => window.__practiceTogether.sentOf("welcome").length))
      .toBe(1);

    await expect(dialog.getByTestId("peer-other")).toContainText("Bass laptop", {
      timeout: 15_000,
    });
    await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(chip(app)).toHaveAccessibleName(/synchronized with Bass laptop/);
  });

  test("the host's Play becomes a scheduled command for both", async ({ app }) => {
    await hostWithGuest(app);
    await letIn(app);
    await expect(chip(app)).toHaveAttribute("data-phase", "synchronized", { timeout: 15_000 });
    await app.getByRole("button", { name: "Close", exact: true }).last().click();

    await app.getByRole("button", { name: "Play" }).click();
    await expect
      .poll(() => app.evaluate(() => window.__practiceTogether.sentOf("cmd").length))
      .toBe(1);
    const cmd = await app.evaluate(
      () =>
        window.__practiceTogether.sentOf("cmd")[0]!.cmd as {
          action: string;
          at: number;
          speed: number;
        },
    );
    expect(cmd.action).toBe("play");
    expect(cmd.speed).toBe(100);
    // The start is a moment ahead on the session clock, not "now".
    expect(cmd.at).toBeGreaterThan((await app.evaluate(() => performance.now())) - 5);
    // It really starts: the button turns into Pause.
    await expect(app.getByRole("button", { name: "Pause" })).toBeVisible();
  });

  test("calls the start off for both when the guest is not ready in time", async ({ app }) => {
    await hostWithGuest(app);
    await letIn(app);
    await expect(chip(app)).toHaveAttribute("data-phase", "synchronized", { timeout: 15_000 });
    await app.getByRole("button", { name: "Close", exact: true }).last().click();

    await app.evaluate(() => {
      // The guest keeps answering pings but never says ready.
      const original = window.__practiceTogether.frame;
      window.__practiceTogether.frame = (msg) => (msg.type === "ready" ? 0 : original(msg));
    });
    await app.getByRole("button", { name: "Play" }).click();
    await expect
      .poll(() => app.evaluate(() => window.__practiceTogether.sentOf("abort").length), {
        timeout: 10_000,
      })
      .toBe(1);
    await expect(app.getByRole("button", { name: "Play" })).toBeVisible();
    await expect(
      app.getByText("The other computer was not ready in time", { exact: false }),
    ).toBeVisible();
  });

  test("turns away a guest with a different version of the score", async ({ app }) => {
    const dialog = await openDialog(app);
    await dialog.getByRole("button", { name: "Start a session" }).click();
    await expect(dialog.getByTestId("room-code")).toBeVisible();
    await app.evaluate(() => {
      window.__practiceTogether.state("open");
      window.__practiceTogether.frame({
        type: "hello",
        name: "Other",
        role: "guest",
        caps: [],
        score: { key: "not-the-same-score", bars: 3 },
      });
    });
    await expect
      .poll(() => app.evaluate(() => window.__practiceTogether.sentOf("refuse")))
      .toEqual([{ type: "refuse", reason: "score" }]);
    await expect(app.getByRole("alertdialog")).toHaveCount(0);
  });

  test("a guest joins with a typed code and is told when the host declines", async ({ app }) => {
    const dialog = await openDialog(app);
    await dialog.getByRole("radio", { name: "Join with a code" }).click();
    const join = dialog.getByRole("button", { name: "Join the session" });
    await expect(join).toBeDisabled();
    await dialog.getByLabel("Room code").fill("abcd-efgh-jkmn-pqrs-tvwx");
    await join.click();

    await expect
      .poll(() =>
        app.evaluate(() =>
          window.__ipcCalls.filter((c) => c.cmd === "practice_join").map((c) => c.args),
        ),
      )
      .toEqual([{ code: "abcd-efgh-jkmn-pqrs-tvwx" }]);
    // The guest says hello at once; the host says no.
    await expect
      .poll(() => app.evaluate(() => window.__practiceTogether.sentOf("hello").length))
      .toBe(1);
    await app.evaluate(() =>
      window.__practiceTogether.frame({ type: "refuse", reason: "declined" }),
    );
    await expect(dialog.getByRole("alert")).toContainText("The host did not let you in.");
    await expect(dialog.getByRole("button", { name: "Start a session" })).toBeVisible();
  });

  test("a guest cannot use the host's transport buttons", async ({ app }) => {
    const dialog = await openDialog(app);
    await dialog.getByRole("radio", { name: "Join with a code" }).click();
    await dialog.getByLabel("Room code").fill("ABCD-EFGH-JKMN-PQRS-TVWX");
    await dialog.getByRole("button", { name: "Join the session" }).click();
    await expect
      .poll(() => app.evaluate(() => window.__practiceTogether.sentOf("hello").length))
      .toBe(1);
    await app.evaluate(() =>
      window.__practiceTogether.frame({
        type: "welcome",
        session: "s1",
        version: 1,
        name: "Host",
      }),
    );
    await expect(dialog.getByText("Connected to Host", { exact: false })).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(app.getByRole("button", { name: "Play" })).toBeDisabled();
    await expect(app.getByRole("button", { name: "Stop" })).toBeDisabled();
  });

  test("shows that the connection dropped and leaves cleanly", async ({ app }) => {
    await hostWithGuest(app);
    await letIn(app);
    await expect(chip(app)).toHaveAttribute("data-phase", "synchronized", { timeout: 15_000 });
    await app.evaluate(() =>
      window.__practiceTogether.state("reconnecting", "the guest disconnected"),
    );
    await expect(chip(app)).toHaveAttribute("data-phase", "reconnecting");
    await expect(app.getByRole("dialog").getByRole("alert")).toContainText(
      "The connection dropped",
    );

    await app.getByRole("button", { name: "Leave session" }).click();
    await expect(chip(app)).toHaveCount(0);
    expect(
      await app.evaluate(() => window.__ipcCalls.filter((c) => c.cmd === "practice_leave").length),
    ).toBeGreaterThan(0);
  });

  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 375, height: 812 },
  ]) {
    for (const colorScheme of ["light", "dark"] as const) {
      test(`has no WCAG violations at ${viewport.width} px in ${colorScheme} mode`, async ({
        app,
      }) => {
        test.slow();
        await app.setViewportSize(viewport);
        await app.emulateMedia({ colorScheme });
        const dialog = await openDialog(app);
        const fits = async () =>
          expect(await dialog.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(
            0,
          );

        // 1. Choose
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });
        await fits();
        await dialog.getByRole("radio", { name: "Join with a code" }).click();
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });
        await dialog.getByRole("radio", { name: "Host a session" }).click();

        // 2. Connect: the code, then the host's question
        await dialog.getByRole("button", { name: "Start a session" }).click();
        await expect(dialog.getByTestId("room-code")).toBeVisible();
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });
        await fits();
        const score = await fingerprint(app);
        await app.evaluate((s) => {
          window.__practiceTogether.state("open");
          window.__practiceTogether.frame({
            type: "hello",
            name: "Bass laptop",
            role: "guest",
            caps: [],
            score: s,
          });
        }, score);
        await expect(app.getByRole("alertdialog")).toBeVisible();
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });
        await letIn(app);

        // 3. Play together
        await expect(dialog.getByTestId("peer-other")).toContainText("Bass laptop", {
          timeout: 15_000,
        });
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });
        await fits();

        // The toolbar chip, on the whole page.
        await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
        await expect(chip(app)).toBeVisible();
        await waitForAnimations(app);
        await expectNoA11yViolations(app);
      });
    }
  }
});
