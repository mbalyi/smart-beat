import { act, renderHook } from "@testing-library/react";
import { toast } from "sonner";

import { NOTICE_DELAY_MS, useUsageNotice } from "@/hooks/use-usage-notice";
import { backend, mockTauri } from "@/test/tauri";

vi.mock("sonner", () => ({ toast: vi.fn() }));

const advance = () => act(() => vi.advanceTimersByTimeAsync(NOTICE_DELAY_MS + 50));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(toast).mockClear();
});
afterEach(() => vi.useRealTimers());

describe("useUsageNotice", () => {
  it("counts the app start", () => {
    const calls = mockTauri();
    renderHook(() => useUsageNotice(vi.fn()));
    expect(calls.filter((c) => c.cmd === "track_event").map((c) => c.args)).toEqual([
      { event: "app_start", format: null },
    ]);
  });

  it("shows the notice once, with a way to Settings, and remembers it", async () => {
    mockTauri();
    backend.usage = { enabled: true, available: true, noticeSeen: false };
    const openSettings = vi.fn();
    renderHook(() => useUsageNotice(openSettings));
    expect(toast).not.toHaveBeenCalled();

    await advance();

    expect(toast).toHaveBeenCalledOnce();
    const [title, options] = vi.mocked(toast).mock.calls[0]!;
    expect(title).toMatch(/counts which features are used/);
    expect(options?.description).toMatch(/no identifier/);
    (options?.action as unknown as { onClick: () => void }).onClick();
    expect(openSettings).toHaveBeenCalledOnce();
    expect(backend.usage.noticeSeen).toBe(true);
  });

  it("stays quiet once the notice was shown, in builds without counters and in a browser", async () => {
    mockTauri();
    backend.usage = { enabled: true, available: true, noticeSeen: true };
    renderHook(() => useUsageNotice(vi.fn()));
    await advance();

    backend.usage = { enabled: true, available: false, noticeSeen: false };
    renderHook(() => useUsageNotice(vi.fn()));
    await advance();

    expect(toast).not.toHaveBeenCalled();
  });

  it("does nothing when the settings can't be read", async () => {
    mockTauri({
      get_usage_settings: () => {
        throw { kind: "io", message: "no access" };
      },
    });
    renderHook(() => useUsageNotice(vi.fn()));
    await advance();
    expect(toast).not.toHaveBeenCalled();
  });
});
