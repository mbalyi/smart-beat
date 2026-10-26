import { renderHook, waitFor } from "@testing-library/react";

import { useExternalOpen } from "@/hooks/use-external-open";
import { backend, emitOpenExternalFiles, mockTauri } from "@/test/tauri";

describe("useExternalOpen", () => {
  it("opens songs the system queued before the page was ready", async () => {
    mockTauri();
    backend.pendingOpen.push("/songs/early.gp5");
    const onOpen = vi.fn();

    renderHook(() => useExternalOpen(onOpen));

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("/songs/early.gp5"));
    expect(backend.pendingOpen).toEqual([]);
  });

  it("opens every song of a later hand-over, once", async () => {
    mockTauri();
    const onOpen = vi.fn();
    renderHook(() => useExternalOpen(onOpen));

    await emitOpenExternalFiles(["/a.gp", "/b.mid"]);
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(2));
    expect(onOpen).toHaveBeenNthCalledWith(1, "/a.gp");
    expect(onOpen).toHaveBeenNthCalledWith(2, "/b.mid");

    await emitOpenExternalFiles(["/c.gp"]);
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(3));
  });

  it("stops listening on unmount", async () => {
    mockTauri();
    const onOpen = vi.fn();
    const { unmount } = renderHook(() => useExternalOpen(onOpen));
    await waitFor(() => expect(backend.pendingOpen).toEqual([]));

    unmount();
    await emitOpenExternalFiles(["/a.gp"]);

    expect(onOpen).not.toHaveBeenCalled();
  });
});
