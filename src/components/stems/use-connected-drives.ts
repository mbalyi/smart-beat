import { useEffect, useState } from "react";

import { useCloudChanges } from "@/hooks/use-cloud-changes";
import { listCloudAccounts, type CloudProvider } from "@/lib/cloud";
import { isTauri } from "@/lib/tauri";

/** A cloud account the stems can go to or come from. */
export interface ConnectedDrive {
  provider: CloudProvider;
  /** "Google Drive". */
  label: string;
  /** The signed-in account's name. */
  account: string;
}

/**
 * The cloud accounts that are connected and usable in this build (#186): `undefined` while they
 * are being read, an empty list when there are none (and in a browser). It reads them again when
 * Settings connects or disconnects one while the dialog is open.
 */
export function useConnectedDrives(): ConnectedDrive[] | undefined {
  const [drives, setDrives] = useState<ConnectedDrive[] | undefined>(isTauri() ? undefined : []);
  const changes = useCloudChanges();
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    listCloudAccounts().then(
      (accounts) =>
        alive &&
        setDrives(
          accounts.flatMap((a) =>
            a.configured && a.account
              ? [{ provider: a.provider, label: a.label, account: a.account }]
              : [],
          ),
        ),
      () => alive && setDrives([]),
    );
    return () => {
      alive = false;
    };
  }, [changes]);
  return drives;
}
