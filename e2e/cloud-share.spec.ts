import type { Page } from "@playwright/test";

import features from "../src/lib/features.json" with { type: "json" };

import { emitMenuAction, expect, expectNoA11yViolations, PRACTICE_SONG, test } from "./fixtures";

/**
 * Sharing a tab or a stems file with a link, and the Cloud library (#201), with the cloud
 * commands mocked in e2e/tauri-mock.js (`cloud_list`, `cloud_share`, `cloud_create`,
 * `cloud_list_stems`, `stems_cloud_save`). The clipboard is replaced by a recorder: the
 * browsers differ in what they let a test read.
 */

const ACCOUNTS = [
  {
    provider: "drive",
    label: "Google Drive",
    account: "me@gmail.test",
    shareLevels: ["view", "edit"],
  },
  {
    provider: "onedrive",
    label: "OneDrive",
    account: "me@outlook.test",
    shareLevels: ["view", "edit"],
  },
  { provider: "dropbox", label: "Dropbox", account: null, shareLevels: ["view"] },
];

const TAB = {
  id: "drive:t1",
  name: "riff.gp",
  revision: "r",
  size: 20_480,
  modified_ms: 1790000000000,
};
const STEMS = {
  id: "drive:s1",
  name: "Neon Nights.sbstems",
  revision: "r",
  size: 50 * 1024 * 1024,
  modified_ms: 1790000001000,
};

declare global {
  interface Window {
    __copied: string[];
  }
}

async function connect(app: Page) {
  await app.evaluate(
    ([accounts, tab, stems]) => {
      window.__copied = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => void window.__copied.push(text) },
      });
      window.__drives.accounts = accounts;
      window.__drives.tabs = { drive: [tab] };
      window.__drives.stems = { drive: [stems] };
    },
    [ACCOUNTS, TAB, STEMS] as const,
  );
}

/** The notice that the link was copied (the dialog's own title says it too). */
const notice = (app: Page) => app.locator("[data-sonner-toast]").getByText("Link copied");

/** Scans the open dialog (not the page behind it) in light and dark. */
async function scan(app: Page, dialog = "[role=dialog]") {
  for (const colorScheme of ["light", "dark"] as const) {
    await app.emulateMedia({ colorScheme });
    // Let the colour transitions start, so that the scan waits for them.
    await app.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    await expectNoA11yViolations(app, { popup: dialog });
  }
  await app.emulateMedia({ colorScheme: "light" });
}

test.describe("Share a cloud file (#201)", () => {
  test("copies a link to a tab in the drive and says so", async ({ app }) => {
    await connect(app);
    await app.evaluate(() => window.__emitTauriEvent("cloud-changed", null));
    await emitMenuAction(app, "cloud-library");
    const library = app.getByRole("dialog", { name: "Cloud library" });
    await library.getByRole("button", { name: "Share a link to riff.gp" }).click();

    const dialog = app.getByTestId("share-dialog");
    await scan(app);
    await dialog.getByRole("radio", { name: "Can edit" }).check();
    await dialog.getByRole("button", { name: "Copy link" }).click();

    await expect(dialog.getByRole("textbox", { name: "Share link" })).toHaveValue(
      "https://share.example.com/drive%3At1?as=edit",
    );
    await expect(notice(app)).toBeVisible();
    expect(await app.evaluate(() => window.__copied)).toEqual([
      "https://share.example.com/drive%3At1?as=edit",
    ]);
    expect(await app.evaluate(() => window.__drives.shares)).toEqual([
      { item: "drive:t1", level: "edit" },
    ]);
    // A file that is in the drive already is never uploaded again.
    expect(await app.evaluate(() => window.__drives.creates)).toEqual([]);
    await scan(app);
  });

  test("a failed link says why and can be tried again", async ({ app }) => {
    await connect(app);
    await emitMenuAction(app, "cloud-library");
    await app.evaluate(() => {
      window.__drives.shareError = {
        kind: "io",
        message: "This account does not allow sharing this file with a link.",
      };
    });
    await app.getByRole("button", { name: "Share a link to riff.gp" }).click();
    const dialog = app.getByTestId("share-dialog");
    await dialog.getByRole("button", { name: "Copy link" }).click();

    await expect(dialog.getByRole("alert")).toContainText("does not allow sharing");
    await scan(app);
    await dialog.getByRole("button", { name: "Try again" }).click();
    await expect(dialog.getByRole("textbox", { name: "Share link" })).toBeVisible();
  });

  test("a stems file in the drive gets a link of its own", async ({ app }) => {
    await connect(app);
    await emitMenuAction(app, "cloud-library");
    await app.getByRole("button", { name: "Share a link to Neon Nights.sbstems" }).click();
    const dialog = app.getByTestId("share-dialog");
    await dialog.getByRole("button", { name: "Copy link" }).click();

    await expect(dialog.getByRole("textbox", { name: "Share link" })).toHaveValue(
      "https://share.example.com/drive%3As1?as=view",
    );
  });
});

test.describe("Share a file on this computer (#201)", () => {
  test("asks which storage, uploads a copy and copies the link", async ({ app }) => {
    await connect(app);
    await app.evaluate((path) => window.__emitTauriEvent("recent-changed", [path]), PRACTICE_SONG);
    await app.getByRole("button", { name: "Share a link to practice-song.gp" }).click();

    const dialog = app.getByTestId("share-dialog");
    await expect(dialog.getByRole("button", { name: /Upload to Dropbox/ })).toBeDisabled();
    await scan(app);
    await dialog.getByRole("button", { name: "Upload to OneDrive" }).click();
    await expect(dialog.getByRole("heading", { name: "Who can use the link?" })).toBeVisible();
    await dialog.getByRole("button", { name: "Upload and copy link" }).click();

    const link = dialog.getByRole("textbox", { name: "Share link" });
    await expect(link).toHaveValue(
      /^https:\/\/share\.example\.com\/onedrive%3Acreated-\d+\?as=view$/,
    );
    await expect(notice(app)).toBeVisible();
    const creates = await app.evaluate(() => window.__drives.creates);
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ provider: "onedrive", name: "practice-song.gp" });
    expect(creates[0]!.bytes).toBeGreaterThan(0);
  });

  test("a storage that only views offers no edit link", async ({ app }) => {
    await connect(app);
    await app.evaluate(() => {
      window.__drives.accounts = [
        { provider: "dropbox", label: "Dropbox", account: "me@db.test", shareLevels: ["view"] },
      ];
    });
    await app.evaluate((path) => window.__emitTauriEvent("recent-changed", [path]), PRACTICE_SONG);
    await app.getByRole("button", { name: "Share a link to practice-song.gp" }).click();
    const dialog = app.getByTestId("share-dialog");
    await dialog.getByRole("button", { name: "Upload to Dropbox" }).click();

    await expect(dialog.getByRole("radio", { name: "Can edit" })).toBeDisabled();
    await expect(dialog.getByRole("radio", { name: "Can view" })).toBeChecked();
    await scan(app);
  });

  test("with no drive connected it points to the settings", async ({ app }) => {
    await app.evaluate(() => {
      window.__drives.accounts = [];
    });
    await app.evaluate((path) => window.__emitTauriEvent("recent-changed", [path]), PRACTICE_SONG);
    await app.getByRole("button", { name: "Share a link to practice-song.gp" }).click();
    const dialog = app.getByTestId("share-dialog");
    await expect(dialog.getByTestId("share-no-storage")).toBeVisible();
    await scan(app);
    await dialog.getByRole("button", { name: "Set up cloud storage" }).click();
    await expect(app.getByRole("dialog", { name: "Settings" })).toBeVisible();
  });
});

test.describe("Share stems from this computer (#201, #186)", () => {
  test.skip(!features["stem-separation"], "stem-separation is off in src/lib/features.json");

  test("saves the stems to the storage without the original and links to that file", async ({
    app,
  }) => {
    await connect(app);
    await app.getByRole("button", { name: "Stem separation" }).click();
    const separation = app.getByRole("dialog", { name: "Stem separation" });
    await app.evaluate(() => (window.__dialogResult = "/Users/me/Music/neon-nights.mp3"));
    await separation.getByRole("button", { name: "Choose a song" }).click();
    await separation.getByRole("button", { name: "Next" }).click();
    await separation.getByRole("radio", { name: "Fast" }).check();
    await separation.getByRole("button", { name: "Separate" }).click();
    await expect(app.getByRole("heading", { level: 1, name: "neon-nights" })).toBeVisible();
    await app.getByRole("button", { name: "Smart Beat", exact: true }).click();

    await app.getByRole("button", { name: "Share a link to neon-nights" }).click();
    const dialog = app.getByTestId("share-dialog");
    await dialog.getByRole("button", { name: "Upload to Google Drive" }).click();
    await expect(dialog.getByText(/shared as their own stems file/)).toBeVisible();
    await scan(app);
    await dialog.getByRole("button", { name: "Upload and copy link" }).click();

    await expect(dialog.getByRole("textbox", { name: "Share link" })).toHaveValue(
      /^https:\/\/share\.example\.com\/drive%3Afile-\d+\?as=view$/,
    );
    const saves = await app.evaluate(() => window.__drives.saves);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ provider: "drive", includeOriginal: false });
  });
});

test.describe("Cloud library (#201)", () => {
  for (const [label, size] of [
    ["desktop", { width: 1280, height: 800 }],
    ["phone", { width: 375, height: 812 }],
  ] as const) {
    test(`lists tabs and stems per storage, ${label}`, async ({ app }) => {
      await app.setViewportSize(size);
      await connect(app);
      await emitMenuAction(app, "cloud-library");
      const dialog = app.getByRole("dialog", { name: "Cloud library" });

      const drive = dialog.getByRole("region", { name: /Google Drive/ });
      await expect(drive.getByTestId("library-entry")).toHaveCount(2);
      await expect(drive.getByTestId("library-entry").first()).toContainText("Neon Nights");
      // OneDrive is connected and empty; Dropbox is not connected.
      await expect(
        dialog.getByRole("region", { name: /OneDrive/ }).getByTestId("library-empty"),
      ).toBeVisible();
      await expect(dialog.getByRole("region", { name: /Dropbox/ })).toContainText("Not connected");
      await scan(app);
    });
  }

  test("a storage that fails is explained and can be tried again", async ({ app }) => {
    await connect(app);
    await app.evaluate(() => {
      window.__drives.listError = { drive: { kind: "network", message: "offline" } };
    });
    await emitMenuAction(app, "cloud-library");
    const dialog = app.getByRole("dialog", { name: "Cloud library" });
    const drive = dialog.getByRole("region", { name: /Google Drive/ });
    await expect(drive.getByRole("alert")).toContainText("can't be reached");
    await scan(app);

    await app.evaluate(() => {
      window.__drives.listError = {};
    });
    await drive.getByRole("button", { name: "Try again" }).click();
    await expect(drive.getByTestId("library-entry")).toHaveCount(2);
  });

  test("opens a tab from the library", async ({ app }) => {
    await connect(app);
    await emitMenuAction(app, "cloud-library");
    const dialog = app.getByRole("dialog", { name: "Cloud library" });
    await dialog.getByRole("button", { name: "Open riff.gp" }).click();
    await expect(dialog).toBeHidden();
  });
});
