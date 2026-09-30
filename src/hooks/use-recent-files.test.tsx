import { act, renderHook, waitFor } from "@testing-library/react";

import { useRecentFiles } from "@/hooks/use-recent-files";
import { emitOpenRecent, mockTauri, backend } from "@/test/tauri";

describe("useRecentFiles", () => {
  it("loads the list, and again when the version changes", async () => {
    mockTauri();
    backend.recent = ["/a.gp5", "/b.gp5"];
    const { result, rerender } = renderHook(({ version }) => useRecentFiles(() => {}, version), {
      initialProps: { version: 0 },
    });
    await waitFor(() => expect(result.current).toEqual(["/a.gp5", "/b.gp5"]));

    backend.recent = ["/c.gp5"];
    rerender({ version: 1 });
    await waitFor(() => expect(result.current).toEqual(["/c.gp5"]));
  });

  it("is empty in a browser", async () => {
    const { result } = renderHook(() => useRecentFiles(() => {}));
    await act(async () => {});
    expect(result.current).toEqual([]);
  });

  it("calls back with the path of File › Open Recent, and follows Clear Menu", async () => {
    mockTauri();
    backend.recent = ["/a.gp5"];
    const onOpen = vi.fn();
    const { result, unmount } = renderHook(() => useRecentFiles(onOpen));
    await waitFor(() => expect(result.current).toEqual(["/a.gp5"]));

    await act(() => emitOpenRecent("/a.gp5"));
    expect(onOpen).toHaveBeenCalledWith("/a.gp5");

    const { emit } = await import("@tauri-apps/api/event");
    await act(() => emit("recent-changed", []));
    expect(result.current).toEqual([]);

    unmount();
    await emitOpenRecent("/b.gp5");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("survives a list that cannot be loaded", async () => {
    mockTauri({
      load_recent_files: () => {
        throw { kind: "io", message: "disk error" };
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useRecentFiles(() => {}));
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });
});
