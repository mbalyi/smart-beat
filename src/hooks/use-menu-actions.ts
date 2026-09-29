import { useEffect, useEffectEvent } from "react";

import { onMenuAction, type MenuAction } from "@/lib/tauri";

/** Calls `handler` whenever a native menu item forwards an action to the UI. */
export function useMenuActions(handler: (action: MenuAction) => void): void {
  const onAction = useEffectEvent(handler);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    onMenuAction((action) => onAction(action))
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error: unknown) => console.error("Could not subscribe to menu actions", error));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
