import { useEffect, useState } from "react";

import { onCloudChange } from "@/lib/cloud-changes";

/** A number that goes up after every change to the cloud accounts or folder: an effect's key to read again. */
export function useCloudChanges(): number {
  const [changes, setChanges] = useState(0);
  useEffect(() => onCloudChange(() => setChanges((n) => n + 1)), []);
  return changes;
}
