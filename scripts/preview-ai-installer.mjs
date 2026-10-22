#!/usr/bin/env node
// Opens the AI model installer dialog (#150) in a real browser against the dev server, with the
// native commands mocked (the same mock the e2e tests use), so the design can be checked by eye.
//
//   pnpm dev                                        # in one terminal
//   node scripts/preview-ai-installer.mjs           # in another: opens the dialog at step 1
//   node scripts/preview-ai-installer.mjs --step 4  # jump to a step (1 About ... 5 Complete)
//   node scripts/preview-ai-installer.mjs --webkit  # Safari's engine instead of Chromium
//   node scripts/preview-ai-installer.mjs --light   # light theme (dark is the default)
//
// Other options: --url <address> (default http://localhost:1420), --installed small,medium (sizes
// that are already on the "computer"), --headless --shot <file.png> (take a screenshot and exit).

/* global window -- the callbacks passed to page.evaluate run in the browser */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { chromium, webkit } from "@playwright/test";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const url = option("url", "http://localhost:1420");
const step = Number(option("step", "1"));
const installed = option("installed", "").split(",").filter(Boolean);
const headless = flag("headless");
const shot = option("shot", "");
if (!(step >= 1 && step <= 5)) throw new Error("--step must be 1 to 5");

const root = path.resolve(import.meta.dirname, "..");
const mock = path.join(root, "e2e", "tauri-mock.js");
const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;

const browser = await (flag("webkit") ? webkit : chromium).launch({ headless });
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  colorScheme: flag("light") ? "light" : "dark",
});
await page.addInitScript({ path: mock });
await page.addInitScript((current) => {
  // An existing user who has seen What's new, with no startup splash in the way.
  localStorage.setItem("smart-beat:layout", JSON.stringify({ mixer: true, inspector: true }));
  localStorage.setItem(
    "smart-beat:tour",
    JSON.stringify({ tours: { main: "skipped" }, hints: {}, lastSeenVersion: current }),
  );
  localStorage.setItem("smart-beat:soundfont", "sonivox");
  window.__splashMinMs = 0;
}, version);
await page.route("**/third-party-licenses.txt", (route) =>
  route.fulfill({ contentType: "text/plain; charset=utf-8", body: "" }),
);
try {
  await page.goto(url);
} catch {
  await browser.close();
  throw new Error(`Could not open ${url}. Start the dev server first: pnpm dev`);
}
await page.evaluate((sizes) => {
  for (const size of sizes) window.__muscriptor.installed[size] = true;
  // A download that waits, so that step 4 can be looked at.
  window.__muscriptor.hold = true;
}, installed);

await page.getByRole("button", { name: "Import from Audio…" }).click();
const audio = page.getByRole("dialog", { name: "Import from Audio" });
await audio.getByRole("button", { name: "Download MuScriptor" }).click();
const installer = page.getByTestId("ai-installer");
await installer.waitFor();

const click = (name) => installer.getByRole("button", { name, exact: true }).click();
if (step >= 2) await click("Choose a model");
if (step >= 3) await click("Continue");
if (step >= 4) {
  await installer.getByLabel(/accepted the MuScriptor weight terms/).check();
  await installer.getByLabel(/only use MuScriptor with my own music/).check();
  await click("Continue");
}
if (step === 5) {
  await page.evaluate(() => window.__muscriptor.release?.());
  await installer.getByRole("button", { name: /^Back to/ }).waitFor();
}

if (shot) {
  await page.waitForTimeout(600);
  await page.screenshot({ path: shot });
  console.log(`Saved ${shot}`);
  await browser.close();
} else {
  console.log(`The installer is open at step ${step}. Close the browser window to stop.`);
  await new Promise((resolve) => browser.on("disconnected", resolve));
}
