import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";

import { errorText } from "@/lib/errors";
import { getCloudFolder, isTauri, listCloudStems, type CloudStem } from "@/lib/tauri";

/** What the list of the cloud folder's saved stems is doing. */
export type CloudStemList =
  | { status: "loading" }
  | { status: "ready"; files: CloudStem[] }
  | { status: "error"; message: string };

/**
 * The `.sbstems` files in the linked cloud folder, newest first, and the files being fetched
 * right now (the core tells us while it waits for the drive app). `refresh` reads the folder
 * again. Nothing is listed outside the desktop app or without a linked folder.
 */
export function useCloudStemList(): {
  list: CloudStemList;
  downloading: ReadonlySet<string>;
  refresh: () => void;
} {
  const [list, setList] = useState<CloudStemList>(() =>
    isTauri() ? { status: "loading" } : { status: "ready", files: [] },
  );
  const [downloading, setDownloading] = useState<ReadonlySet<string>>(new Set());
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    (async () => {
      try {
        if (!(await getCloudFolder())) {
          if (active) setList({ status: "ready", files: [] });
          return;
        }
        const files = await listCloudStems();
        if (active) setList({ status: "ready", files });
      } catch (error) {
        if (active) setList({ status: "error", message: errorText(error) });
      }
    })();
    return () => {
      active = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<string>("cloud-download-waiting", (event) =>
      setDownloading((set) => new Set(set).add(event.payload)),
    );
    return () => {
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const refresh = useCallback(() => {
    setList({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return { list, downloading, refresh };
}
