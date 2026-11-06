import { useState, type ReactNode } from "react";

import { ShareDialog } from "@/components/share-dialog";
import type { ShareTarget } from "@/lib/cloud-share";
import { ShareContext } from "@/providers/share-context";

/**
 * Hosts the one share dialog of the app, so any file row can offer a share icon without its own
 * dialog. The dialog is mounted only while sharing, so every share starts from the beginning.
 */
export function ShareProvider({
  children,
  onSetUpCloud,
}: {
  children: ReactNode;
  /** Opens Settings on the cloud accounts, for a person who has none connected. */
  onSetUpCloud?: () => void;
}) {
  const [target, setTarget] = useState<ShareTarget | null>(null);
  return (
    <ShareContext.Provider value={setTarget}>
      {children}
      {target && (
        <ShareDialog
          target={target}
          onClose={() => setTarget(null)}
          onSetUpCloud={
            onSetUpCloud
              ? () => {
                  setTarget(null);
                  onSetUpCloud();
                }
              : undefined
          }
        />
      )}
    </ShareContext.Provider>
  );
}
