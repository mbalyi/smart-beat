import { expect, openSong, test } from "./fixtures";

declare global {
  interface Window {
    __ticks: { at: number; text: string }[];
    __smartBeatOutputLatencyMs?: number;
  }
}

/** The cursor follows what is heard: it is delayed by the audio output latency (#46). */
test("the position trails the audio by the output latency", async ({ app }) => {
  await openSong(app);
  // Record when the displayed second changes.
  await app.evaluate(() => {
    window.__ticks = [];
    const timer = document.querySelector("[role=timer]")!;
    new MutationObserver(() => {
      window.__ticks.push({
        at: performance.now(),
        text: timer.textContent!.split("/")[0]!.trim(),
      });
    }).observe(timer, { childList: true, characterData: true, subtree: true });
  });
  const ticks = () => app.evaluate(() => window.__ticks);
  await app.evaluate(() => (window.__smartBeatOutputLatencyMs = 0));

  await app.getByRole("button", { name: "Play" }).click();
  await expect
    .poll(async () => (await ticks()).some((t) => t.text === "0:02"), { timeout: 15_000 })
    .toBe(true);
  // From now on the output is 400 ms late: what is shown moves 400 ms later.
  await app.evaluate(() => (window.__smartBeatOutputLatencyMs = 400));
  await expect
    .poll(async () => (await ticks()).some((t) => t.text === "0:04"), { timeout: 15_000 })
    .toBe(true);

  const at = async (text: string) => (await ticks()).find((t) => t.text === text)!.at;
  const before = (await at("0:02")) - (await at("0:01"));
  const across = (await at("0:04")) - (await at("0:03")); // the second that follows the change
  const shifted = (await at("0:03")) - (await at("0:02")); // the delayed one
  expect(before).toBeGreaterThan(800);
  expect(before).toBeLessThan(1_250);
  // One interval is stretched by the new latency (~400 ms); the others are a normal second.
  expect(Math.max(shifted, across)).toBeGreaterThan(1_250);
});
