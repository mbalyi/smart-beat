import { useEffect, useEffectEvent } from "react";
import { toast } from "sonner";

import { getUsageSettings, setUsageSettings, track } from "@/lib/telemetry";

/** Wait a moment after startup so the notice doesn't compete with the first screen. */
export const NOTICE_DELAY_MS = 4000;

/**
 * Counts the app start and, once, tells the user that anonymous usage counters exist and where
 * to switch them off. Only builds that can send counters show it.
 */
export function useUsageNotice(openSettings: () => void) {
  const open = useEffectEvent(openSettings);

  useEffect(() => {
    track("app_start");
    const timer = setTimeout(() => {
      void (async () => {
        const settings = await getUsageSettings().catch(() => null);
        if (!settings?.available || settings.noticeSeen) return;
        toast("Smart Beat counts which features are used", {
          description:
            "Anonymous counts only: no identifier, nothing about your songs. You can switch it off in Settings.",
          duration: 20_000,
          action: { label: "Settings", onClick: open },
        });
        await setUsageSettings({ noticeSeen: true }).catch(() => {});
      })();
    }, NOTICE_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
}
