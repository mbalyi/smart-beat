import { useEffect, useState } from "react";

import { getCloudFolder } from "@/lib/tauri";

/**
 * The linked cloud folder (#187), read once: `null` while it is loading, when none is linked
 * and in a browser. Nothing is read while `enabled` is false.
 */
export function useCloudFolder(enabled = true): string | null {
  const [folder, setFolder] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    getCloudFolder().then(
      (found) => alive && setFolder(found),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [enabled]);
  return enabled ? folder : null;
}
