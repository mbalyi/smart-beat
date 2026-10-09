import { expect, test } from "./fixtures";

test.describe("Built with (start page)", () => {
  test("thanks alphaTab first, with its logo, after the features", async ({ app }) => {
    const section = app.getByRole("region", { name: "Built with" });
    await expect(section).toBeVisible();
    await expect(section.getByRole("link").first()).toHaveAccessibleName("alphaTab");
    await expect(section.locator("img").first()).toBeVisible();
    await expect(section).toContainText("not affiliated with or endorsed by alphaTab");
    const headings = await app.getByRole("heading", { level: 2 }).allTextContents();
    expect(headings.slice(-2)).toEqual(["Features", "Built with"]);
  });

  test("a credit link opens in the system browser and leaves the app where it is", async ({
    app,
  }) => {
    await app
      .getByRole("region", { name: "Built with" })
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
