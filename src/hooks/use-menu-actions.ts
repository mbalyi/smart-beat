import { useEffect, useEffectEvent } from "react";

import { onMenuAction, type MenuAction } from "@/lib/tauri";

const local = new Set<(action: MenuAction) => void>();

/** Sends `action` to the UI as if its menu item was chosen (the shown song's workspace handles it). */
export function dispatchMenuAction(action: MenuAction): void {
  for (const handler of [...local]) handler(action);
}

/** Calls `handler` whenever a native menu item forwards an action to the UI. */
export function useMenuActions(handler: (action: MenuAction) => void): void {
  const onAction = useEffectEvent(handler);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const forward = (action: MenuAction) => onAction(action);
    local.add(forward);

    onMenuAction((action) => onAction(action))
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error: unknown) => console.error("Could not subscribe to menu actions", error));

    return () => {
      disposed = true;
      local.delete(forward);
      unlisten?.();
    };
  }, []);
}
