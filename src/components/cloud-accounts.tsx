import { useCallback, useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
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

  const connect = (provider: CloudProvider) =>
    run(provider, () => connectCloudAccount(provider), "The account could not be connected.");
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
              className="flex flex-col gap-1 rounded-xl border bg-card px-3 py-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{item.label}</p>
                  <p className="text-xs break-all text-muted-foreground">
                    {item.account ?? (item.configured ? "Not connected" : "")}
                  </p>
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
