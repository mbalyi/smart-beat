import { useEffect, useEffectEvent, useState } from "react";

import { isTauri, onFileDrag } from "@/lib/tauri";

const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;

/**
 * Handles files dropped anywhere on the window. The desktop app receives
 * paths from the OS; a browser receives `File`s through HTML5 drag and drop.
 * Returns whether files are being dragged over the window.
 */
export function useFileDrop({
  onDropPaths,
  onDropFiles,
}: {
  onDropPaths: (paths: string[]) => void;
  onDropFiles: (files: File[]) => void;
}): boolean {
  const [dragging, setDragging] = useState(false);
  const dropPaths = useEffectEvent(onDropPaths);
  const dropFiles = useEffectEvent(onDropFiles);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    onFileDrag((event) => {
      setDragging(event.type === "enter");
      if (event.type === "drop" && event.paths.length > 0) dropPaths(event.paths);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error: unknown) => console.error("Could not subscribe to file drops", error));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (isTauri()) return;
    // dragenter/dragleave fire for every child element: count them.
    let depth = 0;
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const onOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault(); // allow dropping
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault(); // don't let the browser navigate to the file
      depth = 0;
      setDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) dropFiles(files);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  return dragging;
}
