import { renderHook, waitFor } from "@testing-library/react";

import { useMenuActions } from "@/hooks/use-menu-actions";
import { emitMenuAction, mockTauri } from "@/test/tauri";

describe("useMenuActions", () => {
  it("calls the latest handler for each menu action", async () => {
    mockTauri();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ handler }) => useMenuActions(handler), {
      initialProps: { handler: first },
    });

    rerender({ handler: second });
    await waitFor(async () => {
      await emitMenuAction("about");
      expect(second).toHaveBeenCalledWith("about");
    });
    expect(first).not.toHaveBeenCalled();
  });

  it("stops listening on unmount", async () => {
    mockTauri();
    const handler = vi.fn();
    const { unmount } = renderHook(() => useMenuActions(handler));
    await waitFor(async () => {
      await emitMenuAction("open");
      expect(handler).toHaveBeenCalledTimes(1);
    });

    unmount();
    await emitMenuAction("open");

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does nothing outside the desktop app", () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useMenuActions(handler));

    expect(() => unmount()).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});
