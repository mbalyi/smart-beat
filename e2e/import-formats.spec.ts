import {
  dropFiles,
  expect,
  expectNoA11yViolations,
  openSong,
  scoreRegion,
  tabNumbers,
  test,
} from "./fixtures";

/** More tab and score formats (#44): MuseScore, text tab and alphaTex open like any song. */

const MUSIC = "/Users/me/Music";

test.describe("more file formats (#44)", () => {
  test("opens a MuseScore file (.mscz) as tablature and a score", async ({ app }) => {
    await openSong(app, `${MUSIC}/practice-song.mscz`);

    await expect(app.getByRole("heading", { level: 1, name: "MuseScore Practice" })).toBeVisible();
    await expect(scoreRegion(app)).toHaveAccessibleName("Score: Guitar");
    expect(await tabNumbers(app)).toEqual(expect.arrayContaining(["0", "2"]));
    await expect(app.getByRole("button", { name: "Show Piano", exact: true })).toBeVisible();
  });

  test("opens a plain MuseScore file (.mscx) and plays it", async ({ app }) => {
    await openSong(app, `${MUSIC}/practice-song.mscx`);
    await app.getByRole("button", { name: "Play" }).click();
    await expect(app.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(app.getByRole("group", { name: "Display" })).toContainText("90 BPM");
  });

  test("opens a Capella file (.capx) with its staves (alphaTab workaround)", async ({ app }) => {
    await openSong(app, `${MUSIC}/practice-song.capx`);
    await expect(scoreRegion(app)).toHaveAccessibleName("Score: Guitar");
    await expect(app.getByRole("button", { name: "Show Bass", exact: true })).toBeVisible();
    await expect(app.getByRole("group", { name: "Display" })).toContainText("100 BPM");
  });

  test("opens text tab (.txt) with a guess at the rhythm", async ({ app }) => {
    await openSong(app, `${MUSIC}/text-tab-song.txt`);

    await expect(app.getByText(/Text tab has no rhythm/).first()).toBeVisible(); // a toast: look first
    await expect(app.getByRole("heading", { level: 1, name: "Text Tab Song" })).toBeVisible();
    expect(await tabNumbers(app)).toEqual(expect.arrayContaining(["0", "3", "5", "7"]));
  });

  test("opens alphaTex (.atex)", async ({ app }) => {
    await openSong(app, `${MUSIC}/tex-song.atex`);
    await expect(app.getByRole("heading", { level: 1, name: "Tex Song" })).toBeVisible();
    expect(await tabNumbers(app)).toEqual(["0", "2", "3", "0", "0", "2", "3", "0"]);
  });

  test("opens the new formats when they are dropped on the window, and the overlay names them", async ({
    app,
  }) => {
    await dropFiles(app, [`${MUSIC}/tex-song.atex`]);
    await expect(app.getByRole("heading", { level: 1, name: "Tex Song" })).toBeVisible({
      timeout: 20_000,
    });
  });

  test("the welcome screen lists the new formats, with no WCAG violations", async ({ app }) => {
    await expect(
      app.getByText(/^Opens Guitar Pro 3–8 files.*MuseScore.*alphaTex.*text tab/),
    ).toBeVisible();
    await expectNoA11yViolations(app);
  });

  test("a text file without tab is explained", async ({ app }) => {
    await app.evaluate(() => (window.__dialogResult = "/Users/me/Music/missing-list.txt"));
    await app.route("**/__e2e__/files/missing-list.txt", (route) =>
      route.fulfill({ contentType: "text/plain", body: "milk\neggs" }),
    );
    await app.evaluate(() => window.__emitMenuAction("open"));
    await expect(app.getByText(/Couldn.t open “missing-list.txt”/)).toBeVisible();
    await expect(app.getByText(/damaged or is in a format/)).toBeVisible();
  });
});
