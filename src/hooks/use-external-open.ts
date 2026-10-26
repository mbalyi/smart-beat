import { useEffect, useEffectEvent } from "react";

import { onOpenExternalFiles } from "@/lib/tauri";

/**
 * Opens the songs the system hands to the desktop app (double-click, "Open With", a second
 * launch). Songs that arrived while the page was loading are opened as soon as this mounts.
 */
export function useExternalOpen(onOpen: (path: string) => void) {
  const openPath = useEffectEvent(onOpen);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    onOpenExternalFiles((paths) => paths.forEach((path) => openPath(path))).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    }, console.error);
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
}
