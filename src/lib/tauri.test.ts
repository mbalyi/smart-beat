import {
  describePlatform,
  getAppInfo,
  getMenuShortcuts,
  isTauri,
  NotInDesktopAppError,
  onMenuAction,
  setNativeTheme,
  type MenuAction,
} from "@/lib/tauri";
import { APP_INFO, emitMenuAction, mockTauri, SHORTCUTS } from "@/test/tauri";

describe("outside the desktop app", () => {
  it("reports that Tauri is unavailable", () => {
    expect(isTauri()).toBe(false);
  });

  it("rejects commands with a descriptive error", async () => {
    await expect(getAppInfo()).rejects.toBeInstanceOf(NotInDesktopAppError);
    await expect(getMenuShortcuts()).rejects.toThrow(
      /only available in the Smart Beat desktop app/,
    );
  });

  it("makes menu subscriptions and theme sync no-ops", async () => {
    const unlisten = await onMenuAction(() => {});
    expect(() => unlisten()).not.toThrow();
    await expect(setNativeTheme("dark")).resolves.toBeUndefined();
  });
});

describe("inside the desktop app", () => {
  it("detects Tauri", () => {
    mockTauri();
    expect(isTauri()).toBe(true);
  });

  it("invokes the Rust commands", async () => {
    const calls = mockTauri();

    await expect(getAppInfo()).resolves.toEqual(APP_INFO);
    await expect(getMenuShortcuts()).resolves.toEqual(SHORTCUTS);
    expect(calls.map((c) => c.cmd)).toEqual(["app_info", "menu_shortcuts"]);
  });

  it("delivers menu actions until unsubscribed", async () => {
    mockTauri();
    const received: MenuAction[] = [];
    const unlisten = await onMenuAction((action) => received.push(action));

    await emitMenuAction("about");
    unlisten();
    await emitMenuAction("open");

    expect(received).toEqual(["about"]);
  });

  it("syncs the native window theme", async () => {
    const calls = mockTauri();

    await setNativeTheme("dark");
    await setNativeTheme(null);

    const themeCalls = calls.filter((c) => c.cmd === "plugin:window|set_theme");
    expect(themeCalls.map((c) => c.args)).toEqual([
      expect.objectContaining({ value: "dark" }),
      expect.objectContaining({ value: null }),
    ]);
  });
});

describe("describePlatform", () => {
  it.each([
    [{ os: "macos", arch: "aarch64" }, "macOS (Apple Silicon)"],
    [{ os: "macos", arch: "x86_64" }, "macOS (x64)"],
    [{ os: "windows", arch: "x86_64" }, "Windows (x64)"],
    [{ os: "linux", arch: "aarch64" }, "Linux (ARM64)"],
    [{ os: "freebsd", arch: "riscv64" }, "freebsd (riscv64)"],
  ])("describes %o as %s", (platform, expected) => {
    expect(describePlatform(platform)).toBe(expected);
  });
});
