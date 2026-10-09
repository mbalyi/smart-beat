import { expect, test } from "./fixtures";

test.describe("Built with (start page)", () => {
  test("thanks alphaTab first, with its logo, after the features", async ({ app }) => {
    const section = app.getByRole("region", { name: "Made possible by open source." });
    await expect(section).toBeVisible();
    await expect(section.getByRole("link").first()).toHaveAccessibleName("alphaTab");
    await expect(section.locator("img").first()).toBeVisible();
    await expect(section).toContainText("not affiliated with or endorsed by alphaTab");
    const headings = await app.getByRole("heading", { level: 2 }).allTextContents();
    expect(headings[headings.length - 2]).toBe("Features");
    await expect(section).toContainText("Made possible by open source.");
  });

  test("a credit link opens in the system browser and leaves the app where it is", async ({
    app,
  }) => {
    await app
      .getByRole("region", { name: "Made possible by open source." })
      .getByRole("link", { name: "star alphaTab on GitHub" })
      .click();

    await expect
      .poll(() => app.evaluate(() => window.__ipcCalls.map((call) => call.cmd)))
      .toContain("plugin:opener|open_url");
    const call = await app.evaluate(() =>
      window.__ipcCalls.find((c) => c.cmd === "plugin:opener|open_url"),
    );
    expect(call?.args).toMatchObject({ url: "https://github.com/CoderLine/alphaTab" });
    await expect(app.getByRole("heading", { level: 1 })).toBeVisible();
    expect(new URL(app.url()).hostname).toBe("127.0.0.1");
  });
});

test("hovering a credit opens a card you can move into and click", async ({ app }) => {
  const section = app.getByRole("region", { name: "Made possible by open source." });

  await section.getByRole("link", { name: "RustySynth" }).hover();
  const card = app.locator("[data-slot=hover-card-content]");
  await expect(card).toContainText("SoundFonts");

  // The pointer can travel from the tile into the card without it closing, and the link works.
  const link = card.getByRole("link", { name: /Explore project/ });
  await link.hover();
  await app.waitForTimeout(500);
  await expect(card).toBeVisible();
  await link.click();
  await expect
    .poll(() => app.evaluate(() => window.__ipcCalls.map((c) => c.cmd)))
    .toContain("plugin:opener|open_url");
  const call = await app.evaluate(() =>
    window.__ipcCalls.find((c) => c.cmd === "plugin:opener|open_url"),
  );
  expect(call?.args).toMatchObject({ url: "https://github.com/sinshu/rustysynth" });
});

test("cpal is credited as 'cpal by RustAudio', with the RustAudio logo", async ({ app }) => {
  const tile = app
    .getByRole("region", { name: "Made possible by open source." })
    .getByRole("link", { name: "cpal by RustAudio" });
  await expect(tile).toBeVisible();
  await expect(tile.locator("img")).toBeVisible();
});
