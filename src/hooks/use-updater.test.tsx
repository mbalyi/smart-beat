import type { Channel } from "@tauri-apps/api/core";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useUpdater } from "@/hooks/use-updater";
import {
  AUTO_CHECK_DELAY_MS,
  AUTO_CHECK_INTERVAL_MS,
  LAST_AUTO_CHECK_KEY,
  readLastAutoCheck,
} from "@/lib/updater";
import { backend, mockTauri } from "@/test/tauri";

const checks = (calls: { cmd: string }[]) =>
  calls.filter((c) => c.cmd === "plugin:updater|check").length;

describe("useUpdater: checking by hand", () => {
  it("says so when this is the latest version", async () => {
    mockTauri();
    const { result } = renderHook(() => useUpdater({ autoCheck: false }));
    expect(result.current.open).toBe(false);

    act(() => result.current.checkNow());
    expect(result.current.open).toBe(true);
    expect(result.current.state).toEqual({ status: "checking" });

    await waitFor(() => expect(result.current.state.status).toBe("up-to-date"));
    expect(result.current.state).toEqual({ status: "up-to-date", version: "0.1.0" });
    expect(result.current.open).toBe(true);
  });

  it("offers the update it finds, without installing anything", async () => {
    const calls = mockTauri();
    backend.update = { version: "0.2.0", body: "- Update dialog." };
    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    act(() => result.current.checkNow());

    await waitFor(() => expect(result.current.state.status).toBe("available"));
    expect(result.current.state).toEqual({
      status: "available",
      info: { currentVersion: "0.1.0", version: "0.2.0", notes: "- Update dialog." },
    });
    expect(calls.some((c) => c.cmd === "plugin:updater|download_and_install")).toBe(false);
  });

  it("reports why the check failed, and tries again on request", async () => {
    mockTauri();
    backend.updateError = { during: "check", message: "Could not fetch a valid release JSON." };
    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    act(() => result.current.checkNow());
    await waitFor(() => expect(result.current.state.status).toBe("error"));
    expect(result.current.state).toEqual({
      status: "error",
      message: "Could not fetch a valid release JSON.",
    });

    backend.updateError = null;
    act(() => result.current.checkNow());
    await waitFor(() => expect(result.current.state.status).toBe("up-to-date"));
  });

  it("does not start a second check while one is running", async () => {
    const calls = mockTauri();
    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    act(() => {
      result.current.checkNow();
      result.current.checkNow();
    });

    await waitFor(() => expect(result.current.state.status).toBe("up-to-date"));
    expect(checks(calls)).toBe(1);
  });

  it("does not remember a manual check as the automatic one", async () => {
    mockTauri();
    const { result } = renderHook(() => useUpdater({ autoCheck: false }));

    act(() => result.current.checkNow());
    await waitFor(() => expect(result.current.state.status).toBe("up-to-date"));

    expect(readLastAutoCheck()).toBeNull();
  });
});

describe("useUpdater: installing", () => {
  const offer = async (overrides: Parameters<typeof mockTauri>[0] = {}) => {
    const calls = mockTauri(overrides);
    backend.update = { version: "0.2.0", body: "- Update dialog." };
    const hook = renderHook(() => useUpdater({ autoCheck: false }));
    act(() => hook.result.current.checkNow());
    await waitFor(() => expect(hook.result.current.state.status).toBe("available"));
    return { ...hook, calls };
  };
  const info = { currentVersion: "0.1.0", version: "0.2.0", notes: "- Update dialog." };

  it("downloads only after install() is called, shows progress, then installs and restarts", async () => {
    let finishDownload: () => void = () => {};
    const { result, calls } = await offer({
      "plugin:updater|download_and_install": async (args) => {
        const { onEvent } = args as { onEvent: Channel<unknown> };
        onEvent.onmessage({ event: "Started", data: { contentLength: 100 } });
        onEvent.onmessage({ event: "Progress", data: { chunkLength: 40 } });
        await new Promise<void>((resolve) => (finishDownload = resolve));
        onEvent.onmessage({ event: "Finished" });
        return null;
      },
    });
    // Found, but nothing is downloaded until the user says so.
    expect(calls.some((c) => c.cmd === "plugin:updater|download_and_install")).toBe(false);

    act(() => result.current.install());
    await waitFor(() =>
      expect(result.current.state).toEqual({
        status: "downloading",
        info,
        progress: { downloaded: 40, total: 100 },
      }),
    );

    // Closing mid-download would leave the update half done.
    act(() => result.current.dismiss());
    expect(result.current.open).toBe(true);
    expect(result.current.state.status).toBe("downloading");

    act(() => finishDownload());
    await waitFor(() => expect(calls.some((c) => c.cmd === "plugin:process|restart")).toBe(true));
    expect(result.current.state).toEqual({ status: "installing", info });
  });

  it("reports a failed installation, and the dialog can be closed again", async () => {
    const { result, calls } = await offer();
    backend.updateError = { during: "install", message: "The signature does not match." };

    act(() => result.current.install());

    await waitFor(() => expect(result.current.state.status).toBe("error"));
    expect(result.current.state).toEqual({
      status: "error",
      message: "The signature does not match.",
    });
    expect(calls.some((c) => c.cmd === "plugin:process|restart")).toBe(false);

    act(() => result.current.dismiss());
    expect(result.current.open).toBe(false);
  });

  it("'Try again' after a failed installation checks anew", async () => {
    const { result, calls } = await offer();
    backend.updateError = { during: "install", message: "The signature does not match." };
    act(() => result.current.install());
    await waitFor(() => expect(result.current.state.status).toBe("error"));

    backend.updateError = null;
    act(() => result.current.checkNow());

    await waitFor(() => expect(result.current.state.status).toBe("available"));
    expect(checks(calls)).toBe(2);
  });
});

describe("useUpdater: Later", () => {
  it("closes the dialog and forgets the update", async () => {
    const calls = mockTauri();
    backend.update = { version: "0.2.0" };
    const { result } = renderHook(() => useUpdater({ autoCheck: false }));
    act(() => result.current.checkNow());
    await waitFor(() => expect(result.current.state.status).toBe("available"));

    act(() => result.current.dismiss());

    expect(result.current.open).toBe(false);
    expect(result.current.state).toEqual({ status: "idle" });
    await waitFor(() => expect(calls.some((c) => c.cmd === "plugin:resources|close")).toBe(true));
    // Installing needs a fresh, explicit offer.
    act(() => result.current.install());
    expect(calls.some((c) => c.cmd === "plugin:updater|download_and_install")).toBe(false);
  });
});

describe("useUpdater: the automatic check", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const startup = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_CHECK_DELAY_MS);
    });
  };

  it("waits a little after startup, then stays silent when there is no update", async () => {
    const calls = mockTauri();
    const { result } = renderHook(() => useUpdater());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_CHECK_DELAY_MS - 1);
    });
    expect(checks(calls)).toBe(0);

    await startup();
    expect(checks(calls)).toBe(1);
    expect(result.current.open).toBe(false);
    expect(result.current.state).toEqual({ status: "idle" });
  });

  it("remembers when it checked", async () => {
    mockTauri();
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
    renderHook(() => useUpdater());

    await startup();

    expect(readLastAutoCheck()).toBe(Date.parse("2026-11-01T12:00:05Z"));
  });

  it("opens the dialog when it finds an update", async () => {
    mockTauri();
    backend.update = { version: "0.2.0", body: "- Update dialog." };
    const { result } = renderHook(() => useUpdater());

    await startup();

    expect(result.current.open).toBe(true);
    expect(result.current.state.status).toBe("available");
  });

  it("does not check again within a day", async () => {
    const calls = mockTauri();
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
    localStorage.setItem(LAST_AUTO_CHECK_KEY, String(Date.now() - AUTO_CHECK_INTERVAL_MS + 60_000));
    renderHook(() => useUpdater());

    await startup();

    expect(checks(calls)).toBe(0);
  });

  it("checks again once a day has passed", async () => {
    const calls = mockTauri();
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
    localStorage.setItem(LAST_AUTO_CHECK_KEY, String(Date.now() - AUTO_CHECK_INTERVAL_MS - 1));
    renderHook(() => useUpdater());

    await startup();

    expect(checks(calls)).toBe(1);
  });

  it("stays silent when the check fails, and tries again at the next start", async () => {
    const calls = mockTauri();
    backend.updateError = { during: "check", message: "offline" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useUpdater());

    await startup();

    expect(checks(calls)).toBe(1);
    expect(result.current.open).toBe(false);
    expect(result.current.state).toEqual({ status: "idle" });
    expect(readLastAutoCheck()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("does nothing in a plain browser", async () => {
    // No Tauri mock: there is no updater to ask.
    const { result } = renderHook(() => useUpdater());

    await startup();

    expect(result.current.state).toEqual({ status: "idle" });
    expect(readLastAutoCheck()).toBeNull();
  });

  it("can be switched off", async () => {
    const calls = mockTauri();
    renderHook(() => useUpdater({ autoCheck: false }));

    await startup();

    expect(checks(calls)).toBe(0);
  });

  it("shows the result when the user asks while the automatic check is running", async () => {
    mockTauri();
    const { result } = renderHook(() => useUpdater());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_CHECK_DELAY_MS - 1);
    });

    // The automatic check starts and the user asks right away.
    act(() => {
      vi.advanceTimersByTime(1);
      result.current.checkNow();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.open).toBe(true);
    expect(result.current.state.status).toBe("up-to-date");
  });
});
