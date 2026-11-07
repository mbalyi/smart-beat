import { CloudOffIcon, CloudIcon, FileMusicIcon, LayersIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { DIALOG_NEON } from "@/components/ai/dialog-art";
import { CloudProviderLogo } from "@/components/cloud-provider-logos";
import { ShareButton } from "@/components/share-button";
import { TargetArt } from "@/components/target-cards";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { listCloudAccounts, type CloudAccount, type CloudProvider } from "@/lib/cloud";
import { cloudErrorText, listCloudItems, rememberCloudName } from "@/lib/cloud-items";
import { errorText } from "@/lib/errors";
import { listCloudStemFiles } from "@/lib/tauri";

/** One file of the library: a tab or a saved stems file. */
type Entry = {
  item: string;
  name: string;
  kind: "tab" | "stems";
  size: number;
  modifiedMs: number;
};

type Section =
  | { status: "loading" }
  | { status: "ready"; entries: Entry[] }
  | { status: "error"; message: string };

/** "48 KB" or "12 MB": a tab is often well under a megabyte. */
function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

const stemTitle = (name: string) => name.replace(/\.sbstems$/i, "");

/** The tabs and stems of one connected drive, newest first. */
async function loadEntries(provider: CloudProvider): Promise<Entry[]> {
  const [tabs, stems] = await Promise.all([listCloudItems(provider), listCloudStemFiles(provider)]);
  return [
    ...tabs.map((t): Entry => ({
      item: t.id,
      name: t.name,
      kind: "tab",
      size: t.size,
      modifiedMs: t.modified_ms,
    })),
    ...stems.map((s): Entry => ({
      item: s.id,
      name: s.name,
      kind: "stems",
      size: s.size,
      modifiedMs: s.modified_ms,
    })),
  ].sort((a, b) => b.modifiedMs - a.modifiedMs || a.name.localeCompare(b.name));
}

/**
 * Everything Smart Beat keeps in the connected online drives (#201), grouped by drive: tabs and
 * saved stems, each with a share icon. Only files Smart Beat saved are listed: the drives are
 * connected with access to the app's own files, not to the rest of the drive.
 */
export function CloudLibraryDialog({
  open,
  onOpenChange,
  onSetUpCloud,
  onOpenTab,
  onOpenStems,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSetUpCloud: () => void;
  onOpenTab: (item: string) => void;
  onOpenStems: (item: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <LibraryContent
          onClose={() => onOpenChange(false)}
          onSetUpCloud={onSetUpCloud}
          onOpenTab={onOpenTab}
          onOpenStems={onOpenStems}
        />
      )}
    </Dialog>
  );
}

function LibraryContent({
  onClose,
  onSetUpCloud,
  onOpenTab,
  onOpenStems,
}: {
  onClose: () => void;
  onSetUpCloud: () => void;
  onOpenTab: (item: string) => void;
  onOpenStems: (item: string) => void;
}) {
  const [accounts, setAccounts] = useState<CloudAccount[] | null>(null);
  const [sections, setSections] = useState<Partial<Record<CloudProvider, Section>>>({});

  const load = useCallback(async (provider: CloudProvider) => {
    setSections((s) => ({ ...s, [provider]: { status: "loading" } }));
    try {
      const entries = await loadEntries(provider);
      setSections((s) => ({ ...s, [provider]: { status: "ready", entries } }));
    } catch (error) {
      setSections((s) => ({
        ...s,
        [provider]: {
          status: "error",
          message: cloudErrorText(error, provider) ?? errorText(error),
        },
      }));
    }
  }, []);

  useEffect(() => {
    let active = true;
    listCloudAccounts()
      .then((found) => {
        if (!active) return;
        setAccounts(found);
        for (const a of found) if (a.configured && a.account) void load(a.provider);
      })
      .catch(() => active && setAccounts([]));
    return () => {
      active = false;
    };
  }, [load]);

  return (
    <DialogContent
      size="xl"
      data-testid="cloud-library"
      className={`${DIALOG_NEON} h-[min(46rem,calc(100dvh-2rem))] sm:max-w-3xl`}
    >
      <div className="relative isolate flex min-h-0 flex-1 flex-col">
        <TargetArt />
        <DialogHeader className="px-6 pt-2 pr-14 md:px-9">
          <DialogTitle className="text-2xl font-bold">Cloud library</DialogTitle>
          <DialogDescription className="text-sm sm:text-base">
            The tabs and stems Smart Beat keeps in your online drives, one list for each drive.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="gap-4 px-6 md:px-9">
          {accounts === null ? (
            <p role="status" className="text-sm text-muted-foreground">
              Looking for your accounts…
            </p>
          ) : (
            accounts.map((account) => (
              <ProviderSection
                key={account.provider}
                account={account}
                section={sections[account.provider]}
                onRetry={() => void load(account.provider)}
                onSetUpCloud={onSetUpCloud}
                onOpen={(entry) => {
                  if (entry.kind === "stems") onOpenStems(entry.item);
                  else {
                    rememberCloudName(entry.item, entry.name);
                    onOpenTab(entry.item);
                  }
                }}
              />
            ))
          )}
          <p className="text-sm text-muted-foreground">
            Only files Smart Beat saved are listed. Files you put in your drive yourself don&apos;t
            show up here.
          </p>
        </DialogBody>
        <DialogFooter className="mt-0 flex-row items-center justify-start border-t-0 bg-transparent px-6 pt-2 pb-5 md:px-9">
          <Button variant="outline" size="lg" className="min-w-28 bg-card" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </div>
    </DialogContent>
  );
}

function ProviderSection({
  account,
  section,
  onRetry,
  onSetUpCloud,
  onOpen,
}: {
  account: CloudAccount;
  section: Section | undefined;
  onRetry: () => void;
  onSetUpCloud: () => void;
  onOpen: (entry: Entry) => void;
}) {
  const headingId = `library-${account.provider}`;
  const connected = account.configured && !!account.account;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-2xl border border-border bg-card/85 p-4"
      data-testid={`library-${account.provider}`}
    >
      <h3 id={headingId} className="flex items-center gap-2 text-lg font-bold">
        <CloudProviderLogo provider={account.provider} className="h-6 w-auto max-w-8 shrink-0" />
        {account.label}
        {connected && (
          <span className="truncate text-sm font-normal text-muted-foreground">
            {account.account}
          </span>
        )}
      </h3>
      {!connected ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CloudOffIcon className="size-4 shrink-0" aria-hidden="true" />
            {account.configured ? "Not connected" : "Not available in this build"}
          </p>
          {account.configured && (
            <Button
              variant="outline"
              size="sm"
              className="bg-card"
              onClick={onSetUpCloud}
              aria-label={`Connect ${account.label}`}
            >
              <CloudIcon aria-hidden="true" />
              Connect
            </Button>
          )}
        </div>
      ) : !section || section.status === "loading" ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading…
        </p>
      ) : section.status === "error" ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="alert" className="text-sm">
            {section.message}
          </p>
          <Button variant="outline" size="sm" className="bg-card" onClick={onRetry}>
            <RefreshCwIcon aria-hidden="true" />
            Try again
          </Button>
        </div>
      ) : section.entries.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="library-empty">
          Nothing here yet. Save a tab or stems to {account.label}, or share one from this computer,
          and it shows up here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {section.entries.map((entry) => (
            <li
              key={entry.item}
              className="flex min-w-0 items-center gap-2 rounded-xl border border-border bg-background/60 py-1 pr-1 pl-3"
              data-testid="library-entry"
            >
              {entry.kind === "stems" ? (
                <LayersIcon className="size-5 shrink-0 text-brand" aria-hidden="true" />
              ) : (
                <FileMusicIcon className="size-5 shrink-0 text-brand-yellow" aria-hidden="true" />
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-semibold">
                    {entry.kind === "stems" ? stemTitle(entry.name) : entry.name}
                  </span>
                  <Badge variant="outline" className="shrink-0">
                    {entry.kind === "stems" ? "Stems" : "Tab"}
                  </Badge>
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {formatSize(entry.size)}
                  {entry.modifiedMs > 0 &&
                    ` · ${new Date(entry.modifiedMs).toLocaleDateString(undefined, { dateStyle: "medium" })}`}
                </span>
              </span>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 bg-card"
                aria-label={`Open ${entry.name}`}
                onClick={() => onOpen(entry)}
              >
                Open
              </Button>
              <ShareButton target={{ kind: "cloud", item: entry.item, name: entry.name }} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
