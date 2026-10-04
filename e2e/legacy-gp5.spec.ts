import type { Page } from "@playwright/test";

import {
  editorStatus,
  expect,
  expectNoA11yViolations,
  openSong,
  scoreRegion,
  test,
  waitForAnimations,
} from "./fixtures";

const ACCENTED = "/Users/me/Music/accented-names.gp5";
const DRUM_LINES = "/Users/me/Music/drum-lines.gp5";

/** Guitar Pro 3–5 files from other computers: text encodings and drum strings (#53). */
test.describe("Guitar Pro 5 files (#53)", () => {
  test("shows accented track names correctly everywhere", async ({ app }) => {
    await openSong(app, ACCENTED);
    const tracks = app.getByRole("region", { name: "Tracks and mixer" });
    await expect(tracks).toContainText("Ütős hangszer");
    await expect(tracks).toContainText("Szóló 1");
    await expect(app.locator("body")).not.toContainText("�");
    await expect(scoreRegion(app)).toHaveAccessibleName("Score: Szóló 1");

    await app.getByRole("button", { name: "Actions for Ütős hangszer" }).click();
    await app.getByRole("menuitem", { name: "Drum mixer…" }).click();
    await expect(app.getByRole("dialog", { name: "Drum mixer: Ütős hangszer" })).toBeVisible();
  });

  test("reopens a file with another text encoding", async ({ app }) => {
    await openSong(app, ACCENTED);
    await app.getByRole("button", { name: "File" }).click();
    await app.getByRole("menuitem", { name: "Reopen with encoding" }).click();
    await expect(app.getByRole("menu").last()).toContainText("Read as Central European");
    await app.getByRole("menuitemradio", { name: "Western (Windows-1252)" }).click();
    const tracks = app.getByRole("region", { name: "Tracks and mixer" });
    await expect(tracks).toContainText("Ütõs hangszer");
    // Only one tab: the song was read again in place.
    await expect(
      app.getByRole("navigation", { name: "Open songs" }).getByRole("listitem"),
    ).toHaveCount(1);
  });

  test("opens drum tracks with score and drum tab, without the tuning label", async ({ app }) => {
    await openSong(app);
    await app.getByRole("combobox", { name: "Track" }).click();
    await app.getByRole("option", { name: "Drums" }).click();
    const notation = app.getByRole("radiogroup", { name: "Notation" });
    await expect(notation.getByRole("radio", { name: "Score + tab", exact: true })).toBeChecked();
    await expect
      .poll(() =>
        scoreRegion(app).locator(".at-surface svg text").filter({ hasText: /^42$/ }).count(),
      )
      .toBeGreaterThan(0);
    await expect(
      scoreRegion(app).locator(".at-surface svg text").filter({ hasText: "Tuning" }),
    ).toHaveCount(0);
  });

  test("keeps the strings drum notes were written on, and moves them", async ({ app }) => {
    await openSong(app, DRUM_LINES);
    // Bar 2 stacks the China (52) above the kick (35), with the snare (38) on the bottom line.
    const yOf = (n: string) => bar2Number(app, n);
    await expect.poll(() => yOf("52")).toBeGreaterThan(0);
    const [china, kick, snare] = [await yOf("52"), await yOf("35"), await yOf("38")];
    expect(china).toBeLessThan(kick);
    expect(kick).toBeLessThan(snare);

    // Up and down walk the drums of the beat, line by line.
    await app.getByRole("button", { name: "Edit" }).click();
    await waitForAnimations(app);
    await app.keyboard.press("ControlOrMeta+ArrowRight"); // bar 2
    await app.keyboard.press("ArrowUp");
    await expect.poll(() => editorStatus(app)).toMatch(/China/);
    await app.keyboard.press("ArrowDown");
    await expect.poll(() => editorStatus(app)).toMatch(/Kick/);
    await app.keyboard.press("ArrowDown");
    await expect.poll(() => editorStatus(app)).toMatch(/Snare/);

    // Alt+Up moves the snare a line up in the drum tab.
    const before = await yOf("38");
    await app.keyboard.press("Alt+ArrowUp");
    await expect.poll(() => yOf("38")).toBeLessThan(before);
    await expectNoA11yViolations(app);
  });
});

/** The y position of drum number `n` in bar 2 of the drum tab (the first one drawn after bar 1). */
async function bar2Number(app: Page, n: string): Promise<number> {
  return scoreRegion(app)
    .locator(".at-surface svg text")
    .evaluateAll((texts, wanted) => {
      const bar2 = texts.find(
        (t) => t.textContent?.trim() === "2" && t.getAttribute("fill") === "#C80000",
      );
      if (!bar2) return 0;
      const x0 = bar2.getBoundingClientRect().x;
      const hit = texts
        .filter((t) => t.textContent?.trim() === wanted && t.getBoundingClientRect().x > x0)
        .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x)[0];
      return hit ? hit.getBoundingClientRect().y : 0;
    }, n);
}
