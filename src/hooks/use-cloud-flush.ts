import { useEffect } from "react";
import { toast } from "sonner";

import { flushCloudUploads } from "@/lib/cloud";
import { isTauri } from "@/lib/tauri";

let running = false;

/** Tries the saves that were kept offline and tells the user what happened to each. */
export async function flushAndNotify() {
  if (running || !isTauri()) return;
  running = true;
  try {
    for (const { name, outcome } of await flushCloudUploads()) {
      if (outcome === "uploaded") toast.success(`“${name}” uploaded`);
      else if (outcome === "conflict") {
        toast.warning(`“${name}” changed online`, {
          description:
            "Your offline save was not uploaded because a newer version exists. Open the song and save a copy to keep both.",
          duration: 12_000,
        });
      }
    }
  } catch (error) {
    console.warn("Could not upload the offline saves", error);
  } finally {
    running = false;
  }
}

/** Uploads waiting offline saves at the app start and whenever the window gets focus (#187). */
export function useCloudFlush() {
  useEffect(() => {
    void flushAndNotify();
    const onFocus = () => void flushAndNotify();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
}
