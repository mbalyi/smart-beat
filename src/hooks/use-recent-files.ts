import { useEffect, useEffectEvent, useState } from "react";

import { loadRecentFiles, onOpenRecent, onRecentChanged } from "@/lib/tauri";

/** How many songs File › Open Recent remembers (mirrors `MAX_RECENT` in `src-tauri/src/recent.rs`). */
export const MAX_RECENT = 10;

/**
 * The recently opened songs (desktop app only), kept in step with the native
 * menu, plus File › Open Recent clicks, which call `onOpen` with the path.
 */
export function useRecentFiles(onOpen: (path: string) => void, version = 0) {
  const [paths, setPaths] = useState<string[]>([]);
  const openPath = useEffectEvent(onOpen);

  // Loaded at the start, and again whenever `version` changes (a song was opened or forgotten).
  useEffect(() => {
    let cancelled = false;
    loadRecentFiles().then(
      (list) => {
        if (!cancelled) setPaths(list);
      },
      (error: unknown) => console.warn("Could not load the recent files", error),
    );
    return () => {
      cancelled = true;
    };
  }, [version]);

  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    const keep = (stop: () => void) => (disposed ? stop() : stops.push(stop));
    onOpenRecent((path) => openPath(path)).then(keep, console.error);
    onRecentChanged(setPaths).then(keep, console.error);
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
    };
  }, []);

  return paths;
}
