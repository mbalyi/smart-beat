import type { Page } from "@playwright/test";

import {
  emitMenuAction,
  expect,
  expectNoA11yViolations,
  openSong,
  test,
  waitForAnimations,
} from "./fixtures";

/**
 * Practice together, direct connection (#258): the codes for the host's other networks, "Host a
 * network" on Windows and Linux, and the cable-first macOS steps. The core is mocked in
 * e2e/tauri-mock.js (`practice_host`, `practice_network_*`), driven by `window.__practiceNetwork`.
 */

interface MockNetworkAddress {
  name: string;
  kind: "wifi" | "cable" | "link-local" | "other";
  address: string;
  code: string;
}

declare global {
  interface Window {
    __practiceNetwork?: {
      addresses?: MockNetworkAddress[];
      support?: { canHost: boolean; reason: string | null };
      startError?: string | null;
      started?: number;
      stopped?: number;
    };
  }
}

const MAIN_CODE = "ABCD-EFGH-JKMN-PQRS-TVWX";
const HELP_LINK = "Need a direct connection? (no router, cable or hotspot)";
const NETWORK = { ssid: "SmartBeat-K7QD", passphrase: "abcd2345efgh" };
const ADDRESSES: MockNetworkAddress[] = [
  { name: "en0", kind: "wifi", address: "192.168.1.5:50123", code: MAIN_CODE },
  {
    name: "en5",
    kind: "link-local",
    address: "169.254.3.4:50123",
    code: "1111-2222-3333-4444-5555",
  },
  { name: "Ethernet", kind: "cable", address: "10.0.0.2:50123", code: "6666-7777-8888-9999-AAAA" },
];

async function pretendToBe(app: Page, platform: string) {
  await app.evaluate((value) => {
    for (const [key, v] of [
      ["platform", value],
      ["userAgent", ""],
      ["userAgentData", undefined],
    ] as const) {
      Object.defineProperty(navigator, key, { get: () => v, configurable: true });
    }
  }, platform);
}

async function mockNetwork(app: Page, setup: NonNullable<Window["__practiceNetwork"]>) {
  await app.evaluate((value) => {
    window.__practiceNetwork = value;
  }, setup);
}

/** A stand-in clipboard that remembers what was copied (browsers differ in what tests may read). */
async function recordClipboard(app: Page) {
  await app.evaluate(() => {
    const copied: string[] = [];
    (window as unknown as { __copied: string[] }).__copied = copied;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void copied.push(text) },
      configurable: true,
    });
  });
}

const copied = (app: Page) =>
  app.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

async function openDialog(app: Page) {
  await openSong(app);
  await emitMenuAction(app, "practice-together");
  const dialog = app.getByRole("dialog", { name: "Practice together" });
  await expect(dialog).toBeVisible();
  await waitForAnimations(app);
  return dialog;
}

async function openHelp(app: Page) {
  const dialog = await openDialog(app);
  await dialog.getByRole("button", { name: HELP_LINK }).click();
  await expect(dialog.getByTestId("direct-connection-help")).toBeVisible();
  return dialog;
}

test.describe("Practice together: other networks", () => {
  test("lists a code for each of the host's other networks, each one copyable", async ({ app }) => {
    await mockNetwork(app, { addresses: ADDRESSES });
    await recordClipboard(app);
    const dialog = await openDialog(app);
    await dialog.getByRole("button", { name: "Start a session" }).click();
    await expect(dialog.getByTestId("room-code")).toHaveText(MAIN_CODE);
    const list = dialog.getByRole("region", { name: "Other networks" });
    const rows = list.getByTestId("other-network");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Direct link · en5 · 169.254.3.4:50123");
    await expect(rows.nth(0)).toContainText("1111-2222-3333-4444-5555");
    await expect(rows.nth(1)).toContainText("Cable · Ethernet");
    await rows.nth(1).getByRole("button", { name: "Copy the Ethernet code" }).click();
    await expect(
      rows.nth(1).getByRole("button", { name: "Copied the Ethernet code" }),
    ).toBeVisible();
    expect(await copied(app)).toEqual(["6666-7777-8888-9999-AAAA"]);
  });

  test("shows no list for a host on one network", async ({ app }) => {
    const dialog = await openDialog(app);
    await dialog.getByRole("button", { name: "Start a session" }).click();
    await expect(dialog.getByTestId("room-code")).toHaveText(MAIN_CODE);
    await expect(dialog.getByTestId("other-networks")).toHaveCount(0);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the list has no WCAG violations in ${colorScheme} mode`, async ({ app }) => {
      await app.emulateMedia({ colorScheme });
      await mockNetwork(app, { addresses: ADDRESSES });
      const dialog = await openDialog(app);
      await dialog.getByRole("button", { name: "Start a session" }).click();
      await expect(dialog.getByTestId("other-networks")).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
      expect(await dialog.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
    });
  }
});

test.describe("Practice together: Host a network", () => {
  for (const [platform, os] of [
    ["Win32", "windows"],
    ["Linux x86_64", "linux"],
  ] as const) {
    test(`starts and stops a network on ${os}, with its QR code`, async ({ app }) => {
      await pretendToBe(app, platform);
      await mockNetwork(app, { support: { canHost: true, reason: null } });
      await recordClipboard(app);
      const dialog = await openHelp(app);
      const card = dialog.getByRole("region", { name: "Host a network" });
      await card.getByRole("button", { name: "Start a network" }).click();
      await expect(card.getByRole("status")).toContainText("Your network is on");
      await expect(card).toContainText(NETWORK.ssid);
      await expect(card).toContainText(NETWORK.passphrase);
      await expect(
        card.getByRole("img", { name: `QR code to join the Wi-Fi network ${NETWORK.ssid}` }),
      ).toBeVisible();
      await card.getByRole("button", { name: "Copy the password" }).click();
      expect(await copied(app)).toEqual([NETWORK.passphrase]);

      await card.getByRole("button", { name: "Stop the network" }).click();
      await expect(card.getByRole("button", { name: "Start a network" })).toBeEnabled();
      await expect(card.getByTestId("wifi-qr")).toHaveCount(0);
      const calls = await app.evaluate(() => window.__practiceNetwork);
      expect(calls?.started).toBe(1);
      expect(calls?.stopped).toBe(1);
    });
  }

  test("falls back to the steps by hand when the network does not start", async ({ app }) => {
    await pretendToBe(app, "Linux x86_64");
    await mockNetwork(app, {
      support: { canHost: true, reason: null },
      startError: "NetworkManager is not running, so Smart Beat cannot make a network here.",
    });
    const dialog = await openHelp(app);
    const card = dialog.getByRole("region", { name: "Host a network" });
    await card.getByRole("button", { name: "Start a network" }).click();
    await expect(card.getByRole("alert")).toContainText("NetworkManager is not running");
    await expect(card.getByRole("alert")).toContainText("steps below");
    await expect(dialog.getByTestId("direct-connection-help")).toContainText(
      "nmcli device wifi hotspot",
    );
    await expect(card.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  test("is not offered when the computer cannot host a network", async ({ app }) => {
    await pretendToBe(app, "Win32");
    const dialog = await openHelp(app);
    await expect(dialog.getByTestId("direct-connection-help")).toContainText("Mobile hotspot");
    await expect(dialog.getByRole("region", { name: "Host a network" })).toHaveCount(0);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`the running network has no WCAG violations in ${colorScheme} mode`, async ({ app }) => {
      await app.emulateMedia({ colorScheme });
      await pretendToBe(app, "Win32");
      await mockNetwork(app, { support: { canHost: true, reason: null } });
      const dialog = await openHelp(app);
      const card = dialog.getByRole("region", { name: "Host a network" });
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
      await card.getByRole("button", { name: "Start a network" }).click();
      await expect(card.getByTestId("wifi-qr")).toBeVisible();
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
      expect(await dialog.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
    });
  }
});

test.describe("Practice together: the macOS steps", () => {
  test("put the cable between the two Macs first", async ({ app }) => {
    await pretendToBe(app, "MacIntel");
    const dialog = await openHelp(app);
    const help = dialog.getByTestId("direct-connection-help");
    await expect(help.getByRole("heading", { level: 4 }).first()).toHaveText(
      "Best: connect the two Macs with a cable",
    );
    await expect(help).toContainText("they link up on 169.254.x.x by themselves");
    await expect(help).toContainText("A Mac cannot host a network from Smart Beat");
    await expect(dialog.getByRole("region", { name: "Host a network" })).toHaveCount(0);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`have no WCAG violations in ${colorScheme} mode`, async ({ app }) => {
      await app.emulateMedia({ colorScheme });
      await pretendToBe(app, "MacIntel");
      await openHelp(app);
      await expectNoA11yViolations(app, { popup: "[role=dialog]" });
    });
  }
});
