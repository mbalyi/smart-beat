import {
  AUTO_CHECK_INTERVAL_MS,
  checkForUpdate,
  describeProgress,
  LAST_AUTO_CHECK_KEY,
  readLastAutoCheck,
  shouldAutoCheck,
  writeLastAutoCheck,
  type DownloadProgress,
} from "@/lib/updater";
import { backend, mockTauri } from "@/test/tauri";

describe("shouldAutoCheck", () => {
  const now = Date.UTC(2026, 10, 1, 12);

  it("checks when it never did", () => {
    expect(shouldAutoCheck(null, now)).toBe(true);
  });

  it("waits until a full day has passed", () => {
    expect(shouldAutoCheck(now - AUTO_CHECK_INTERVAL_MS + 1, now)).toBe(false);
    expect(shouldAutoCheck(now - AUTO_CHECK_INTERVAL_MS, now)).toBe(true);
    expect(shouldAutoCheck(now - 3 * AUTO_CHECK_INTERVAL_MS, now)).toBe(true);
    expect(shouldAutoCheck(now - 1000, now)).toBe(false);
  });

  it("checks when the stored time is in the future (the clock was set back) or not a number", () => {
    expect(shouldAutoCheck(now + 1000, now)).toBe(true);
    expect(shouldAutoCheck(Number.NaN, now)).toBe(true);
  });
});

describe("the remembered time of the last automatic check", () => {
  it("round-trips", () => {
    expect(readLastAutoCheck()).toBeNull();
    writeLastAutoCheck(1_700_000_000_000);
    expect(readLastAutoCheck()).toBe(1_700_000_000_000);
  });

  it("ignores a value that is not a time", () => {
    localStorage.setItem(LAST_AUTO_CHECK_KEY, "yesterday");
    expect(readLastAutoCheck()).toBeNull();
  });

  it("works without storage (private mode, blocked site data)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(readLastAutoCheck()).toBeNull();
    expect(() => writeLastAutoCheck(1)).not.toThrow();
  });
});

describe("checkForUpdate", () => {
  it("resolves with null when this is the latest version", async () => {
    mockTauri();
    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it("describes the new version, with trimmed release notes", async () => {
    mockTauri();
    backend.update = { version: "0.2.0", body: "\n- Update dialog.\n" };

    const update = await checkForUpdate();

    expect(update?.info).toEqual({
      currentVersion: "0.1.0",
      version: "0.2.0",
      notes: "- Update dialog.",
    });
  });

  it("has empty notes when the release has none", async () => {
    mockTauri();
    backend.update = { version: "0.2.0" };
    expect((await checkForUpdate())?.info.notes).toBe("");
  });

  it("downloads with progress, installs, then restarts the app", async () => {
    const calls = mockTauri();
    backend.update = { version: "0.2.0" };
    const update = await checkForUpdate();
    const progress: DownloadProgress[] = [];
    const onDownloaded = vi.fn(() => {
      // The restart must wait until the installation is done.
      expect(calls.some((c) => c.cmd === "plugin:process|restart")).toBe(false);
    });

    await update?.install((p) => progress.push(p), onDownloaded);

    expect(progress).toEqual([
      { downloaded: 0, total: 3000 },
      { downloaded: 1000, total: 3000 },
      { downloaded: 2000, total: 3000 },
      { downloaded: 3000, total: 3000 },
    ]);
    expect(onDownloaded).toHaveBeenCalledOnce();
    expect(calls.map((c) => c.cmd).slice(-2)).toEqual([
      "plugin:updater|download_and_install",
      "plugin:process|restart",
    ]);
  });

  it("does not restart when the installation fails", async () => {
    const calls = mockTauri();
    backend.update = { version: "0.2.0" };
    backend.updateError = { during: "install", message: "The signature does not match." };
    const update = await checkForUpdate();

    await expect(update?.install(vi.fn(), vi.fn())).rejects.toBe("The signature does not match.");

    expect(calls.some((c) => c.cmd === "plugin:process|restart")).toBe(false);
  });

  it("rejects when the update server cannot be reached", async () => {
    mockTauri();
    backend.updateError = { during: "check", message: "Could not fetch a valid release JSON." };
    await expect(checkForUpdate()).rejects.toBe("Could not fetch a valid release JSON.");
  });

  it("frees the update on the Rust side when it is not installed", async () => {
    const calls = mockTauri();
    backend.update = { version: "0.2.0" };
    const update = await checkForUpdate();

    await update?.close();

    expect(calls).toContainEqual(
      expect.objectContaining({ cmd: "plugin:resources|close", args: { rid: 7 } }),
    );
  });
});

describe("describeProgress", () => {
  it("shows the share of the download", () => {
    expect(describeProgress({ downloaded: 12.34 * 1024 * 1024, total: 45.6 * 1024 * 1024 })).toBe(
      "12.3 MB of 45.6 MB (27%)",
    );
  });

  it("shows only what was downloaded when the size is unknown", () => {
    expect(describeProgress({ downloaded: 2 * 1024 * 1024, total: null })).toBe(
      "2.0 MB downloaded",
    );
  });

  it("never goes over 100%", () => {
    expect(describeProgress({ downloaded: 2000, total: 1000 })).toContain("(100%)");
  });
});
