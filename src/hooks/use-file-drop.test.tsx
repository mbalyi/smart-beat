import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";

import { useFileDrop } from "@/hooks/use-file-drop";
import { emitFileDrag, mockTauri } from "@/test/tauri";

/** jsdom has no DataTransfer: fake the parts the hook reads. */
function dragEvent(type: string, files: File[] = [], types = ["Files"]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types, files, dropEffect: "none" },
  });
  return event;
}

function setup() {
  const onDropPaths = vi.fn();
  const onDropFiles = vi.fn();
  const hook = renderHook(() => useFileDrop({ onDropPaths, onDropFiles }));
  return { ...hook, onDropPaths, onDropFiles };
}

describe("useFileDrop in the desktop app", () => {
  it("shows the drop target while dragging and reports dropped paths", async () => {
    mockTauri();
    const { result, onDropPaths } = setup();

    await waitFor(async () => {
      await act(() => emitFileDrag({ type: "enter", paths: ["/a.gp5"] }));
      expect(result.current).toBe(true);
    });
    await act(() => emitFileDrag({ type: "leave" }));
    expect(result.current).toBe(false);

    await act(() => emitFileDrag({ type: "drop", paths: ["/a.gp5"] }));
    expect(onDropPaths).toHaveBeenCalledWith(["/a.gp5"]);
    expect(result.current).toBe(false);
  });

  it("stops listening on unmount", async () => {
    mockTauri();
    const { result, unmount, onDropPaths } = setup();
    await waitFor(async () => {
      await act(() => emitFileDrag({ type: "enter", paths: [] }));
      expect(result.current).toBe(true);
    });

    unmount();
    await emitFileDrag({ type: "drop", paths: ["/a.gp5"] });

    expect(onDropPaths).not.toHaveBeenCalled();
  });
});

describe("useFileDrop in a browser", () => {
  it("accepts dropped files and prevents the browser from opening them", () => {
    const { result, onDropFiles } = setup();
    const file = new File(["x"], "song.gp5");

    act(() => {
      window.dispatchEvent(dragEvent("dragenter"));
      window.dispatchEvent(dragEvent("dragenter")); // entering a child element
    });
    expect(result.current).toBe(true);

    const over = dragEvent("dragover");
    act(() => {
      window.dispatchEvent(over);
      window.dispatchEvent(dragEvent("dragleave"));
    });
    expect(over.defaultPrevented).toBe(true);
    expect(result.current).toBe(true); // still over the window

    const drop = dragEvent("drop", [file]);
    act(() => {
      window.dispatchEvent(drop);
    });
    expect(drop.defaultPrevented).toBe(true);
    expect(onDropFiles).toHaveBeenCalledWith([file]);
    expect(result.current).toBe(false);
  });

  it("hides the drop target when the drag leaves the window", () => {
    const { result } = setup();

    act(() => {
      window.dispatchEvent(dragEvent("dragenter"));
      window.dispatchEvent(dragEvent("dragleave"));
    });

    expect(result.current).toBe(false);
  });

  it("ignores drags that carry no files (e.g. selected text)", () => {
    const { result, onDropFiles } = setup();

    act(() => {
      window.dispatchEvent(dragEvent("dragenter", [], ["text/plain"]));
    });
    const drop = dragEvent("drop", [], ["text/plain"]);
    act(() => {
      window.dispatchEvent(drop);
    });

    expect(result.current).toBe(false);
    expect(drop.defaultPrevented).toBe(false);
    expect(onDropFiles).not.toHaveBeenCalled();
  });

  it("stops listening on unmount", () => {
    const { unmount, onDropFiles } = setup();
    unmount();

    fireEvent(window, dragEvent("drop", [new File(["x"], "a.gp")]));

    expect(onDropFiles).not.toHaveBeenCalled();
  });
});
