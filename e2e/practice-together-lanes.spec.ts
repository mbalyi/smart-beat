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
 * Practice together: the audio lanes are shared (#239). The other player is simulated by the page's
 * Tauri mock (`window.__practiceTogether`): it sends the frames a guest (or the host) would send,
 * and what the app sent is read from `sentOf`. The files of the lanes are the mock's
 * `window.__sourceBytes` (this computer's files, by id) and `window.__receivedFiles` (what arrived).
 */

test.use({ viewport: { width: 1280, height: 1000 } });

const GUEST = "ann0000000000000";
const FILE_BYTES = 25_000;

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

type Edit = { k: string; ops?: { t: string; [key: string]: unknown }[]; [key: string]: unknown };
const edits = (app: Page): Promise<Edit[]> =>
  app.evaluate(
    () => window.__practiceTogether.sentOf("edit").map((m) => m.body) as unknown as Edit[],
  );
const sourceMessages = (app: Page, type: string) =>
  app.evaluate(
    (t) => window.__practiceTogether.sentOf(t) as unknown as Record<string, unknown>[],
    type,
  );
const guestSays = (app: Page, body: Edit) =>
  app.evaluate((b) => window.__practiceTogether.frame({ type: "edit", body: b }), body);
const say = (app: Page, msg: Record<string, unknown>) =>
  app.evaluate((m) => window.__practiceTogether.frame(m as never), msg);

/** Hosts a session and lets a simulated guest in that edits and shares lanes. */
async function hostWithLanesGuest(app: Page): Promise<{ dialog: Locator }> {
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
        caps: ["transport", "tab", "edit", "lanes"],
        score: s,
        guest,
      });
    },
    [score, GUEST] as const,
  );
  const card = app.getByRole("alertdialog", { name: "Let this player in?" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Let in" }).click();
  await expect.poll(async () => (await edits(app)).some((e) => e.k === "rights")).toBe(true);
  await guestSays(app, { k: "since", seq: -1, key: score.key });
  await expect.poll(async () => (await edits(app)).some((e) => e.k === "live")).toBe(true);
  return { dialog };
}

const closeDialog = (app: Page) =>
  app.getByRole("button", { name: "Close", exact: true }).last().click();

/** Adds a lane from a file on the host (Import Audio) and gives the mock the file's bytes. */
async function addHostLane(app: Page): Promise<string> {
  await app.evaluate((path) => (window.__dialogResult = path), "/Users/me/Music/drums.wav");
  await emitMenuAction(app, "import-audio-file");
  await expect(app.locator("[data-testid^='lane-row-']")).toHaveCount(1);
  const id = await app.evaluate(() => Object.keys(window.__engineSources)[0]!);
  await app.evaluate(
    ([file, size]) => {
      window.__sourceBytes = {
        ...window.__sourceBytes,
        [file]: Uint8Array.from({ length: size }, (_, i) => (i * 7) % 251),
      };
    },
    [id, FILE_BYTES] as const,
  );
  return id;
}

const HOST_LANE_ID = "lane-from-host";
const HOST_FILE_ID = "c".repeat(64);

/** The shared lane the simulated host sends: a lane, then its clip (a lane never carries clips), of one file. */
const snapshot = () => [
  { t: "a-reset" },
  { t: "a-src-add", source: { id: HOST_FILE_ID, name: "host-drums.wav", ext: "wav" } },
  {
    t: "a-lane-add",
    at: 0,
    lane: {
      id: HOST_LANE_ID,
      name: "Host drums",
      color: null,
      followTransposition: true,
      folder: false,
      group: 0,
      semitones: 0,
      cents: 0,
    },
  },
  {
    t: "a-clip-set",
    lane: HOST_LANE_ID,
    clip: {
      id: "clip-from-host",
      takes: [{ name: "host-drums.wav", sourceId: HOST_FILE_ID, offsetMs: 0 }],
      take: 0,
      startMs: 0,
      lengthMs: 4000,
      gainDb: 0,
      mute: false,
      locked: false,
      reversed: false,
      semitones: 0,
      cents: 0,
      playrate: 1,
      preservePitch: true,
      fadeIn: { ms: 0, shape: "linear" },
      fadeOut: { ms: 0, shape: "linear" },
      envelope: [],
      stretch: [],
    },
  },
];

/** Joins a session as a guest in this tab (same tab as the host's: no tab is sent). */
async function joinAsGuest(app: Page) {
  const dialog = await openDialog(app);
  await dialog.getByRole("radio", { name: "Join an existing session" }).click();
  await dialog.getByLabel("Room code").fill("ABCD-EFGH-JKMN-PQRS-TVWX");
  await dialog.getByRole("button", { name: "Join the session" }).click();
  await expect
    .poll(() => app.evaluate(() => window.__practiceTogether.sentOf("hello").length))
    .toBe(1);
  const score = await fingerprint(app);
  await app.evaluate((s) => {
    window.__practiceTogether.frame({
      type: "hello",
      name: "Host",
      role: "host",
      caps: ["transport", "tab", "edit", "lanes"],
      score: s,
    });
    window.__practiceTogether.frame({
      type: "welcome",
      session: "s1",
      version: 1,
      name: "Host",
      caps: ["transport", "tab", "edit", "lanes"],
    });
  }, score);
  // The host asks what this guest has and brings it up to date.
  await say(app, { type: "edit", body: { k: "rights", canEdit: true, hello: true } });
  await expect.poll(async () => (await edits(app)).some((e) => e.k === "since")).toBe(true);
  await say(app, { type: "edit", body: { k: "ops", ops: snapshot(), from: "host" } });
  await say(app, { type: "edit", body: { k: "live", seq: 0 } });
  return dialog;
}

test.describe("Practice together: audio lanes", () => {
  test("a lane the host adds reaches the guest as operations, and its file is offered and sent in pieces", async ({
    app,
  }) => {
    test.slow();
    await hostWithLanesGuest(app);
    await closeDialog(app);
    const id = await addHostLane(app);

    // The shared parts of the lane go to the guest: the file (no path) and the lane.
    await expect
      .poll(async () =>
        (await edits(app)).flatMap((e) => (e.k === "ops" ? (e.ops ?? []).map((o) => o.t) : [])),
      )
      .toEqual(expect.arrayContaining(["a-src-add", "a-lane-add"]));
    const text = JSON.stringify(await edits(app));
    expect(text).not.toContain("/Users/me");
    // The host tells the guest it has the file.
    await expect
      .poll(async () => (await sourceMessages(app, "src-have")).flatMap((m) => m.ids as string[]))
      .toContain(id);

    // The guest asks for it: an offer with the size, then pieces after the guest's ack.
    await say(app, { type: "src-want", id });
    await expect
      .poll(async () => await sourceMessages(app, "src-offer"))
      .toContainEqual({ type: "src-offer", id, size: FILE_BYTES });
    await say(app, { type: "src-ack", id, n: 0 });
    const pieces = Math.ceil(FILE_BYTES / (10 * 1024));
    await expect.poll(async () => (await sourceMessages(app, "src-chunk")).length).toBe(pieces);
    const chunks = await sourceMessages(app, "src-chunk");
    expect(chunks.map((c) => c.off)).toEqual(Array.from({ length: pieces }, (_, i) => i * 10240));
    await say(app, { type: "src-done", id, ok: true });
  });

  test("Play is held back until the guest has the file, then both start", async ({ app }) => {
    test.slow();
    await hostWithLanesGuest(app);
    await closeDialog(app);
    await expect(app.getByTestId("together-chip")).toHaveAttribute("data-phase", "synchronized", {
      timeout: 15_000,
    });
    const id = await addHostLane(app);
    await expect(app.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 30_000 });

    // The guest has not said it has the file: nobody starts, and the host is told why.
    await app.getByRole("button", { name: "Play" }).click();
    await expect(app.getByText("Waiting for the audio files")).toBeVisible();
    expect(await app.evaluate(() => window.__practiceTogether.sentOf("cmd").length)).toBe(0);
    // The chip shows the files are not everywhere yet.
    await expect(app.getByTestId("together-files")).toBeVisible();

    // The guest has it now: Play goes out as a shared start.
    await say(app, { type: "src-have", ids: [id] });
    await expect(app.getByTestId("together-files")).toHaveCount(0);
    await app.getByRole("button", { name: "Play" }).click();
    await expect
      .poll(() => app.evaluate(() => window.__practiceTogether.sentOf("cmd").length))
      .toBe(1);
  });

  test("a lane's mix is the player's own: a mute is not shared, a rename is", async ({ app }) => {
    test.slow();
    await hostWithLanesGuest(app);
    await closeDialog(app);
    await addHostLane(app);
    await expect
      .poll(async () => (await edits(app)).some((e) => e.ops?.some((o) => o.t === "a-lane-add")))
      .toBe(true);
    const before = (await edits(app)).length;
    const row = app.locator("[data-testid^='lane-row-']");
    await row.getByRole("button", { name: /^Mute the / }).click();
    await app.waitForTimeout(600);
    expect(await edits(app)).toHaveLength(before);
  });

  test("a guest gets the host's lanes, shows them waiting for their file, and has the file when it arrives", async ({
    app,
  }) => {
    test.slow();
    await joinAsGuest(app);
    await closeDialog(app);

    // The lane is there with its clip; the file is on its way, so nothing is "missing".
    const row = app.locator("[data-testid^='lane-row-']");
    await expect(row).toHaveCount(1);
    await expect(row.getByRole("button", { name: "Edit the lane Host drums" })).toBeVisible();
    await expect(app.getByText(/Couldn't open the audio file/)).toHaveCount(0);

    // The guest says it has no file, the host announces it and the guest asks for it.
    await say(app, { type: "src-have", ids: [HOST_FILE_ID] });
    await expect
      .poll(async () => await sourceMessages(app, "src-want"))
      .toContainEqual({ type: "src-want", id: HOST_FILE_ID });
    await say(app, { type: "src-offer", id: HOST_FILE_ID, size: FILE_BYTES });
    await expect
      .poll(async () => await sourceMessages(app, "src-ack"))
      .toContainEqual({ type: "src-ack", id: HOST_FILE_ID, n: 0 });

    // The pieces arrive: the staged file is checked and loaded, and the guest says so.
    await app.evaluate(
      ([id, size]) => {
        const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 3) % 251);
        const piece = 10 * 1024;
        for (let off = 0; off < size; off += piece) {
          let text = "";
          for (const byte of bytes.subarray(off, off + piece)) text += String.fromCharCode(byte);
          window.__practiceTogether.frame({ type: "src-chunk", id, off, data: btoa(text) });
        }
      },
      [HOST_FILE_ID, FILE_BYTES] as const,
    );
    await expect
      .poll(async () => await sourceMessages(app, "src-done"))
      .toContainEqual({ type: "src-done", id: HOST_FILE_ID, ok: true });
    expect(await app.evaluate((id) => window.__receivedFiles?.[id]?.length, HOST_FILE_ID)).toBe(
      FILE_BYTES,
    );
    // The clip's waveform shows now that the file is loaded.
    await expect(
      row.getByRole("button", { name: /host-drums\.wav on Host drums/ }).locator("svg path"),
    ).toHaveCount(1, { timeout: 15_000 });
  });

  test("a guest's own mute stays its own when the host renames the lane", async ({ app }) => {
    test.slow();
    await joinAsGuest(app);
    await closeDialog(app);
    const row = app.locator("[data-testid^='lane-row-']");
    await row.getByRole("button", { name: /^Mute the / }).click();
    await say(app, {
      type: "edit",
      body: {
        k: "ops",
        from: "host",
        seq: 1,
        ops: [{ t: "a-lane-set", id: HOST_LANE_ID, set: { name: "Kit" } }],
      },
    });
    await expect(row.getByRole("button", { name: "Edit the lane Kit" })).toBeVisible();
    await expect(row.getByRole("button", { name: /^Mute the / })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 375, height: 812 },
  ]) {
    for (const colorScheme of ["light", "dark"] as const) {
      test(`the files on their way have no WCAG violations at ${viewport.width} px in ${colorScheme} mode`, async ({
        app,
      }) => {
        test.slow();
        await app.setViewportSize(viewport);
        await app.emulateMedia({ colorScheme });
        await joinAsGuest(app);
        await say(app, { type: "src-have", ids: [HOST_FILE_ID] });
        await say(app, { type: "src-offer", id: HOST_FILE_ID, size: FILE_BYTES });
        // Part of the file: a progress row is on screen.
        await app.evaluate((id) => {
          const bytes = Uint8Array.from({ length: 10 * 1024 }, (_, i) => i % 251);
          let text = "";
          for (const byte of bytes) text += String.fromCharCode(byte);
          window.__practiceTogether.frame({ type: "src-chunk", id, off: 0, data: btoa(text) });
        }, HOST_FILE_ID);
        const dialog = app.getByRole("dialog", { name: "Practice together" });
        await expect(dialog.getByTestId("audio-files")).toBeVisible();
        await expect(dialog.getByRole("progressbar", { name: /Getting Host drums/ })).toBeVisible();
        const overflow = await dialog.evaluate((e) => e.scrollWidth - e.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        await expectNoA11yViolations(app, { popup: "[role=dialog]" });
      });
    }
  }
});
