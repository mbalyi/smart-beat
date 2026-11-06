import { useEffect, useEffectEvent } from "react";

import { onStemBundleOpened } from "@/lib/tauri";

/**
 * Opens the saved stems (`.sbstems`) the system hands to the desktop app (double-click in
 * Finder or Explorer, "Open With"): `onOpen` gets the file's path.
 */
export function useStemBundleOpened(onOpen: (path: string) => void, enabled = true) {
  const open = useEffectEvent(onOpen);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    onStemBundleOpened((path) => open(path)).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    }, console.error);
    return () => {
      disposed = true;
      stop?.();
    };
  }, [enabled]);
}
