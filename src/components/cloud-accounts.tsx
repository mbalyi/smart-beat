import { CloudProviderLogo } from "@/components/cloud-provider-logos";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  cancelCloudConnect,
  connectCloudAccount,
  disconnectCloudAccount,
  listCloudAccounts,
  listPendingUploads,
  type CloudAccount,
  type CloudProvider,
  type PendingUpload,
} from "@/lib/cloud";
import { errorText } from "@/lib/errors";
import { isCommandError, isTauri } from "@/lib/tauri";

/** The app gives up waiting for the browser sign-in after this long, a little after the backend. */
export const CONNECT_GIVE_UP_MS = 6 * 60 * 1000;

/** The person pressed Cancel: not an error to show. */
class ConnectCancelled extends Error {}

interface ProviderProblem {
  message: string;
  /** The sign-in ran out: offer Reconnect instead of Connect. */
  expired: boolean;
}

/**
 * Cloud accounts the app can save songs to (#187). Account names stay on this computer: nothing
 * here is reported to usage statistics. Hidden outside the desktop app.
 */
export function CloudAccounts() {
  const headingId = useId();
  const [accounts, setAccounts] = useState<CloudAccount[] | null>(null);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<CloudProvider | null>(null);
  const [problems, setProblems] = useState<Partial<Record<CloudProvider, ProviderProblem>>>({});

  const cancelWaiting = useRef<(() => void) | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextAccounts, nextPending] = await Promise.all([
        listCloudAccounts(),
        listPendingUploads(),
      ]);
      setAccounts(nextAccounts);
      setPending(nextPending);
      setLoadError(null);
    } catch (e) {
      setLoadError(`Cloud accounts are unavailable. ${errorText(e)}`);
    }
  }, []);

  useEffect(() => {
    if (isTauri()) void refresh();
  }, [refresh]);

  if (!isTauri()) return null;

  const run = async (provider: CloudProvider, action: () => Promise<unknown>, failure: string) => {
    setBusy(provider);
    setProblems((p) => ({ ...p, [provider]: undefined }));
    try {
      await action();
    } catch (e) {
      if (e instanceof ConnectCancelled) return;
      const expired = isCommandError(e) && e.kind === "auth-expired";
      setProblems((p) => ({
        ...p,
        [provider]: {
          expired,
          message: expired
            ? "Your sign-in has expired. Connect again to keep saving to the cloud."
            : `${failure} ${errorText(e)}`,
        },
      }));
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  // The wait ends when the backend answers, when Cancel is pressed or after CONNECT_GIVE_UP_MS,
  // so the button can never stay on "Waiting for the browser…".
  const connect = (provider: CloudProvider) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_, reject) => {
      cancelWaiting.current = () => reject(new ConnectCancelled());
      timer = setTimeout(
        () => reject(new Error("The browser sign-in took too long. Try again.")),
        CONNECT_GIVE_UP_MS,
      );
    });
    return run(
      provider,
      () => Promise.race([connectCloudAccount(provider), guard]),
      "The account could not be connected.",
    ).finally(() => {
      clearTimeout(timer);
      cancelWaiting.current = null;
    });
  };
  const cancelConnect = () => {
    cancelWaiting.current?.();
    void cancelCloudConnect().catch(() => undefined);
  };
  const disconnect = (provider: CloudProvider) =>
    run(provider, () => disconnectCloudAccount(provider), "The account could not be disconnected.");

  return (
    <div className="flex flex-col gap-2" role="group" aria-labelledby={headingId}>
      <h4 id={headingId} className="text-sm font-medium">
        Accounts
      </h4>
      <p className="text-sm text-muted-foreground">
        Sign in to save songs straight to your cloud storage. Smart Beat opens your browser to sign
        in and never sees your password.
      </p>
      {loadError && (
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {(accounts ?? []).map((item) => {
          const problem = problems[item.provider];
          const connecting = busy === item.provider;
          const otherBusy = busy !== null && !connecting;
          return (
            <li
              key={item.provider}
              className="flex flex-col gap-1 rounded-xl border bg-background/60 px-3 py-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <CloudProviderLogo
                    provider={item.provider}
                    className={cn("h-5 w-auto max-w-7 shrink-0", !item.configured && "opacity-50")}
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{item.label}</p>
                    <p className="text-xs break-all text-muted-foreground">
                      {item.account ?? (item.configured ? "Not connected" : "")}
                    </p>
                  </div>
                </div>
                {!item.configured ? (
                  <Button type="button" variant="outline" size="sm" disabled>
                    Not available in this build
                  </Button>
                ) : item.account ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    aria-label={`Disconnect ${item.label}`}
                    onClick={() => void disconnect(item.provider)}
                  >
                    Disconnect
                  </Button>
                ) : (
                  <div className="flex items-center gap-2">
                    {connecting && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Cancel connecting ${item.label}`}
                        onClick={cancelConnect}
                      >
                        Cancel
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={connecting || otherBusy}
                      aria-label={
                        connecting
                          ? undefined
                          : `${problem?.expired ? "Reconnect" : "Connect"} ${item.label}`
                      }
                      onClick={() => void connect(item.provider)}
                    >
                      {connecting
                        ? "Waiting for the browser…"
                        : problem?.expired
                          ? "Reconnect"
                          : "Connect"}
                    </Button>
                  </div>
                )}
              </div>
              {problem && (
                <p role="alert" className="text-sm text-destructive">
                  {problem.message}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {pending.length > 0 && (
        <p className="text-sm text-muted-foreground" data-testid="cloud-pending">
          {pending.length === 1
            ? "1 song is waiting to upload."
            : `${pending.length} songs are waiting to upload.`}{" "}
          They upload on their own when you are back online.
        </p>
      )}
    </div>
  );
}
